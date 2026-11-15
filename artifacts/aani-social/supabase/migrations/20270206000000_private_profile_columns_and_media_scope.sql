-- ترحيل: حجب أعمدة profiles الشخصية والمشروطة بأعلام الظهور، وتثبيت حارس
-- الحجب بعد توفّر دالته، وإضافة قرار قراءة كائن وسائط واحد على Storage.
--
-- 1) أعمدة profiles الشخصية
--    20261227000000 (سطر 7-13) وschema.sql (سطر 494-500) يمنحان authenticated
--    قراءة notification_settings و appearance_preference و language_preference
--    و hd_uploads و data_saver و font_preference على كل الصفوف، لا على صف
--    المستخدم نفسه. فأي مستخدم يقرأ تفضيلات غيره. و RLS لا تحجب عموداً عن صف،
--    فالحل سحب منح الأعمدة وإتاحتها لصاحبها عبر دالة.
--
--    كذلك birth_date و city و location: صاحب الحساب يتحكم بإظهارها عبر
--    show_birth_date و show_city، لكن الواجهة كانت تخفيها فقط بينما تبقى
--    مقروءة عبر REST لكل مستخدم. تُسحب هنا أيضاً، وتُقرأ قيمتها الفعلية عبر
--    aani_public_profile() التي تُعيدها فارغة (null) عندما يكون العلم مُطفأ.
--
--    الأعمدة العامة التي تبقى ممنوحة مباشرة: id, username, full_name,
--    display_name, avatar_url, cover_url, cover_position_x, cover_position_y,
--    bio, job, website, gender, is_private, is_nearby_visible, is_deactivated,
--    created_at, updated_at، وأعلام show_* نفسها (ضرورية للعميل ليعرف ما يُعرض).
--
-- 2) حارس الحجب على posts: 20270203000000 ينشئه فقط إن وُجدت
--    aani_is_user_blocked، و20270204000000 هو من ينشئها عند غيابها. هنا
--    يُعاد إنشاؤه بعد أن صارت الدالة متاحة، فلا يبقى مسار بلا حماية.
--
-- 3) وسائط Storage و ImageKit: bucket aani-media عام وسياسته تسمح بقراءة كل
--    كائناته لكل مسجّل. تُضاف دالة قرار aani_can_read_media_object(name)
--    وسياسة restrictive تستخدمها، ويُضاف أصل ImageKit إلى نفس القرار حتى
--    يستخدمه خادم التوقيع. الحماية الكاملة بالرابط المباشر تحتاج bucket خاصاً
--    و Restricted access في ImageKit — ملفان يدويان منفصلان.
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
-- 1) سحب قراءة الأعمدة الخاصة والمشروطة بأعلام الظهور — سحب شامل
--
--    لا يكفي سحب الأعمدة: قد يكون SELECT ممنوحاً على مستوى الجدول أو لـ PUBLIC
--    أو لدور آخر (anon / authenticator / custom roles). لذلك:
--      أ) يُسحب SELECT على الجدول من PUBLIC و anon و authenticated و كل دور
--         يملكه فعلاً (فحص information_schema.column_privileges و role_table_grants).
--      ب) تُمنح قائمة الأعمدة العامة صراحةً لـ authenticated فقط.
--      ج) تُسحب الأعمدة الخاصة من كل دور آخر يملكها، بمن فيه service_role
--         ما لم يكن هو مالك الجدول (service_role يتجاوز RLS لكنه لا يُستخدم
--         في المتصفح؛ إبقاء منحه لا يضر، لكن السحب يمنع أي عميل مسرَّب).
--
--    الأعمدة المسحوبة: التفضيلات الشخصية + fcm_token + birth_date + city +
--    location (الأخيران محكومان بـ show_city، و birth_date بـ show_birth_date).
-- ---------------------------------------------------------------------
do $$
declare
  private_column_names text[] := array[
    'notification_settings', 'appearance_preference', 'language_preference',
    'hd_uploads', 'data_saver', 'font_preference', 'fcm_token',
    'birth_date', 'city', 'location'
  ];
  grantee_name text;
  private_columns text;
  public_columns text;
