-- ============================================================================
-- خصوصية حقل المهنة (public.profiles.job)
--
-- المشكلة:
--   * job كان ضمن الأعمدة الممنوحة للقراءة المباشرة لـ authenticated، فقراءة
--     الصف عبر PostgREST تُعيد المهنة حتى لو كان show_job = false.
--   * show_job كان يُطبَّق في الواجهة فقط، وaani_public_profile(uuid) تُعيد
--     profile.job مباشرة بلا شرط.
--
-- الإصلاح:
--   1) سحب قراءة العمود job مباشرةً من PUBLIC و anon و authenticated
--      (بنفس نمط 20270206000000: منح/سحب على مستوى العمود). منح UPDATE لا يُمس،
--      فيبقى تعديل المهنة من الملف الشخصي والإعدادات يعمل.
--   2) إعادة تعريف aani_public_profile(uuid): تُعيد job لصاحب الحساب دائماً،
--      ولغيره فقط عندما coalesce(show_job, false) = true، وإلا NULL.
--
-- لا تغيير في البيانات ولا في السياسات، ولا في أي عمود آخر (show_job يبقى
-- مقروءاً حتى تعرف الواجهة ما تعرضه). service_role لم تُمنح job في
-- 20270206000000 أصلاً، فلا تغيير عليه.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة
-- ============================================================================
do $$
declare
  v_function regprocedure := to_regprocedure('public.aani_public_profile(uuid)');
begin
  if to_regclass('public.profiles') is null then
    raise exception 'aani: public.profiles غير موجود. أوقف الترحيل.'
      using errcode = '42P01';
  end if;

  if not exists (
    select 1 from pg_attribute as att
    where att.attrelid = 'public.profiles'::regclass
      and att.attname = 'job'
      and att.attnum > 0
      and not att.attisdropped
  ) then
    raise exception 'aani: العمود public.profiles.job غير موجود. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if not exists (
    select 1 from pg_attribute as att
    where att.attrelid = 'public.profiles'::regclass
      and att.attname = 'show_job'
      and att.attnum > 0
      and not att.attisdropped
  ) then
    raise exception 'aani: العمود public.profiles.show_job غير موجود. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if v_function is null then
    raise exception 'aani: public.aani_public_profile(uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) سحب قراءة العمود job من الأعمدة الممنوحة مباشرة
--    (revoke على مستوى العمود لكل دور؛ منح UPDATE لا يُمس.)
-- ============================================================================
revoke select (job) on table public.profiles from public;
revoke select (job) on table public.profiles from anon;
revoke select (job) on table public.profiles from authenticated;

-- منح صريح لباقي الأعمدة العامة يبقى كما هو من 20270206000000؛ لا نعيد منح
-- شيء هنا حتى لا نُعيد job بالخطأ عند إعادة التشغيل.

-- ----------------------------------------------------------------------------
-- 2) إعادة تعريف aani_public_profile: شرط show_job على قيمة job
-- ============================================================================
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
    -- المهنة: لصاحب الحساب دائماً، ولغيره فقط عندما show_job = true.
    case
      when profile.id = auth.uid() or coalesce(profile.show_job, false) then profile.job
      else null
    end as job,
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
      or auth.uid() is not null
    );
$$;

revoke all on function public.aani_public_profile(uuid) from public, anon;
grant execute on function public.aani_public_profile(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3) تحقق بعد التعديل: القراءة المباشرة مسحوبة، وشرط الإظهار مثبت
-- ============================================================================
do $$
declare
  v_definition text;
  v_prepared_definition text;
begin
  -- (أ) لا قراءة مباشرة لعمود job لأي دور غير موثوق
  if has_column_privilege('anon', 'public.profiles', 'job', 'SELECT') then
    raise exception 'aani: ما زال anon يقرأ public.profiles.job مباشرة.'
      using errcode = '42501';
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'job', 'SELECT') then
    raise exception 'aani: ما زال authenticated يقرأ public.profiles.job مباشرة.'
      using errcode = '42501';
  end if;

  -- منح على مستوى الجدول كان سيُعيد job ضمناً
  if has_table_privilege('anon', 'public.profiles', 'SELECT') then
    raise exception 'aani: anon يملك SELECT على كامل public.profiles — سيقرأ job.'
      using errcode = '42501';
  end if;

  if has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    raise exception 'aani: authenticated يملك SELECT على كامل public.profiles — سيقرأ job.'
      using errcode = '42501';
  end if;

  -- (ب) بقية الأعمدة العامة، بما فيها show_job، ما زالت مقروءة
  if not has_column_privilege('authenticated', 'public.profiles', 'show_job', 'SELECT') then
    raise exception 'aani: authenticated فقد قراءة show_job — الواجهة لا تستطيع تحديد الإظهار.'
      using errcode = '42501';
  end if;

  if not has_column_privilege('authenticated', 'public.profiles', 'bio', 'SELECT') then
    raise exception 'aani: authenticated فقد قراءة عمود عام آخر (bio) — السحب أوسع من المطلوب.'
      using errcode = '42501';
  end if;

  -- (ج) الدالة تعيد job عبر شرط صريح على show_job
  select pg_get_functiondef('public.aani_public_profile(uuid)'::regprocedure) into v_definition;

  if v_definition is null then
    raise exception 'aani: تعذرت قراءة تعريف aani_public_profile.'
      using errcode = '42501';
  end if;

  -- نُطبّع المسافات لأن المخطط قد يخزّن التعريف بصيغة مختلفة قليلاً
  v_prepared_definition := regexp_replace(lower(v_definition), '\s+', ' ', 'g');

  if position('coalesce(profile.show_job, false)' in v_prepared_definition) = 0 then
    raise exception 'aani: aani_public_profile لا تطبّق شرط show_job على job.'
      using errcode = '42501';
  end if;

  if position('profile.id = auth.uid()' in v_prepared_definition) = 0 then
    raise exception 'aani: aani_public_profile لا تُعيد job لصاحب الحساب دائماً.'
      using errcode = '42501';
  end if;

  -- (د) الدالة نفسها ما زالت مقيدة على authenticated فقط
  if has_function_privilege('anon', 'public.aani_public_profile(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: anon يملك EXECUTE على aani_public_profile.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_public_profile(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'aani: authenticated فقد EXECUTE على aani_public_profile.'
      using errcode = '42501';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select has_column_privilege('authenticated', 'public.profiles', 'job', 'SELECT');   -- false
-- select has_column_privilege('authenticated', 'public.profiles', 'show_job', 'SELECT'); -- true
-- select job from public.aani_public_profile(auth.uid());
