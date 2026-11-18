-- ============================================================================
-- media_assets: فصل قيد SELECT الـ RESTRICTIVE إلى سياسة للزوار وأخرى للمسجّلين
--
-- الخلفية: الترحيل 20270221000000 (PR #58) أنشأ سياسة واحدة مشتركة
-- media_assets_restrictive_select تشمل anon وauthenticated. ثم كان المطلوب
-- إضافة فحص الحظر إليها:
--   and not public.aani_is_user_blocked((select auth.uid()), media_assets.user_id)
--
-- ما اكتُشف في قاعدة الإنتاج: anon لا يملك EXECUTE على
-- public.aani_is_user_blocked(uuid, uuid) لأن الترحيل 20270218000000 (PR #55)
-- سحبه. وPostgreSQL يفحص صلاحية EXECUTE على الدوال عند تهيئة تعبير السياسة
-- (ExecInitFunc → pg_proc_aclcheck) لأي استعلام يقوم به الدور، بغضّ النظر عن
-- أي فرع من التعبير سيُنفَّذ فعلاً. لذلك سياسة واحدة تشمل anon وتستدعي هذه
-- الدالة تعني أن أي SELECT من الزوار على media_assets سيفشل بالخطأ
-- "permission denied for function" بدل أن تُفلتر الصفوف.
--
-- الإصلاح: استبدال السياسة المشتركة بسياستين RESTRICTIVE منفصلتين، كل دور
-- يحصل على سياسة تستدعي فقط ما يملك صلاحية تنفيذه:
--
--   * media_assets_restrictive_anon_select  (to anon)
--       بوابة aani_can_read_post فقط، ولا تستدعي aani_is_user_blocked إطلاقاً.
--       شرط المالك غير قابل للتحقق أبداً مع anon (auth.uid() = NULL)، فإسقاطه
--       لا يوسّع الوصول.
--
--   * media_assets_restrictive_authenticated_select  (to authenticated)
--       شرط المالك، أو منشور مرتبط يمرّ من aani_can_read_post، مع فحص الحظر
--       عبر aani_is_user_blocked (لأن aani_can_read_post دالة SECURITY DEFINER
--       تتجاوز RLS، ومنها فحص الحظر الموجود على public.posts).
--
-- لا تُحذف أي سياسة permissive، ولا تُمنح anon أي صلاحية جديدة، ولا تُعدَّل
-- صلاحيات الدوال ولا الترحيل 20270218000000. آمن لإعادة التطبيق.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة: تفشل برسالة واضحة إن غاب جدول أو عمود أو دالة أو دور
-- ============================================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_column text;
begin
  if to_regclass('public.media_assets') is null then
    v_missing := v_missing || 'public.media_assets';
  end if;
  if to_regclass('public.posts') is null then
    v_missing := v_missing || 'public.posts';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'aani: جداول مطلوبة غير موجودة: %. أوقف الترحيل.', array_to_string(v_missing, ', ')
      using errcode = '42P01';
  end if;

  foreach v_column in array array['id', 'user_id']
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.media_assets'::regclass
        and attname = v_column and attnum > 0 and not attisdropped
    ) then
      raise exception 'aani: العمود public.media_assets.% غير موجود. أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;

  foreach v_column in array array['media_asset_id', 'user_id']
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.posts'::regclass
        and attname = v_column and attnum > 0 and not attisdropped
    ) then
      raise exception 'aani: العمود public.posts.% غير موجود. أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;

  if to_regprocedure('public.aani_can_read_post(uuid, uuid)') is null then
    raise exception 'aani: public.aani_can_read_post(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  if to_regprocedure('public.aani_is_user_blocked(uuid, uuid)') is null then
    raise exception 'aani: public.aani_is_user_blocked(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  foreach v_column in array array['anon', 'authenticated']
  loop
    if not exists (select 1 from pg_roles where rolname = v_column) then
      raise exception 'aani: الدور % غير موجود. أوقف الترحيل.', v_column
        using errcode = '42704';
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 0.1) لقطة بأسماء سياسات SELECT permissive القائمة قبل أي تعديل،
--      ليثبت الفحص البعدي أنها كلها ما زالت موجودة.
-- ============================================================================
drop table if exists pg_temp.aani_media_assets_permissive_before;

