-- ترحيل: سياسة قراءة موحّدة للمنشورات تحترم خصوصية الحساب والحجب.
--
-- المشكلة التي يعالجها هذا الترحيل (من مراجعة المصدر، بلا وصول للقاعدة الحيّة):
--   1) السياسة السارية على القراءة كانت
--        (user_id = auth.uid() or visibility = 'public')
--      (20261124000000 سطر 21-24، ونفسها في schema.sql) وهي لا تعرف شيئاً عن
--      profiles.is_private، فمنشورات الحساب الخاص ذات visibility = 'public'
--      كان يقرأها كل مستخدم مسجّل. خصوصية الحساب كانت مطبقة على القصص فقط.
--   2) الترحيل 20270103000000 كان ينشئ نفس اسم السياسة بـ using (true) إن
--      غابت، وهو تعريف يوسّع القراءة إلى كل صفوف posts.
--   3) سياسة anon "Public can read public posts" كانت
--        (visibility = 'public' or visibility is null)
--      بلا أي شرط خصوصية، فيقرأ الزائر بلا تسجيل منشورات الحساب الخاص العامة.
--   4) حارس الحجب aani_posts_block_guard (restrictive) أُنشئ في
--      20261115000000 ثم لم يُعَد إنشاؤه مع أي تغيير لاحق على سياسات posts.
--
-- قاعدة القراءة الجديدة (مصدر واحد للحقيقة):
--   * صاحب المنشور يقرأ منشوراته دائماً، بما فيها visibility = 'private'.
--   * visibility = 'private' لا يصبح مقروءاً أبداً بسبب متابعة الحساب.
--   * منشور غير خاص لصاحب حساب غير خاص: متاح لكل مستخدم مسجّل (وفق حارس الحجب).
--   * منشور غير خاص لصاحب حساب خاص: متاح لصاحب الحساب ولمتابعه المعتمد فقط.
--   * الزائر بلا تسجيل: منشورات غير خاصة لأصحاب حسابات غير خاصة فقط.
--
-- تعريف "المتابع المعتمد" في هذا المشروع:
--   صف في public.follows (follower_id = المشاهد, following_id = صاحب الحساب).
--   جدول follow_requests يعني «طلب قيد الانتظار» فقط، ويُحذف عند القبول
--   (FollowRequestsSection.tsx)، فلا يصلح دليلاً على القبول.
--
-- المتطلبات المسبقة (موجودة في الإنتاج، ويتم التحقق منها أدناه):
--   * public.profiles.is_private            (20261108000000)
--   * public.follows                        (schema.sql)
--   * public.aani_is_user_blocked(uuid,uuid) (20261115000000)
--
-- آمن للتكرار: كل سياسة تُحذف ثم تُنشأ، والدالة تُستبدل.
-- لا يعدّل جدولاً ولا بيانات ولا صلاحيات أعمدة ولا سلوك القصص.
--
-- لماذا لا تُعدَّل الترحيلات القديمة: الترحيلات السابقة طُبّقت على الإنتاج،
-- وتعديل ملف مطبَّق لا يغيّر القاعدة الحيّة ويكسر سجل الترحيلات. لذلك:
--   * 20270103000000 يظل كما هو، لكنه ينشئ سياسته فقط «إن غابت»، وهذا
--     الترحيل يُنشئ سياسة بنفس الاسم، فإعادة تشغيل القديم لا تُعيد using (true).
--   * schema.sql (يُعاد تشغيله كاملاً أحياناً) يحذف السياسة وينشئها بالشرط
--     القديم، لذا شغّل هذا الترحيل بعده إن أعدت تشغيل schema.sql.
begin;

-- ---------------------------------------------------------------------
-- 0) التحقق من المتطلبات المسبقة قبل أي تغيير (فشل صريح أفضل من تطبيق ناقص)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts غير موجود — لا يمكن تطبيق هذا الترحيل';
  end if;

  if to_regclass('public.follows') is null then
    raise exception 'public.follows غير موجود — لا يمكن تطبيق هذا الترحيل';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_private'
  ) then
    raise exception 'العمود profiles.is_private مفقود — طبّق 20261108000000 أولاً';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'posts'
      and column_name = 'visibility'
  ) then
    raise exception 'العمود posts.visibility مفقود — طبّق 20261124000000 أولاً';
  end if;

  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_is_user_blocked'
  ) then
    raise exception 'الدالة public.aani_is_user_blocked مفقودة — طبّق 20261115000000 أولاً';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) دالة مساعدة واحدة للقراءة
