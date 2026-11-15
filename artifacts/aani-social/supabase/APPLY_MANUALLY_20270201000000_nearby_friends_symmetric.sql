-- =====================================================================
-- SQL المطلوب تنفيذه يدوياً في Supabase SQL Editor
-- =====================================================================
-- مأخوذ حرفياً من الترحيل:
--   artifacts/aani-social/supabase/migrations/20270201000000_nearby_friends_symmetric.sql
--
-- لا يُنفَّذ تلقائياً، ولم يُنفَّذ على أي قاعدة إنتاج. نفّذه بعد المراجعة،
-- ثم استخدم أمثلة التحقق في نهاية الملف.
-- آمن لإعادة التشغيل (idempotent). لا يعدّل عمود city ولا يحذف أي بيانات.
-- =====================================================================

begin;

-- 1) دالة التطبيع — IMMUTABLE لتصلح لعمود مُولَّد، وSECURITY INVOKER
--    تحذف التشكيل والتطويل والعلامات غير المرئية، وتوحّد الألف/الياء/التاء المربوطة
create or replace function public.aani_city_key(p_city text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select nullif(
    lower(
      replace(
        translate(
          btrim(
            regexp_replace(
              regexp_replace(
                coalesce(p_city, ''),
                '[\u064B-\u065F\u0670\u06D6-\u06ED\u200C\u200D\u200E\u200F]',
                '',
                'g'
              ),
              '\s+',
              ' ',
              'g'
            )
          ),
          -- أ إ آ ٱ → ا  |  ى → ي  |  ة → ه
          'أإآٱىة',
          'اااايه'
        ),
        'ـ',  -- حذف التطويل
        ''
      )
    ),
    ''
  );
$$;

revoke all on function public.aani_city_key(text) from public;
grant execute on function public.aani_city_key(text) to authenticated;

-- 2) مفتاح المدينة المُطبَّع: عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها
alter table public.profiles
  add column if not exists city_key text
  generated always as (public.aani_city_key(city)) stored;

-- 3) صلاحية القراءة على العمود الجديد فقط
grant select (city_key) on table public.profiles to authenticated;

-- 4) فهرس يخدم المقارنة المتناظرة
create index if not exists profiles_city_key_nearby_idx
  on public.profiles (city_key, created_at desc)
  where is_nearby_visible and not is_deactivated;

-- 5) دالة القراءة المتناظرة — SECURITY INVOKER (تحت RLS المستدعي)
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
-- أمثلة تحقق من تطابق مفاتيح المدن بعد التطبيع
-- =====================================================================

-- (أ) أشكال مختلفة للمدينة نفسها يجب أن تعطي مفتاحاً واحداً
with samples(raw) as (
  values
    ('الرياض'),
    (' الرياض '),
    ('الرِّيَاض'),          -- تشكيل
    ('الريــاض'),           -- تطويل
    ('الريآض'),             -- ألف ممدودة
    ('الریاض'),             -- ألف/ياء فارسية
    ('الريَاضُ')
)
select raw, public.aani_city_key(raw) as city_key
from samples;

-- (ب) تأكيد أن كل الأشكال تؤول إلى مفتاح واحد — المتوقع 1
with samples(raw) as (
  values ('الرياض'), ('الرِّيَاض'), ('الريــاض'), ('الريآض'), ('الریاض')
)
select count(distinct public.aani_city_key(raw)) as distinct_keys
from samples;

-- (ج) مدن مختلفة تبقى مختلفة — المتوقع true
select public.aani_city_key('جدة') <> public.aani_city_key('الرياض') as different;

-- (د) فحص البيانات الحقيقية: هل توجد أشكال متعددة لنفس المدينة؟
select city, public.aani_city_key(city) as city_key, count(*) as rows
from public.profiles
where city is not null and btrim(city) <> ''
group by 1, 2
order by 2, 1;

-- (هـ) التحقق أن city الأصلية لم تتغيّر (الترحيل لا يكتب على city إطلاقاً)
select count(*) as profiles_with_city from public.profiles where city is not null;

-- (و) التحقق من صلاحية الدوال
select proname, prosecdef
from pg_proc
where proname in ('aani_city_key', 'aani_nearby_people');
-- prosecdef = false للاثنتين (SECURITY INVOKER)