create temporary table aani_media_assets_permissive_before
  on commit drop
as
select policyname::text as policyname
from pg_policies
where schemaname = 'public'
  and tablename = 'media_assets'
  and permissive = 'PERMISSIVE'
  and cmd = 'SELECT';

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from pg_temp.aani_media_assets_permissive_before;

  if v_count = 0 then
    raise notice 'aani: لا توجد أي سياسة SELECT permissive على media_assets قبل التعديل — الوصول معطَّل أصلاً ما لم توجد سياسة permissive.';
  else
    raise notice 'aani: عدد سياسات SELECT permissive القائمة قبل التعديل: %', v_count;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) حذف السياسة المشتركة (التي أنشأها 20270221000000) وإنشاء سياسة لكل دور
-- ============================================================================
drop policy if exists media_assets_restrictive_select on public.media_assets;

-- 1.1) الزوار (anon): بوابة aani_can_read_post فقط، بلا aani_is_user_blocked.
drop policy if exists media_assets_restrictive_anon_select on public.media_assets;

create policy media_assets_restrictive_anon_select
  on public.media_assets
  as restrictive
  for select
  to anon
  using (
    exists (
      select 1
      from public.posts as post
      where post.media_asset_id = media_assets.id
        and post.user_id = media_assets.user_id
        and public.aani_can_read_post(post.id, (select auth.uid()))
    )
  );

-- 1.2) المسجّلون (authenticated): شرط المالك + بوابة المنشور + فحص الحظر.
drop policy if exists media_assets_restrictive_authenticated_select on public.media_assets;

create policy media_assets_restrictive_authenticated_select
  on public.media_assets
  as restrictive
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.posts as post
      where post.media_asset_id = media_assets.id
        and post.user_id = media_assets.user_id
        and public.aani_can_read_post(post.id, (select auth.uid()))
        -- لا قراءة عند وجود حظر في أي اتجاه بين المشاهد وصاحب سجل الوسائط.
        and not public.aani_is_user_blocked((select auth.uid()), media_assets.user_id)
    )
  );

-- ----------------------------------------------------------------------------
-- 2) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_anon_qual text;
  v_anon_roles name[];
  v_auth_qual text;
  v_auth_roles name[];
  v_missing_permissive text;
