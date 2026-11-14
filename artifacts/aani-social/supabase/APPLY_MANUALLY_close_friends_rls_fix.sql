-- =====================================================================
-- إصلاح RLS لجدول public.close_friends — ملف تطبيق يدوي فقط
-- =====================================================================
-- لا يُرحَّل تلقائياً ولا ينفّذه الوكيل: يُنسخ ويُلصق في Supabase
-- SQL Editor بعد المراجعة، ثم يُنفَّذ يدوياً مرة واحدة.
--
-- المشكلة:
--   جدول public.close_friends عليه RLS مفعّل لكن بلا أي سياسة (policies)،
--   فيرفض PostgREST كل INSERT و DELETE، ويظهر للمستخدم:
--     "تعذر حفظ قائمة الأصدقاء المقربين" أو
--     "تعذر تحديث بعض الأصدقاء المقربين".
--   وسبب غياب السياسات أن أحد الترحيلات القديمة أنشأ سياسة الإضافة بشرط
--   public.aani_is_mutual_follow(user_id, friend_id) والدالة غير موجودة في
--   قاعدة الإنتاج، ففشل إنشاء السياسات.
--
-- المبادئ المتبعة في هذا الملف (مطابقة للبنية المعتمدة في الترحيلات):
--   1) لا تغيير في بنية قاعدة البيانات: لا CREATE TABLE ولا CREATE INDEX
--      ولا ALTER COLUMN. الجدول والعمودان user_id/friend_id والمفتاح
--      الأساسي (user_id, friend_id) تبقى كما هي.
--   2) دالة public.aani_is_mutual_follow تبقى SECURITY INVOKER (وليست
--      DEFINER) — تعمل تحت RLS الخاصة بالمستخدم المستدعي، وسياسة القراءة
--      على public.follows تسمح للمستخدم المصادق بقراءتها، فلا حاجة لتعريف
--      متجاوز للصلاحيات.
--   3) سياسات RLS الأربع المعتمدة تبقى كما هي ولا تُحذف ولا تُستبدل ولا
--      تُوضعف، وتُنشأ فقط إن كانت غائبة (لا DROP POLICY إطلاقاً):
--        - aani_close_friends_select_own     (SELECT)
--        - aani_close_friends_insert_mutual  (INSERT)
--        - aani_close_friends_delete_own     (DELETE)
--        - aani_close_friends_block_guard    (INSERT — RESTRICTIVE)
--      لا سياسة UPDATE: العميل يستخدم insert ... on conflict do nothing
--      (upsert مع ignoreDuplicates) ولا يحتاجها.
--   4) لا تُنشأ سياسات مكررة: كل سياسة تُنشأ مرة واحدة فقط عند غيابها.
--
-- آمن لإعادة التشغيل: كل الخطوات create or replace / if not exists /
-- if not exists (select … from pg_policies).
-- =====================================================================

begin;

-- =====================================================================
-- 1) فحوص مسبقة — قراءة فقط، بلا أي تعديل
--    إن غاب الجدول أو دالة الحظر يتوقف الملف برسالة واضحة بدل إنشاء
--    سياسات لا تعمل.
-- =====================================================================

do $$
begin
  if to_regclass('public.close_friends') is null then
    raise exception 'public.close_friends غير موجود — راجع الترحيلات قبل تنفيذ هذا الملف';
  end if;

  if to_regprocedure('public.aani_is_user_blocked(uuid, uuid)') is null then
    raise exception 'public.aani_is_user_blocked(uuid, uuid) غير موجود — نفّذ ملف إصلاحه أولاً (APPLY_MANUALLY_story_views_likes.sql)';
  end if;
end $$;

-- =====================================================================
-- 2) دالة المتابعة المتبادلة — SECURITY INVOKER
--    نفس تعريفها المعتمد في الترحيلات، مع إبقاء صلاحية المستدعي بدل
--    SECURITY DEFINER.
-- =====================================================================

