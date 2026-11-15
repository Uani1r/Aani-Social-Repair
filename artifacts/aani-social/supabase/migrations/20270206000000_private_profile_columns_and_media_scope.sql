-- ترحيل: حجب أعمدة profiles الشخصية عن REST، وتثبيت حارس الحجب بعد توفّر
-- دالته، وإضافة قرار قراءة كائن وسائط واحد على Storage.
--
-- 1) أعمدة profiles الشخصية
--    20261227000000 (سطر 7-13) وschema.sql (سطر 494-500) يمنحان authenticated
--    قراءة notification_settings و appearance_preference و language_preference
--    و hd_uploads و data_saver و font_preference على كل الصفوف، لا على صف
--    المستخدم نفسه. فأي مستخدم يقرأ تفضيلات غيره. و RLS لا تحجب عموداً عن صف،
--    فالحل سحب منح الأعمدة وإتاحتها لصاحبها عبر دالة.
--    الأعمدة العامة (الاسم، اليوزر، الصورة، الغلاف، النبذة، الوظيفة، المدينة،
--    تاريخ الميلاد، الموقع، أعلام show_*، الجنس، is_private، is_nearby_visible،
--    is_deactivated، created_at/updated_at) تبقى ممنوحة كما هي.
--
-- 2) حارس الحجب على posts: 20270203000000 ينشئه فقط إن وُجدت
--    aani_is_user_blocked، و20270204000000 هو من ينشئها عند غيابها. هنا
--    يُعاد إنشاؤه بعد أن صارت الدالة متاحة، فلا يبقى مسار بلا حماية.
--
-- 3) وسائط Storage: الـbucket aani-media عام (schema.sql سطر 510-514) وسياسته
--    "Aani media is readable by signed-in users" تسمح بقراءة كل كائناته لكل
--    مسجّل. تُضاف هنا دالة قرار aani_can_read_media_object(name) وسياسة
--    restrictive تستخدمها. تنفذ السياسة فور تحويل الـbucket إلى private؛
--    أما في bucket عام فمسار /object/public/ لا يمرّ بـRLS، لذا التحويل خطوة
--    يدوية في APPLY_MANUALLY_20270206000000_media_bucket_private.sql لأن
--    تحويله الآن يقطع كل روابط الوسائط المخزّنة قبل نشر عميل يدعم الروابط الموقّعة.
--
-- لا يعدّل جداول ولا بيانات ولا سياسات القصص ولا واجهة التطبيق.
-- يعتمد على 20270203000000 و20270204000000. آمن للتكرار.
begin;

-- ---------------------------------------------------------------------
-- 0) التحقق من المتطلبات المسبقة
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.follows') is null then
    raise exception 'public.profiles أو public.follows غير موجود';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_can_read_post'
  ) then
    raise exception 'الدالة public.aani_can_read_post مفقودة — طبّق 20270203000000 أولاً';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_is_user_blocked'
  ) then
    raise exception 'الدالة public.aani_is_user_blocked مفقودة — طبّق 20270204000000 أولاً';
  end if;

  -- الدالة والسحب والمنح أدناه تسمّي هذه الأعمدة صراحةً، فلا بد من وجودها.
  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name in (
        'notification_settings', 'appearance_preference', 'language_preference',
        'hd_uploads', 'data_saver', 'font_preference', 'fcm_token'
      )
  ) <> 7 then
    raise exception 'بعض أعمدة profiles الشخصية مفقود — طبّق schema.sql أو 20261227000000 أولاً';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) سحب قراءة الأعمدة الشخصية (منح العمود قائم، فالسحب على مستوى العمود نافذ)