begin
  -- أ) كل دور يملك SELECT على الجدول (بما فيه PUBLIC و anon و authenticated
  --    و authenticator و أي دور مخصص). PUBLIC يظهر باسم PUBLIC في هذه الجداول.
  for grantee_name in
    select distinct grant.grantee
    from information_schema.role_table_grants as grant
    where grant.table_schema = 'public'
      and grant.table_name = 'profiles'
      and grant.privilege_type = 'SELECT'
      and grant.grantee <> current_user
  loop
    if grantee_name = 'PUBLIC' then
      execute 'revoke select on table public.profiles from public';
    else
      execute format('revoke select on table public.profiles from %I', grantee_name);
    end if;
  end loop;

  -- ب) سحب الأعمدة الخاصة من أي دور يملكها على مستوى العمود
  for grantee_name in
    select distinct privilege.grantee
    from information_schema.column_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name = 'profiles'
      and privilege.privilege_type = 'SELECT'
      and privilege.column_name = any(private_column_names)
      and privilege.grantee <> current_user
  loop
    select string_agg(quote_ident(privilege.column_name), ', ' order by privilege.column_name)
    into private_columns
    from information_schema.column_privileges as privilege
    where privilege.table_schema = 'public'
      and privilege.table_name = 'profiles'
      and privilege.privilege_type = 'SELECT'
      and privilege.column_name = any(private_column_names)
      and privilege.grantee = grantee_name;

    if private_columns is not null then
      if grantee_name = 'PUBLIC' then
        execute format('revoke select (%s) on table public.profiles from public', private_columns);
      else
        execute format('revoke select (%s) on table public.profiles from %I', private_columns, grantee_name);
      end if;
    end if;
  end loop;

  -- ج) منح قائمة الأعمدة العامة صراحةً لـ authenticated
  --    city و location و birth_date و city_key ليست هنا عمداً: الأولى محكومة
  --    بـ show_city والثانية بـ show_birth_date، و city_key يشتق من المدينة.
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into public_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'profiles'
    and column_name in (
      'id', 'username', 'full_name', 'display_name', 'avatar_url',
      'cover_url', 'cover_position_x', 'cover_position_y',
      'bio', 'job', 'website', 'gender',
      'is_private', 'is_nearby_visible', 'is_deactivated',
      'show_city', 'show_job', 'show_birth_date',
      'created_at', 'updated_at'
    );

  if public_columns is null then
    raise exception 'لم يُعثر على أي عمود عام في public.profiles — راجع المخطط';
  end if;

  execute format('grant select (%s) on table public.profiles to authenticated', public_columns);

  raise notice 'أعمدة profiles العامة الممنوحة: %', public_columns;
end $$;

