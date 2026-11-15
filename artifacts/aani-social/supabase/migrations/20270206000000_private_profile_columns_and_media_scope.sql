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
--    أو لدور آخر (anon / authenticator / service_role / custom roles). لذلك:
--      أ) يُسحب SELECT على الجدول من PUBLIC و anon و authenticated و service_role
--         وكل دور يملكه فعلاً (فحص information_schema.role_table_grants)،
--         مع استثناء مالك الجدول و postgres و supabase_admin.
--      ب) تُمنح قائمة الأعمدة العامة صراحةً لـ authenticated فقط.
--      ج) تُسحب الأعمدة الخاصة من كل دور آخر يملكها.
--
--    الأعمدة المسحوبة: التفضيلات الشخصية + fcm_token + birth_date + city +
--    location (الأخيران محكومان بـ show_city، و birth_date بـ show_birth_date).
--
--    service_role: يُسحب منه منح الجدول أيضاً — قاعدة الإنتاج تمنحه SELECT على
--    profiles بالكامل، وهذا ما يجعله يقرأ كل الأعمدة. يُسحب منح الجدول، وتُسحب
--    كل الأعمدة، ثم يُمنح **فقط** ما تحتاجه الخوادم فعلياً:
--      * fcm_token, notification_settings — إشعارات الدفع:
--        api-server/src/lib/supabaseAdmin.ts و
--        supabase/functions/send-push-notification/index.ts
--      * id — تسجيل الدخول باسم المستخدم:
--        supabase/functions/login-with-username/index.ts
--      * avatar_url, cover_url — فحص مراجع الوسائط قبل حذفها:
--        api-server/src/lib/mediaDb.ts (mediaInActiveUse)
--    أي عمود آخر (birth_date, city, location, التفضيلات، الجنس، النبذة...)
--    لم يعد مقروءاً حتى بمفتاح الخدمة، فلا يمكن تسريبه من أي مسار خلفي.
--    مالك الجدول و postgres و supabase_admin لا تُمس.
-- ---------------------------------------------------------------------
do $$
declare
  private_column_names text[] := array[
    'notification_settings', 'appearance_preference', 'language_preference',
    'hd_uploads', 'data_saver', 'font_preference', 'fcm_token',
    'birth_date', 'city', 'location'
  ];
  -- ما تحتاجه الخوادم فعلياً (مُوثّق أعلاه بالملفات).
  server_column_names text[] := array[
    'id', 'fcm_token', 'notification_settings', 'avatar_url', 'cover_url'
  ];
  -- مالك الجدول و أدوار الإدارة فقط. service_role ليس محمياً: يُقيَّد صراحةً.
  protected_roles text[] := array['postgres', 'supabase_admin'];
  grantee_name text;
  private_columns text;
  public_columns text;
  server_columns text;
  other_columns text;
begin
  -- أ) كل دور يملك SELECT على الجدول (بما فيه PUBLIC و anon و authenticated
  --    و authenticator و service_role و أي دور مخصص)، مع استثناء أدوار الإدارة.
  for grantee_name in
    select distinct grant.grantee
    from information_schema.role_table_grants as grant
    where grant.table_schema = 'public'
      and grant.table_name = 'profiles'
      and grant.privilege_type = 'SELECT'
      and grant.grantee <> current_user
      and grant.grantee <> all(protected_roles)
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
      and privilege.grantee <> all(protected_roles)
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

  -- د) service_role: لا منح جدولي، ولا أعمدة إلا ما تحتاجه الخوادم.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- منح الجدول قد يكون عاد من الدور أعلاه أو من منح سابق: يُسحب صراحةً.
    execute 'revoke select on table public.profiles from service_role';

    select string_agg(quote_ident(column_name), ', ' order by column_name)
    into server_columns
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = any(server_column_names);

    if server_columns is null then
      raise exception 'أعمدة الخادم المطلوبة مفقودة في public.profiles — راجع المخطط';
    end if;

    -- كل عمود لا يحتاجه الخادم يُسحب من service_role.
    select string_agg(quote_ident(column_name), ', ' order by column_name)
    into other_columns
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name <> all(server_column_names);

    if other_columns is not null then
      execute format('revoke select (%s) on table public.profiles from service_role', other_columns);
    end if;

    execute format('grant select (%s) on table public.profiles to service_role', server_columns);

    raise notice 'أعمدة profiles الممنوحة لـservice_role: %', server_columns;
  end if;
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

