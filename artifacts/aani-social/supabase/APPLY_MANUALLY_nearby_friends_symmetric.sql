-- =====================================================================
-- SQL المطلوب تنفيذه يدوياً في Supabase SQL Editor
-- =====================================================================
-- مأخوذ حرفياً من الترحيل:
--   artifacts/aani-social/supabase/migrations/20270132000000_nearby_friends_symmetric.sql
--
-- لا يُنفَّذ تلقائياً، ولم يُنفَّذ على أي قاعدة إنتاج. نفّذه بعد المراجعة،
-- ثم تحقق بالاستعلامات الموجودة في نهاية الملف.
-- آمن لإعادة التشغيل (idempotent).
-- =====================================================================

begin;

-- 1) مفتاح المدينة المُطبَّع: عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها
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

-- 2) صلاحية القراءة على العمود الجديد فقط (profiles يمنح select بالأعمدة)
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

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- تحقق بعد التنفيذ (منفصل):
--
-- 1) العمود والدالة:
--   select proname, prosecdef from pg_proc where proname = 'aani_nearby_people';
--   -- prosecdef = false  → SECURITY INVOKER
--
-- 2) مفاتيح المدينة لملفّين كانا لا يظهران لبعضهما:
--   select id, city, city_key from public.profiles where city is not null limit 20;
--
-- 3) تناظر النتيجة (نفّذها بهوية كل حساب، مثلاً عبر استعلام كعميل مصادق):
--   select count(*) from public.aani_nearby_people(200);
-- =====================================================================
