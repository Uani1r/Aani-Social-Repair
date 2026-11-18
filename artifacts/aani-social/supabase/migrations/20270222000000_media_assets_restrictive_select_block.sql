-- ============================================================================
-- media_assets: إضافة فحص الحظر إلى سياسة القراءة RESTRICTIVE
--
-- الخلفية: media_assets_restrictive_select (20270221000000) تسمح بالقراءة عبر
-- منشور مرتبط عندما تسمح aani_can_read_post. لكن aani_can_read_post دالة
-- SECURITY DEFINER تتجاوز RLS، وفحص الحظر في هذا المشروع موجود في حارس
-- restrictive على public.posts ولا ينتقل تلقائياً إلى داخل الدالة. النتيجة:
-- منشور عام (أو مقروء) لصاحب وسائط محظور قد يبقى سجله مقروءاً.
--
-- الإصلاح: إعادة إنشاء نفس السياسة بنفس الاسم والنوع والأدوار، مع بقاء شرط
-- المالك كما هو، وإضافة شرط واحد إلى فرع EXISTS الخاص بالمنشور:
--   NOT public.aani_is_user_blocked((select auth.uid()), media_assets.user_id)
--
--   * aani_is_user_blocked تُعيد false عندما auth.uid() = NULL (لأنها تشترط
--     أن يكون المستدعي أحد الطرفين)، لذلك لا يمنع هذا الشرط زائر anon من قراءة
--     سجلات المنشورات العامة.
--   * عند مستخدم مسجَّل تُعيد true عند وجود حظر في أي اتجاه، فيُمنع السجل.
--
-- لا تُغيَّر أي سياسة أو صلاحية أخرى. آمن لإعادة التطبيق.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة
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
end $$;

-- ----------------------------------------------------------------------------
-- 1) إعادة إنشاء السياسة نفسها مع شرط الحظر
-- ============================================================================
drop policy if exists media_assets_restrictive_select on public.media_assets;
create policy media_assets_restrictive_select
  on public.media_assets
  as restrictive
  for select to anon, authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.posts as post
      where post.media_asset_id = media_assets.id
        and post.user_id = media_assets.user_id
        and public.aani_can_read_post(post.id, (select auth.uid()))
        -- لا قراءة عند وجود حظر في أي اتجاه بين المشاهد وصاحب سجل الوسائط.
        -- مع anon يكون auth.uid() = NULL فتُعيد الدالة false ولا يُمنع العرض.
        and not public.aani_is_user_blocked((select auth.uid()), media_assets.user_id)
    )
  );

-- ----------------------------------------------------------------------------
-- 2) تحقق بعد التعديل
-- ----------------------------------------------------------------------------
do $$
declare
  v_definition text;
  v_permissive_exists boolean;
begin
  select coalesce(qual, '') into v_definition
  from pg_policies
  where schemaname = 'public'
    and tablename = 'media_assets'
    and policyname = 'media_assets_restrictive_select'
    and permissive = 'RESTRICTIVE'
    and cmd = 'SELECT';

  if v_definition = '' then
    raise exception 'aani: السياسة media_assets_restrictive_select غير مثبتة كـ RESTRICTIVE على SELECT.'
      using errcode = '42501';
  end if;

  -- (أ) شرط المالك بقي كما هو
  if position('user_id' in v_definition) = 0 then
    raise exception 'aani: شرط المالك (user_id = auth.uid()) غاب من السياسة: %', v_definition
      using errcode = '42501';
  end if;

  -- (ب) فرع المنشور ما زال يستند إلى aani_can_read_post وmedia_asset_id
  if position('aani_can_read_post' in v_definition) = 0
     or position('media_asset_id' in v_definition) = 0 then
    raise exception 'aani: فرع المنشور في السياسة تغيّر: %', v_definition
      using errcode = '42501';
  end if;

  -- (ج) شرط الحظر موجود
  if position('aani_is_user_blocked' in v_definition) = 0 then
    raise exception 'aani: شرط الحظر غير موجود في السياسة: %', v_definition
      using errcode = '42501';
  end if;

  -- (ج٢) الحظر يُفحص على هوية المشاهد وصاحب سجل الوسائط
  if position('media_assets.user_id' in v_definition) = 0 then
    raise exception 'aani: شرط الحظر لا يستخدم media_assets.user_id: %', v_definition
      using errcode = '42501';
  end if;

  -- (د) السياسة permissive القائمة لم تُحذف
  select exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'media_assets'
      and permissive = 'PERMISSIVE'
      and cmd = 'SELECT'
  ) into v_permissive_exists;

  if not v_permissive_exists then
    raise exception 'aani: لا توجد أي سياسة SELECT permissive على media_assets — لم يكن مقصوداً حذفها.'
      using errcode = '42501';
  end if;

  -- (هـ) الدالتان المتاحة للدور الذي تقيّم السياسة
  if not has_function_privilege('authenticated', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated لا تملك EXECUTE على aani_can_read_post — ستفشل السياسة.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated لا تملك EXECUTE على aani_is_user_blocked — ستفشل السياسة.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('anon', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: anon لا تملك EXECUTE على aani_can_read_post — ستفشل السياسة للزوار.'
      using errcode = '42501';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select policyname, permissive, cmd, qual from pg_policies
--  where schemaname='public' and tablename='media_assets' and cmd='SELECT';