-- ---------------------------------------------------------------------
do $$
declare
  private_columns text;
  public_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into private_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'profiles'
    and column_name in (
      'notification_settings', 'appearance_preference', 'language_preference',
      'hd_uploads', 'data_saver', 'font_preference', 'fcm_token'
    );

  if private_columns is not null then
    execute format('revoke select (%s) on table public.profiles from anon', private_columns);
    execute format('revoke select (%s) on table public.profiles from authenticated', private_columns);
  end if;

  -- لو كان الجدول ممنوحاً بالكامل (grant select on table) فسحب الأعمدة لا يكفي:
  -- في هذه الحالة يُسحب منح الجدول ويُعاد منح الأعمدة العامة فقط.
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then
    execute 'revoke select on table public.profiles from anon, authenticated';

    select string_agg(quote_ident(column_name), ', ' order by column_name)
    into public_columns
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name in (
        'id', 'username', 'full_name', 'display_name', 'avatar_url',
        'cover_url', 'cover_position_x', 'cover_position_y',
        'bio', 'job', 'city', 'location', 'birth_date',
        'show_city', 'show_job', 'show_birth_date', 'website',
        'gender', 'is_private', 'is_nearby_visible', 'is_deactivated',
        'city_key', 'created_at', 'updated_at'
      );

    if public_columns is null then
      raise exception 'لم يُعثر على أي عمود عام في public.profiles — راجع المخطط';
    end if;

    execute format('grant select (%s) on table public.profiles to authenticated', public_columns);
  end if;
end $$;

-- التحديث على الأعمدة الشخصية يبقى لصاحب الصف وحده (سياسة UPDATE تشترط
-- id = auth.uid())، ويُمنح صراحةً حتى لا يعتمد على منح جدول قد يُسحب.
grant update (
  notification_settings, appearance_preference, language_preference,
  hd_uploads, data_saver, font_preference, fcm_token
) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- 2) تفضيلات المستخدم الحالي فقط
--    SECURITY DEFINER لأن الأعمدة لم تعد ممنوحة للمستدعي، ومحدودة الصلاحيات:
--    تُعيد صف auth.uid() وحده، ولا تقبل معرّفاً، فلا تُقرأ تفضيلات غيرك.
-- ---------------------------------------------------------------------
create or replace function public.aani_my_preferences()
returns table (
  notification_settings jsonb,
  appearance_preference text,
  language_preference text,
  hd_uploads boolean,
  data_saver boolean,
  font_preference text,
  is_deactivated boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    profile.notification_settings,
    profile.appearance_preference,
    profile.language_preference,
    profile.hd_uploads,
    profile.data_saver,
    profile.font_preference,
    profile.is_deactivated
  from public.profiles as profile
  where profile.id = auth.uid();
$$;

revoke all on function public.aani_my_preferences() from public, anon;
grant execute on function public.aani_my_preferences() to authenticated;

-- ---------------------------------------------------------------------
-- 3) حارس الحجب على posts، بعد أن صارت الدالة متاحة
-- ---------------------------------------------------------------------
drop policy if exists aani_posts_block_guard on public.posts;
create policy aani_posts_block_guard on public.posts
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));