--    SECURITY DEFINER لأنها تحتاج profiles.is_private و follows بغض النظر عن
--    RLS الخاص بهما، ومحدودة الصلاحيات: تُعيد boolean فقط، ولا تُجيب إلا عن
--    المشاهد نفسه (p_viewer_id = auth.uid()) أو عن الزائر المجهول (auth.uid() is null).
--    search_path = '' مع تأهيل كامل للأسماء لمنع اختطاف الدوال.
--    لا تعاود الدالة نفسها إلى سياسة posts: مالك posts لا يخضع لـ RLS
--    (لا يوجد FORCE ROW LEVEL SECURITY في المشروع)، ومالك الدالة هو نفسه
--    مالك الجدول عند التطبيق عبر SQL Editor، فلا تعاود لا نهائياً.
-- ---------------------------------------------------------------------
create or replace function public.aani_can_read_post(
  p_post_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.posts as post
    join public.profiles as owner on owner.id = post.user_id
    where post.id = p_post_id
      and (
        -- (أ) صاحب المنشور: يقرأ كل منشوراته، بما فيها visibility = 'private'
        (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and post.user_id = p_viewer_id
        )
        -- (ب) مستخدم مسجّل: منشور غير خاص، إمّا لصاحب حساب غير خاص،
        --     أو لصاحب حساب خاص بشرط متابعة معتمدة (صف في follows).
        or (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and coalesce(post.visibility, 'public') <> 'private'
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = post.user_id
            )
          )
        )
        -- (ج) زائر بلا تسجيل دخول: منشور غير خاص لصاحب حساب غير خاص فقط.
        or (
          auth.uid() is null
          and p_viewer_id is null
          and coalesce(post.visibility, 'public') <> 'private'
          and not owner.is_private
        )
      )
  );
$$;

revoke all on function public.aani_can_read_post(uuid, uuid) from public, anon, authenticated;
-- anon يحتاج EXECUTE لأن سياسة القراءة للمجهولين تعتمد على نفس الدالة.
grant execute on function public.aani_can_read_post(uuid, uuid) to authenticated, anon;

-- ---------------------------------------------------------------------
-- 2) توحيد سياسة القراءة للمستخدمين المسجّلين
--    الحذف قبل الإنشاء يزيل أي نسخة سابقة، بما فيها نسخة using (true).
-- ---------------------------------------------------------------------
alter table public.posts enable row level security;

drop policy if exists "Signed-in users can read posts" on public.posts;
create policy "Signed-in users can read posts"
  on public.posts for select to authenticated
  using (public.aani_can_read_post(id, (select auth.uid())));

-- ---------------------------------------------------------------------
-- 3) سياسة الزائر المجهول: نفس القاعدة بلا هوية (عام + صاحب حساب غير خاص)
-- ---------------------------------------------------------------------
drop policy if exists "Public can read public posts" on public.posts;
create policy "Public can read public posts"
  on public.posts for select to anon
  using (public.aani_can_read_post(id, null::uuid));

-- ---------------------------------------------------------------------
-- 4) إعادة تفعيل حارس الحجب restrictive على SELECT
--    aani_is_user_blocked (20261115000000) SECURITY DEFINER بـ search_path = ''
--    ولا تُعيد true إلا إذا كان auth.uid() أحد طرفي العلاقة، فهي آمنة داخل
--    السياسة ولا تكشف حجب مستخدمين آخرين.
--    السياسة restrictive: تُجمع بـ AND مع كل السياسات المتساهلة أعلاه.
-- ---------------------------------------------------------------------
drop policy if exists aani_posts_block_guard on public.posts;
create policy aani_posts_block_guard on public.posts
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));

-- ---------------------------------------------------------------------
-- 5) تحقق داخل الترحيل
--    (أ) حارس الحجب موجود كسياسة restrictive.
--    (ب) لا توجد سياسة متساهلة أخرى على SELECT توسّع القراءة وتبطل الحماية.
--    أي سياسة زائدة تُفشل الترحيل بالكامل (rollback) وتُسمّى في الرسالة،
--    لأن حذف سياسة مجهولة تلقائياً أخطر من إيقاف الترحيل.
-- ---------------------------------------------------------------------
do $$
declare
  extra_policies text;
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'aani_posts_block_guard'
      and permissive = 'RESTRICTIVE'
      and cmd = 'SELECT'
  ) then
    raise exception 'حارس الحجب aani_posts_block_guard غير مفعّل كسياسة restrictive للقراءة';
  end if;

  select string_agg(policy.policyname, ', ' order by policy.policyname)
  into extra_policies
  from pg_policies as policy
  where policy.schemaname = 'public'
    and policy.tablename = 'posts'
    and policy.cmd in ('SELECT', 'ALL')
    and policy.permissive = 'PERMISSIVE'
    and policy.policyname not in (
      'Signed-in users can read posts',
      'Public can read public posts'
    );

  if extra_policies is not null then
    raise exception
      'توجد سياسات قراءة متساهلة إضافية على public.posts توسّع الصلاحية: %. راجعها وأضفها إلى قائمة الحذف في هذا الترحيل قبل تطبيقه.',
      extra_policies;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) السياسات المتساهلة على posts: المتوقع سياستان فقط، والثالثة restrictive
--    select policyname, permissive, roles, cmd, qual
--    from pg_policies
--    where schemaname = 'public' and tablename = 'posts'
--    order by permissive, policyname;
--
-- 2) لا يوجد أي تعريف using (true) على posts (المتوقع: صفر صفوف)
--    select policyname, qual from pg_policies
--    where schemaname = 'public' and tablename = 'posts'
--      and coalesce(qual, '') ~* '^\s*true\s*$';
--
-- 3) الدالة المساعدة: definer، search_path مغلق، ومنح صحيح
--    select p.proname, p.prosecdef, p.proconfig, p.proacl
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'aani_can_read_post';
--
-- 4) اختبار بصري لثلاث حالات (استبدل المعرفات):
--    select public.aani_can_read_post('<post_id>', auth.uid());
--    -- المالك: true / متابع معتمد لحساب خاص: true / غريب على حساب خاص: false
--    -- منشور visibility = 'private' لمتابع معتمد: false
