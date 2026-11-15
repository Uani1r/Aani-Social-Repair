-- =====================================================================
-- إصلاح «الأشخاص القريبون» — تناظر الظهور بين الحسابات المؤهلة
-- =====================================================================
-- لا جدول مواقع جديد: الميزة المعتمدة في هذا المشروع تعتمد على
-- public.profiles.city (ويُستخدم location كاحتياط للقراءة فقط)، مع
-- is_nearby_visible و is_deactivated. هذا الملف يضيف مفتاح مدينة مُطبَّع
-- ودالة قراءة متناظرة، بلا أي تعديل على بنية الأعمدة القائمة وبلا حذف بيانات.
--
-- سبب الخلل: المقارنة كانت نصية حرفية (city = '…')، فأي فرق في المسافات أو
-- التشكيل أو همزات الألف/الياء/التاء المربوطة بين ملفّين لنفس المدينة يجعل
-- أحدهما يرى الآخر دون العكس (أو لا يراه أحدهما إطلاقاً)، إضافة إلى أن حدّ
-- النتائج 60 كان يقتطع جزءاً من القائمة عند ازدحام المدينة.
--
-- آمن لإعادة التشغيل: كل الخطوات add column if not exists / create index if
-- not exists / create or replace / grant (idempotent).
-- =====================================================================

begin;

-- 1) مفتاح المدينة المُطبَّع (عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها)
alter table public.profiles
  add column if not exists city_key text
  generated always as (
    nullif(
      lower(
        translate(
          btrim(regexp_replace(coalesce(city, ''), '\s+', ' ', 'g')),
          'أإآىةـ',
          'ااايه'
        )
      ),
      ''
    )
  ) stored;

-- 2) صلاحية القراءة على العمود الجديد فقط (لا توسيع لبقية الأعمدة)
grant select (city_key) on table public.profiles to authenticated;

-- 3) فهرس يخدم المقارنة المتناظرة
create index if not exists profiles_city_key_nearby_idx
  on public.profiles (city_key, created_at desc)
  where is_nearby_visible and not is_deactivated;

-- 4) دالة القراءة المتناظرة — SECURITY INVOKER (تحت RLS المستدعي)
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
security invoker
set search_path = ''
as $$
  with me as (
    select profile.id, profile.city_key
    from public.profiles as profile
    where profile.id = (select auth.uid())
  )
  select
    other.id,
    other.username,
    other.full_name,
    other.display_name,
    other.avatar_url,
    other.city
  from public.profiles as other
  cross join me
  where (select auth.uid()) is not null
    and other.id <> me.id
    and me.city_key is not null
    and other.city_key = me.city_key
    and coalesce(other.is_nearby_visible, true)
    and not coalesce(other.is_deactivated, false)
  order by other.created_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

revoke all on function public.aani_nearby_people(integer) from public, anon;
grant execute on function public.aani_nearby_people(integer) to authenticated;

-- 5) تحديث كاش PostgREST فوراً
notify pgrst, 'reload schema';

commit;
