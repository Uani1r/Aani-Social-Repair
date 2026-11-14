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
-- ما يفعله هذا الملف:
--   1) يتأكد من وجود الجدول بالبنية نفسها (user_id + friend_id + created_at
--      والمفتاح الأساسي (user_id, friend_id)) — لا يغيّر أي عمود قائم.
--   2) ينشئ دالة public.aani_is_mutual_follow(uuid, uuid) بنفس تعريفها
--      الأصلي في الترحيلات (تحتاجها سياسة الإضافة، وتحتاجها دوال رؤية
--      القصص أيضاً).
--   3) يتأكد من صلاحيات authenticated: select, insert, delete فقط.
--   4) ينشئ ثلاث سياسات: قراءة صفوف المستخدم نفسه، وإضافته لنفسه فقط
--      لصديق متبادل غير محظور، وحذف صفوفه.
--      لا سياسة UPDATE: العميل يستخدم insert ... on conflict do nothing
--      (upsert مع ignoreDuplicates) فلا يحتاجها.
--
-- آمن لإعادة التشغيل: كل الخطوات create or replace / if not exists /
-- drop policy if exists.
-- =====================================================================

begin;

-- =====================================================================
-- 1) الجدول — موجود في الإنتاج؛ الإنشاء هنا احتياط فقط ولا يغيّر بنيته
-- =====================================================================

create table if not exists public.close_friends (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint aani_close_friends_not_self check (user_id <> friend_id)
);

create index if not exists aani_close_friends_friend_idx
  on public.close_friends (friend_id, user_id);

-- =====================================================================
-- 2) دالة المتابعة المتبادلة — غائبة في الإنتاج (سبقت في الترحيلات)
-- =====================================================================

create or replace function public.aani_is_mutual_follow(p_user_id uuid, p_friend_id uuid)
returns boolean
language sql
stable
security definer
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
-- 3) RLS والصلاحيات
-- =====================================================================

alter table public.close_friends enable row level security;

grant select, insert, delete on public.close_friends to authenticated;

-- =====================================================================
-- 4) السياسات
-- =====================================================================

-- قراءة: صفوف المستخدم نفسه فقط (النافذة تقرأ friend_id بالمعرّف الحالي)
drop policy if exists aani_close_friends_select_own on public.close_friends;
create policy aani_close_friends_select_own on public.close_friends
  for select to authenticated
  using (user_id = (select auth.uid()));

-- إضافة: المستخدم يضيف نفسه هو فقط، لصديق متبادل المتابعة وغير محظور
drop policy if exists aani_close_friends_insert_mutual on public.close_friends;
create policy aani_close_friends_insert_mutual on public.close_friends
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and friend_id <> (select auth.uid())
    and public.aani_is_mutual_follow(user_id, friend_id)
    and not public.aani_is_user_blocked(user_id, friend_id)
  );

-- حذف: صفوف المستخدم نفسه فقط
drop policy if exists aani_close_friends_delete_own on public.close_friends;
create policy aani_close_friends_delete_own on public.close_friends
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- =====================================================================
-- 5) تحديث كاش PostgREST فوراً
-- =====================================================================

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- للتحقق بعد التنفيذ (اختياري — تنفيذه منفصلاً بعد الـ commit):
--
--   select policyname, cmd, roles::text
--   from pg_policies
--   where schemaname = 'public' and tablename = 'close_friends';
--
-- يجب أن تظهر ثلاث سياسات:
--   aani_close_friends_select_own   | SELECT
--   aani_close_friends_insert_mutual | INSERT
--   aani_close_friends_delete_own   | DELETE
-- =====================================================================