begin
  -- (أ) السياسة المشتركة القديمة لم تعد موجودة
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'media_assets'
      and policyname = 'media_assets_restrictive_select'
  ) then
    raise exception 'aani: السياسة المشتركة media_assets_restrictive_select ما زالت موجودة — لم يكتمل الاستبدال.'
      using errcode = '42501';
  end if;

  -- (ب) سياسة anon: موجودة، RESTRICTIVE، SELECT، لدور anon وحده
  select coalesce(qual, ''), roles
    into v_anon_qual, v_anon_roles
  from pg_policies
  where schemaname = 'public'
    and tablename = 'media_assets'
    and policyname = 'media_assets_restrictive_anon_select'
    and permissive = 'RESTRICTIVE'
    and cmd = 'SELECT';

  if v_anon_qual is null or v_anon_qual = '' then
    raise exception 'aani: السياسة media_assets_restrictive_anon_select غير مثبتة كـ RESTRICTIVE على SELECT.'
      using errcode = '42501';
  end if;

  if v_anon_roles is distinct from array['anon']::name[] then
    raise exception 'aani: سياسة anon موجّهة إلى % بدل anon وحدها.', v_anon_roles
      using errcode = '42501';
  end if;

  if position('aani_can_read_post' in v_anon_qual) = 0
     or position('media_asset_id' in v_anon_qual) = 0
     or position('user_id' in v_anon_qual) = 0 then
    raise exception 'aani: سياسة anon فقدت بوابة aani_can_read_post أو ربط media_asset_id/posts.user_id: %', v_anon_qual
      using errcode = '42501';
  end if;

  -- (ب٢) سياسة anon لا تستدعي دالة الحظر إطلاقاً (لأن anon لا يملك EXECUTE عليها)
  if position('aani_is_user_blocked' in v_anon_qual) > 0 then
    raise exception 'aani: سياسة anon تستدعي aani_is_user_blocked — ستفشل قراءات الزوار بخطأ صلاحيات: %', v_anon_qual
      using errcode = '42501';
  end if;

  -- (ج) سياسة authenticated: موجودة، RESTRICTIVE، SELECT، لدور authenticated وحده
  select coalesce(qual, ''), roles
    into v_auth_qual, v_auth_roles
  from pg_policies
  where schemaname = 'public'
    and tablename = 'media_assets'
    and policyname = 'media_assets_restrictive_authenticated_select'
    and permissive = 'RESTRICTIVE'
    and cmd = 'SELECT';

  if v_auth_qual is null or v_auth_qual = '' then
    raise exception 'aani: السياسة media_assets_restrictive_authenticated_select غير مثبتة كـ RESTRICTIVE على SELECT.'
      using errcode = '42501';
  end if;

  if v_auth_roles is distinct from array['authenticated']::name[] then
    raise exception 'aani: سياسة authenticated موجّهة إلى % بدل authenticated وحدها.', v_auth_roles
      using errcode = '42501';
  end if;

  if position('user_id' in v_auth_qual) = 0
     or position('aani_can_read_post' in v_auth_qual) = 0
     or position('media_asset_id' in v_auth_qual) = 0 then
    raise exception 'aani: سياسة authenticated فقدت شرط المالك أو بوابة aani_can_read_post: %', v_auth_qual
      using errcode = '42501';
  end if;

  -- (ج٢) سياسة authenticated تفحص الحظر على صاحب سجل الوسائط
  if position('aani_is_user_blocked' in v_auth_qual) = 0 then
    raise exception 'aani: سياسة authenticated لا تستدعي aani_is_user_blocked: %', v_auth_qual
      using errcode = '42501';
  end if;

  if position('media_assets.user_id' in v_auth_qual) = 0 then
    raise exception 'aani: فحص الحظر في سياسة authenticated لا يستخدم media_assets.user_id: %', v_auth_qual
      using errcode = '42501';
  end if;

  -- (د) كل سياسات SELECT permissive الأصلية ما زالت موجودة بنفس الأسماء
  select string_agg(b.policyname, ', ')
    into v_missing_permissive
  from pg_temp.aani_media_assets_permissive_before as b
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'media_assets'
      and p.permissive = 'PERMISSIVE'
      and p.cmd = 'SELECT'
      and p.policyname::text = b.policyname
  );

  if v_missing_permissive is not null then
    raise exception 'aani: سياسات SELECT permissive أصلية اختفت: % — لم يكن مقصوداً حذفها.', v_missing_permissive
      using errcode = '42501';
  end if;

  -- (هـ) الصلاحيات التي تحتاجها كل سياسة فعلاً
  if not has_function_privilege('anon', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: anon لا تملك EXECUTE على aani_can_read_post — ستفشل سياسة الزوار.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated لا تملك EXECUTE على aani_can_read_post — ستفشل سياسة المسجّلين.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated لا تملك EXECUTE على aani_is_user_blocked — ستفشل سياسة المسجّلين.'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise notice 'aani: anon يملك EXECUTE على aani_is_user_blocked، لكن سياسة anon لا تستدعيه فلا حاجة له.';
  else
    raise notice 'aani: anon لا يملك EXECUTE على aani_is_user_blocked (كما هو متوقع بعد 20270218000000)، وسياسة anon لا تستدعيه.';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select policyname, permissive, cmd, roles, qual from pg_policies
--  where schemaname='public' and tablename='media_assets' and cmd='SELECT';