-- ---------------------------------------------------------------------
-- 4) قرار قراءة كائن وسائط واحد
--    true فقط إذا كان المستدعي يملك حق قراءة المحتوى الذي يملك الملف:
--      * مجلد المستدعي نفسه (رفعاته).
--      * صورة أو غلاف ملف شخصي: معلومة عامة لكل مسجّل.
--      * وسائط منشور: عبر aani_can_read_post (خصوصية الحساب + الحجب).
--      * وسائط قصة: عبر aani_can_view_story (تتحقق من is_private أصلاً).
--      * وسائط أبرز القصص: عبر aani_can_view_profile_highlight.
--    كل ما عدا ذلك false. search_path = '' وتأهيل كامل للأسماء.
-- ---------------------------------------------------------------------
create or replace function public.aani_can_read_media_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and coalesce(nullif(btrim(p_object_name), ''), '') <> ''
    and (
      -- رفعات المستخدم نفسه: أول مقطع من المسار هو معرّفه
      split_part(ltrim(p_object_name, '/'), '/', 1) = auth.uid()::text
      -- صورة أو غلاف ملف شخصي (معلومة عامة)
      or exists (
        select 1
        from public.profiles as profile
        where coalesce(profile.avatar_url, '') like '%' || p_object_name
           or coalesce(profile.cover_url, '') like '%' || p_object_name
      )
      -- وسائط منشور (صورة، فيديو، أو صوته)
      or exists (
        select 1
        from public.posts as post
        where (
            coalesce(post.media_url, '') like '%' || p_object_name
            or exists (
              select 1
              from unnest(coalesce(post.media_urls, '{}'::text[])) as url
              where url like '%' || p_object_name
            )
            or coalesce(post.audio_url, '') like '%' || p_object_name
          )
          and public.aani_can_read_post(post.id, auth.uid())
      )
      -- وسائط قصة أو إعادة مشاركتها
      or exists (
        select 1
        from public.stories as story
        where coalesce(story.media_url, '') like '%' || p_object_name
          and public.aani_can_view_story(story.id, auth.uid())
      )
      -- وسائط أبرز القصص وأغلفة مجموعاتها
      or exists (
        select 1
        from public.profile_highlights as highlight
        where coalesce(highlight.media_url, '') like '%' || p_object_name
          and public.aani_can_view_profile_highlight(highlight.user_id, highlight.is_close_friends)
      )
      or exists (
        select 1
        from public.profile_highlight_collections as collection
        where coalesce(collection.cover_url, '') like '%' || p_object_name
          and (
            collection.user_id = auth.uid()
            or exists (
              select 1
              from public.profile_highlights as item
              where item.collection_id = collection.id
                and public.aani_can_view_profile_highlight(item.user_id, item.is_close_friends)
            )
          )
      )
    ),
    false
  );
$$;

revoke all on function public.aani_can_read_media_object(text) from public, anon;
grant execute on function public.aani_can_read_media_object(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5) سياسة restrictive على storage.objects
--    تحل محل السياسة المتساهلة (كل كائنات الـbucket لكل مسجّل). restrictive
--    تُجمع بـ AND مع أي سياسة أخرى فلا تُوسَّع بإعادة إنشاء سياسة قديمة.
--    bucket_id <> 'aani-media' يترك بقية الـbuckets كما هي.
--    في bucket عام لا تمرّ قراءة /object/public/ بـRLS: انظر ملف التحويل اليدوي.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise warning 'storage.objects غير موجود — تم تخطي سياسة وسائط التخزين';
    return;
  end if;

  execute 'drop policy if exists "Aani media is readable by signed-in users" on storage.objects';
  execute 'drop policy if exists aani_media_objects_read_guard on storage.objects';
  execute $policy$
    create policy aani_media_objects_read_guard on storage.objects
      as restrictive for select to authenticated
      using (
        bucket_id <> 'aani-media'
        or public.aani_can_read_media_object(name)
      )
  $policy$;
end $$;

-- ---------------------------------------------------------------------
-- 6) تحقق داخل الترحيل
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'aani_posts_block_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  ) then
    raise exception 'حارس الحجب على posts غير مفعّل';
  end if;

  if exists (
    select 1
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee in ('anon', 'authenticated')
      and privilege_type = 'SELECT'
      and column_name in (
        'notification_settings', 'appearance_preference', 'language_preference',
        'hd_uploads', 'data_saver', 'font_preference', 'fcm_token'
      )
  ) then
    raise exception 'ما زالت أعمدة profiles الشخصية ممنوحة للقراءة';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) الأعمدة الممنوحة للمستخدم المسجّل (يجب ألا تظهر الأعمدة الشخصية)
--    select column_name
--    from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and grantee = 'authenticated' and privilege_type = 'SELECT'
--    order by column_name;
--
-- 2) قراءة تفضيلات مستخدم آخر يجب أن تفشل (42501)
--    select notification_settings from public.profiles where id = '<other_user>';
--
-- 3) تفضيلات المستخدم نفسه تعمل عبر الدالة
--    select * from public.aani_my_preferences();
--
-- 4) قرار الوسائط لحساب خاص A (بصفتك غير متابع)
--    select public.aani_can_read_media_object('<object_path_of_A_post>');  -- false