-- service_role مُقيَّد في القسم 1 (منح الجدول مسحوب، وكل عمود غير مطلوب
-- مسحوب، ثم مُنح ما تحتاجه الخوادم فقط). لا منح إضافي هنا حتى لا يوجد
-- مصدران للحقيقة يتعارضان عند إعادة التشغيل.

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
--      * وسائط قصة: عبر aani_can_view_story (إن وُجدت).
--      * وسائط أبرز القصص: عبر aani_can_view_profile_highlight — **فقط إن
--        كانت جداولها ودالتها موجودة**، لأن قاعدة بُنيت من schema.sql لا
--        تحتوي profile_highlights ولا profile_highlight_collections.
--    كل ما عدا ذلك false.
--
--    المطابقة على مسار الملف بالضبط لا بـLIKE: تُطبَّع القيمة المخزّنة
--    (رابط كامل أو مسار) إلى مسار بلا مخطط/مضيف/استعلام، ثم تُقارن بالتساوي،
--    فلا يمكن لـ % أو _ في p_object_name أن يطابق ملفات أخرى.
-- ---------------------------------------------------------------------

-- يُطبّع رابطاً أو مساراً إلى مسار كائن قابل للمقارنة:
--   https://ik.imagekit.io/abc/posts/a.jpg?tr=q-auto          → abc/posts/a.jpg
--   https://<proj>.supabase.co/storage/v1/object/public/aani-media/u/a.jpg → u/a.jpg
--   /u/a.jpg                                                  → u/a.jpg
create or replace function public.aani_media_path(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    ltrim(
      regexp_replace(
        regexp_replace(
          split_part(split_part(btrim(coalesce(p_value, '')), '#', 1), '?', 1),
          '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+',
          ''
        ),
        '^/?storage/v1/object/(public|sign)/[^/]+/',
        ''
      ),
      '/'
    ),
    ''
  );
$$;

revoke all on function public.aani_media_path(text) from public, anon;
grant execute on function public.aani_media_path(text) to authenticated;

do $$
declare
  body text;
  has_story_check boolean;
  has_highlight_check boolean;
  has_highlight_collections boolean;