-- لا تُمنح city/location/birth_date لأي دور عبر REST: منح العمود في PostgreSQL
-- يشمل كل الصفوف لا صف المالك، فمنحها للمالك يمنحها للجميع. صاحب الحساب يقرأها
-- عبر aani_public_profile() التي تُعيدها له دائماً وتُخفيها عن غيره حسب الأعلام.
-- التحديث عليها يبقى محكوماً بسياسة UPDATE (id = auth.uid()).
grant update (
  notification_settings, appearance_preference, language_preference,
  hd_uploads, data_saver, font_preference, fcm_token,
  birth_date, city, location
) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- 1ب) قراءة الملف العام مع احترام أعلام الظهور
--     RLS لا تحجب عموداً عن صف، وسحب birth_date/city/location يمنع صاحبها
--     أيضاً من قراءتها مباشرة في نموذج التحرير. هذه الدالة تُعيد الصف كاملاً
--     لصاحبه، ولغيره تُعيد birth_date و city و location فارغة عندما يكون
--     show_birth_date أو show_city مُطفأً. SECURITY DEFINER مع search_path = ''
--     وتأهيل كامل، ولا تقبل معرّفاً خارجياً: تُعيد صف auth.uid() أو صفاً عاماً.
-- ---------------------------------------------------------------------
create or replace function public.aani_public_profile(p_user_id uuid)
returns table (
  id uuid,
  username text,
  full_name text,
  display_name text,
  avatar_url text,
  cover_url text,
  cover_position_x real,
  cover_position_y real,
  bio text,
  job text,
  website text,
  gender text,
  is_private boolean,
  is_deactivated boolean,
  show_city boolean,
  show_job boolean,
  show_birth_date boolean,
  city text,
  location text,
  birth_date date,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    profile.id,
    profile.username,
    profile.full_name,
    profile.display_name,
    profile.avatar_url,
    profile.cover_url,
    profile.cover_position_x,
    profile.cover_position_y,
    profile.bio,
    profile.job,
    profile.website,
    profile.gender,
    profile.is_private,
    profile.is_deactivated,
    profile.show_city,
    profile.show_job,
    profile.show_birth_date,
    -- المدينة/الموقع وتاريخ الميلاد: لصاحب الحساب دائماً، ولغيره فقط عند إظهارهما.
    case
      when profile.id = auth.uid() or coalesce(profile.show_city, true) then profile.city
      else null
    end as city,
    case
      when profile.id = auth.uid() or coalesce(profile.show_city, true) then profile.location
      else null
    end as location,
    case
      when profile.id = auth.uid() or coalesce(profile.show_birth_date, false) then profile.birth_date
      else null
    end as birth_date,
    profile.created_at,
    profile.updated_at
  from public.profiles as profile
  where profile.id = p_user_id
    and (
      profile.id = auth.uid()
      -- ملفات الحسابات الخاصة تُقرأ معلوماتها العامة فقط، والمنع الفعلي
      -- لمنشوراتها في سياسة posts. لا نمنع صف الملف نفسه لأن صفحة الحساب
      -- الخاص تحتاج الاسم والصورة والنبذة وزر طلب المتابعة.
      or auth.uid() is not null
    );
$$;

revoke all on function public.aani_public_profile(uuid) from public, anon;
grant execute on function public.aani_public_profile(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 1ج) إعادة تعريف aani_nearby_people بعد سحب city و city_key
--     التعريف السابق (20270201000000 سطر 100-140) SECURITY INVOKER ويقرأ
--     city و city_key بصلاحيات المستدعي، فكان سيفشل بـ42501 بعد السحب.
--     يُعاد تعريفه هنا SECURITY DEFINER (search_path = '') بنفس الدلالة،
--     مع شرط إضافي: من أخفى مدينته (show_city = false) لا يظهر في القائمة،
--     لأن إخفاء المدينة يجب أن يمنع الاستدلال عليها من القائمة.
--     يُعيد city فقط عندما يكون show_city مُفعّلاً.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null then
    raise warning 'public.profiles غير موجود — تم تخطي إعادة تعريف aani_nearby_people';
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'city_key'
  ) then
    raise warning 'العمود profiles.city_key غير موجود — تم تخطي إعادة تعريف aani_nearby_people';
    return;
  end if;

  execute $fn$
    create or replace function public.aani_nearby_people(p_limit integer default 200)
    returns table (
      id uuid,
      username text,
      full_name text,
      display_name text,
      avatar_url text,
      city text
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      with me as (
        select profile.id, profile.city_key
        from public.profiles as profile
        where profile.id = (select auth.uid())
          and coalesce(profile.show_city, true)
      )
      select
        other.id,
        other.username,
        other.full_name,
        other.display_name,
        other.avatar_url,
        case when coalesce(other.show_city, true) then other.city else null end
      from public.profiles as other
      cross join me
      where (select auth.uid()) is not null
        and other.id <> me.id
        and me.city_key is not null
        and other.city_key = me.city_key
        and coalesce(other.show_city, true)
        and coalesce(other.is_nearby_visible, true)
        and not coalesce(other.is_deactivated, false)
      order by other.created_at desc
      limit least(greatest(coalesce(p_limit, 200), 1), 500);
    $body$;
  $fn$;

  execute 'revoke all on function public.aani_nearby_people(integer) from public, anon';
  execute 'grant execute on function public.aani_nearby_people(integer) to authenticated';
end $$;

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
        'hd_uploads', 'data_saver', 'font_preference', 'fcm_token',
        'birth_date', 'city', 'location'
      )
  ) then
    raise exception 'ما زالت أعمدة profiles الخاصة أو المشروطة ممنوحة للقراءة';
  end if;

  -- ولا منح على مستوى الجدول يعيد كل الأعمدة
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
      and privilege_type = 'SELECT'
  ) then
    raise exception 'ما زال SELECT على جدول public.profiles ممنوحاً على مستوى الجدول';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) الأعمدة الممنوحة للمستخدم المسجّل (يجب ألا تظهر الخاصة ولا المشروطة)
--    select column_name
--    from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and grantee = 'authenticated' and privilege_type = 'SELECT'
--    order by column_name;
--
-- 2) لا منح SELECT على مستوى الجدول (المتوقع: صفر صفوف)
--    select grantee, privilege_type
--    from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'profiles' and privilege_type = 'SELECT';
--
-- 3) قراءة تفضيلات أو مدينة مستخدم آخر يجب أن تفشل (42501)
--    select notification_settings from public.profiles where id = '<other_user>';
--    select city from public.profiles where id = '<other_user>';
--
-- 4) الدوال تعمل للمستخدم نفسه
--    select * from public.aani_my_preferences();
--    select * from public.aani_public_profile('<my_user_id>');
--    -- ولحساب أخفى مدينته: city و location و birth_date فارغة
--    select * from public.aani_public_profile('<hidden_city_user_id>');
--
-- 5) قرار الوسائط لحساب خاص A (بصفتك غير متابع)
--    select public.aani_can_read_media_object('<object_path_of_A_post>');  -- false
