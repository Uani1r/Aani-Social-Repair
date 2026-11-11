-- الرؤية في شاشة «الأشخاص القريبون» + التحديد الإجباري التلقائي للموقع عند التسجيل:
-- 1) عمود is_nearby_visible (boolean, default true): مفتاح الظهور في قائمة
--    الأشخاص القريبين — عند false يختفي المستخدم من قائمة الأشخاص
--    القريبين عند جميع المستخدمين الآخرين.
-- 2) مدينة التسجيل: تُقرأ من raw_user_meta_data.city التي يرسلها نموذج
--    التسجيل بعد استخراجها تلقائياً من موقع الجهاز (Geolocation API)،
--    وتُخزن في profiles.city و profiles.location.
begin;

-- 1) مفتاح الظهور في الأشخاص القريبين
alter table public.profiles
  add column if not exists is_nearby_visible boolean not null default true;

-- الصلاحيات: جدول profiles يُمنح select بأعمدة محددة — أضف العمود الجديد
-- (وأعمدة المدينة احتياطاً) للقراءة، ومنح التحديث على عمود المفتاح وأعمدة المدينة.
grant select (is_nearby_visible, city, location) on table public.profiles to authenticated;
grant update (is_nearby_visible, city, location) on table public.profiles to authenticated;

-- فهرس جزئي يخدم استعلام القائمة: city = مدينتي و is_nearby_visible = true
create index if not exists profiles_nearby_visible_city_idx
  on public.profiles (city, created_at desc)
  where is_nearby_visible;

-- 2) دالة إنشاء الملف الشخصي: تقرأ الجنس ومدينة التسجيل القادمة من موقع الجهاز
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_full_name text;
  requested_gender text;
  requested_city text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''),
    '[^a-z0-9_.]',
    '',
    'g'
  ));
  if char_length(requested_username) < 3 then
    requested_username := replace(new.id::text, '-', '');
  end if;

  requested_full_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Member'
  );

  requested_gender := coalesce(new.raw_user_meta_data ->> 'gender', 'male');
  if requested_gender not in ('male', 'female') then
    requested_gender := 'male';
  end if;

  -- مدينة التسجيل المستخرجة تلقائياً من موقع الجهاز (إجبارية عند التسجيل)
  requested_city := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')), '');

  insert into public.profiles (id, username, full_name, gender, city, location)
  values (
    new.id,
    left(requested_username, 32),
    left(requested_full_name, 120),
    requested_gender,
    requested_city,
    requested_city
  )
  on conflict (id) do update set
    gender = excluded.gender,
    city = coalesce(excluded.city, public.profiles.city),
    location = coalesce(excluded.location, public.profiles.location);

  return new;
end;
$$;

commit;