begin
  select to_regclass('public.stories') is not null
     and exists (
       select 1 from pg_proc as proc
       join pg_namespace as namespace on namespace.oid = proc.pronamespace
       where namespace.nspname = 'public' and proc.proname = 'aani_can_view_story'
     )
  into has_story_check;

  select to_regclass('public.profile_highlights') is not null
     and exists (
       select 1 from pg_proc as proc
       join pg_namespace as namespace on namespace.oid = proc.pronamespace
       where namespace.nspname = 'public' and proc.proname = 'aani_can_view_profile_highlight'
     )
  into has_highlight_check;

  has_highlight_collections := has_highlight_check
    and to_regclass('public.profile_highlight_collections') is not null;

  body := $body$
    select coalesce(
      auth.uid() is not null
      and public.aani_media_path(p_object_name) is not null
      and (
        -- رفعات المستخدم نفسه: أول مقطع من المسار هو معرّفه
        split_part(public.aani_media_path(p_object_name), '/', 1) = auth.uid()::text
        -- صورة أو غلاف ملف شخصي (معلومة عامة)
        or exists (
          select 1
          from public.profiles as profile
          where public.aani_media_path(profile.avatar_url) = public.aani_media_path(p_object_name)
             or public.aani_media_path(profile.cover_url) = public.aani_media_path(p_object_name)
        )
        -- وسائط منشور (صورة، فيديو، أو صوته)
        or exists (
          select 1
          from public.posts as post
          where (
              public.aani_media_path(post.media_url) = public.aani_media_path(p_object_name)
              or public.aani_media_path(post.audio_url) = public.aani_media_path(p_object_name)
              or exists (
                select 1
                from unnest(coalesce(post.media_urls, '{}'::text[])) as media_url
                where public.aani_media_path(media_url) = public.aani_media_path(p_object_name)
              )
            )
            and public.aani_can_read_post(post.id, auth.uid())
        )
  $body$;

  if has_story_check then
    body := body || $body$
        -- وسائط قصة
        or exists (
          select 1
          from public.stories as story
          where public.aani_media_path(story.media_url) = public.aani_media_path(p_object_name)
            and public.aani_can_view_story(story.id, auth.uid())
        )
    $body$;
  end if;

  if has_highlight_check then
    body := body || $body$
        -- وسائط أبرز القصص
        or exists (
          select 1
          from public.profile_highlights as highlight
          where public.aani_media_path(highlight.media_url) = public.aani_media_path(p_object_name)
            and public.aani_can_view_profile_highlight(highlight.user_id, highlight.is_close_friends)
        )
    $body$;
  end if;

  if has_highlight_collections then
    body := body || $body$
        -- أغلفة مجموعات أبرز القصص
        or exists (
          select 1
          from public.profile_highlight_collections as collection
          where public.aani_media_path(collection.cover_url) = public.aani_media_path(p_object_name)
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
    $body$;
  end if;

  body := body || '      ), false);';

  if not has_story_check then
    raise warning 'stories أو aani_can_view_story غائبة: وسائط القصص خارج قرار الوسائط';
  end if;
  if not has_highlight_check then
    raise warning 'جداول أبرز القصص غائبة: aani_can_read_media_object لا تغطّي وسائطها';
  end if;

  execute format(
    'create or replace function public.aani_can_read_media_object(p_object_name text) returns boolean language sql stable security definer set search_path = '''' as %L',
    body
  );
end $$;

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

  -- خادم الإشعارات يجب أن يبقى قادراً على قراءة العمودين اللذين يحتاجهما
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- لا منح SELECT جدولي لـservice_role (وإلا قرأ كل الأعمدة)
    if exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'profiles'
        and grantee = 'service_role'
        and privilege_type = 'SELECT'
    ) then
      raise exception 'service_role ما زال يملك SELECT على جدول public.profiles بالكامل';
    end if;

    -- الأعمدة الممنوحة له هي المطلوبة بالضبط: لا أكثر ولا أقل
    if exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'profiles'
        and grantee = 'service_role'
        and privilege_type = 'SELECT'
        and column_name <> all(array[
          'id', 'fcm_token', 'notification_settings', 'avatar_url', 'cover_url'
        ])
    ) then
      raise exception 'service_role يملك قراءة أعمدة profiles إضافية غير مطلوبة';
    end if;

    if (
      select count(distinct column_name)
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'profiles'
        and grantee = 'service_role'
        and privilege_type = 'SELECT'
        and column_name in (
          'id', 'fcm_token', 'notification_settings', 'avatar_url', 'cover_url'
        )
    ) <> 5 then
      raise exception 'service_role فقد قراءة عمود يحتاجه الخادم (fcm_token/notification_settings/id/avatar_url/cover_url) — الإشعارات أو تسجيل الدخول أو حذف الوسائط ستتعطل';
    end if;
  end if;

  -- أدوار الإدارة ومالك الجدول لم تتأثر
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    if not has_table_privilege('postgres', 'public.profiles', 'SELECT') then
      raise exception 'postgres فقد SELECT على public.profiles — يجب ألا يتأثر';
    end if;
  end if;

  -- الدالة تقرأ مسارات الملفات وتحتاج المساعد
  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_media_path'
  ) then
    raise exception 'الدالة المساعدة public.aani_media_path مفقودة';
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
-- 2) لا منح SELECT على مستوى الجدول لأي دور متصل (المتوقع: صفر صفوف،
--    أو صف postgres فقط إن كان ممنوحاً صراحةً)
--    select grantee, privilege_type
--    from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'profiles' and privilege_type = 'SELECT';
--
-- 2ب) service_role: الأعمدة الخمسة فقط (لا جدول، لا أعمدة زائدة)
--    select column_name
--    from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and grantee = 'service_role' and privilege_type = 'SELECT'
--    order by column_name;
--    -- المتوقع: avatar_url, cover_url, fcm_token, id, notification_settings
--
-- 2ج) service_role لا يقرأ عموداً شخصياً (يجب أن يفشل 42501)
--    set role service_role;
--    select city from public.profiles limit 1;
--    reset role;
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
