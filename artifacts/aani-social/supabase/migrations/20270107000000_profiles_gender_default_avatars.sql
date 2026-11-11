-- عمود الجنس في الملف الشخصي + الأيقونة الافتراضية حسب الجنس:
-- ذكر (male) / أنثى (female). الذكر هو الافتراضي لكل الحسابات القديمة
-- وعند غياب الاختيار. يُقرأ الجنس المختار عند إنشاء الحساب من بيانات
-- المستخدم (raw_user_meta_data.gender) التي يرسلها نموذج التسجيل.
begin;

alter table public.profiles
  add column if not exists gender text not null default 'male'
    check (gender in ('male', 'female'));

-- دالة إنشاء الملف الشخصي: تقرأ الجنس المختار عند التسجيل
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

  insert into public.profiles (id, username, full_name, gender)
  values (
    new.id,
    left(requested_username, 32),
    left(requested_full_name, 120),
    requested_gender
  )
  on conflict (id) do update set gender = excluded.gender;

  return new;
end;
$$;

commit;