create or replace function public.aani_is_mutual_follow(p_user_id uuid, p_friend_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.follows as outgoing
    join public.follows as incoming
      on incoming.follower_id = outgoing.following_id
     and incoming.following_id = outgoing.follower_id
    where outgoing.follower_id = p_user_id
      and outgoing.following_id = p_friend_id
  );
$$;

revoke all on function public.aani_is_mutual_follow(uuid, uuid) from public;
grant execute on function public.aani_is_mutual_follow(uuid, uuid) to authenticated;

-- =====================================================================
-- 3) RLS والصلاحيات — RLS مفعّل أصلاً؛ الأمر التالي بلا أثر إن كان مفعّلاً
-- =====================================================================

alter table public.close_friends enable row level security;

grant select, insert, delete on public.close_friends to authenticated;

-- =====================================================================
-- 4) السياسات الأربع — تُنشأ فقط إن كانت غائبة (بلا DROP وبلا تكرار)
-- =====================================================================

do $$
begin
  -- (1) قراءة: صفوف المستخدم نفسه فقط (النافذة تقرأ friend_id بالمعرّف الحالي)
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'close_friends'
      and policyname = 'aani_close_friends_select_own'
  ) then
    execute $policy$
      create policy aani_close_friends_select_own on public.close_friends
        for select to authenticated
        using (user_id = (select auth.uid()))
    $policy$;
  end if;

  -- (2) إضافة: المستخدم يضيف نفسه هو فقط، لصديق متبادل المتابعة
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'close_friends'
      and policyname = 'aani_close_friends_insert_mutual'
  ) then
    execute $policy$
      create policy aani_close_friends_insert_mutual on public.close_friends
        for insert to authenticated
        with check (
          user_id = (select auth.uid())
          and friend_id <> (select auth.uid())
          and public.aani_is_mutual_follow(user_id, friend_id)
        )
    $policy$;
  end if;

  -- (3) حذف: صفوف المستخدم نفسه فقط
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'close_friends'
      and policyname = 'aani_close_friends_delete_own'
  ) then
    execute $policy$
      create policy aani_close_friends_delete_own on public.close_friends
        for delete to authenticated
        using (user_id = (select auth.uid()))
    $policy$;
  end if;

  -- (4) حارس الحظر (RESTRICTIVE): لا إضافة لصديق محظور في أي اتجاه.
  --     سياسة منفصلة كما في الترحيلات، وليست شرطاً مدمجاً في سياسة الإضافة.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'close_friends'
      and policyname = 'aani_close_friends_block_guard'
  ) then
    execute $policy$
      create policy aani_close_friends_block_guard on public.close_friends
        as restrictive for insert to authenticated
        with check (not public.aani_is_user_blocked(user_id, friend_id))
    $policy$;
  end if;
end $$;

-- =====================================================================
-- 5) تحديث كاش PostgREST فوراً
-- =====================================================================

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- للتحقق بعد التنفيذ (اختياري — يُنفَّذ منفصلاً بعد الـ commit):
--
--   select policyname, permissive, cmd, roles::text
--   from pg_policies
--   where schemaname = 'public' and tablename = 'close_friends'
--   order by policyname;
--
-- المتوقع أربع سياسات، بلا تكرار:
--   aani_close_friends_block_guard    | RESTRICTIVE | INSERT
--   aani_close_friends_delete_own     | PERMISSIVE  | DELETE
--   aani_close_friends_insert_mutual  | PERMISSIVE  | INSERT
--   aani_close_friends_select_own     | PERMISSIVE  | SELECT
--
-- وللتحقق من صلاحية الدالة (يجب أن تكون INVOKER):
--
--   select proname, prosecdef
--   from pg_proc
--   where proname = 'aani_is_mutual_follow';
--
-- prosecdef = false تعني SECURITY INVOKER.
-- =====================================================================
