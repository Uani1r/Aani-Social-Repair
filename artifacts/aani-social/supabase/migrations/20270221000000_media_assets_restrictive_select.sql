-- ============================================================================
-- media_assets: قيد RLS إضافي (RESTRICTIVE) على قراءة سجلّات المعالجة
--
-- المشكلة: سياسة SELECT الحالية على public.media_assets permissive وتسمح لأي
-- مستخدم مسجَّل بقراءة السجل (خصوصاً عند video_url IS NOT NULL) دون التحقق من
-- صلاحية مشاهدة المنشور المرتبط. سياسات RLS الـ permissive تُجمع بمنطق OR،
-- فأي سياسة permissive أخرى تبقى نافذة.
--
-- الإصلاح: سياسة RESTRICTIVE تُضاف كقيد AND فوق السياسة permissive القائمة
-- (لا تُحذف). تُسمح القراءة فقط إذا:
--   * كان user_id = auth.uid()  (صاحب السجل يقرأ سجله)، أو
--   * وُجد منشور مرتبط عبر posts.media_asset_id = media_assets.id، وكان
--     posts.user_id = media_assets.user_id، وaani_can_read_post(posts.id,
--     auth.uid()) تسمح للمستخدم بمشاهدته.
--
-- لا تُغيَّر أي سياسة أخرى ولا أي جدول أو صلاحية. آمن لإعادة التطبيق.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة: تفشل برسالة واضحة إن غاب كائن أو عمود أو دالة
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

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.posts'::regclass
      and attname = 'media_asset_id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'aani: العمود public.posts.media_asset_id غير موجود. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.posts'::regclass
      and attname = 'user_id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'aani: العمود public.posts.user_id غير موجود. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if to_regprocedure('public.aani_can_read_post(uuid, uuid)') is null then
    raise exception 'aani: public.aani_can_read_post(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) السياسة RESTRICTIVE (قيد إضافي فوق permissive القائمة)
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
    )
  );

-- ----------------------------------------------------------------------------
-- 2) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_definition text;
  v_permissive_exists boolean;
begin
  -- (أ) السياسة الجديدة موجودة، restrictive، وعلى SELECT
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

  -- (ب) الشرطان المطلوبان موجودان في التعبير
  if position('user_id' in v_definition) = 0
     or position('aani_can_read_post' in v_definition) = 0
     or position('media_asset_id' in v_definition) = 0 then
    raise exception 'aani: تعبير السياسة لا يطابق الشرطين المطلوبين (owner OR readable post): %', v_definition
      using errcode = '42501';
  end if;

  -- (ج) السياسة permissive القائمة لم تُحذف (أي اسم كانت تحمله)
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

  -- (د) aani_can_read_post ما زالت متاحة لمن يحتاجها في تقييم السياسة
  if not has_function_privilege('authenticated', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated لا تملك EXECUTE على aani_can_read_post — ستفشل السياسة.'
      using errcode = '42501';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select policyname, permissive, cmd, qual from pg_policies
--  where schemaname='public' and tablename='media_assets' and cmd='SELECT';
