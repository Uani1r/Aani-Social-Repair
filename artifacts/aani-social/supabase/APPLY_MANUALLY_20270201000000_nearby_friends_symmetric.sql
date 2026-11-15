-- =====================================================================
-- SQL المطلوب تنفيذه يدوياً في Supabase SQL Editor
-- =====================================================================
-- مأخوذ حرفياً من الترحيل:
--   artifacts/aani-social/supabase/migrations/20270201000000_nearby_friends_symmetric.sql
--
-- لا يُنفَّذ تلقائياً، ولم يُنفَّذ على أي قاعدة إنتاج. نفّذه بعد المراجعة،
-- ثم شغّل قسم التحقق في نهاية الملف.
-- آمن لإعادة التشغيل (idempotent). لا يعدّل عمود city ولا يحذف أي بيانات.
-- =====================================================================

begin;

-- 1) دالة التطبيع — IMMUTABLE لتصلح لعمود مُولَّد، وSECURITY INVOKER
--    حذف التشكيل والعلامات غير المرئية والتطويل، وتوحيد:
--      أ إ آ ٱ → ا  |  ى → ي  |  ة → ه  |  ی U+06CC → ي  |  ک U+06A9 → ك
--    الخرائط مكتوبة بصيغة U&'\XXXX' (رموز Unicode صريحة) لتفادي أي التباس
--    بين الحرف العربي والحرف الفارسي المتشابهين في الشكل.
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
          -- المصدر: أ U+0623، إ U+0625، آ U+0622، ٱ U+0671،
          --         ى U+0649، ة U+0629، ی U+06CC (فارسية)، ک U+06A9 (فارسية)
          U&'\0623\0625\0622\0671\0649\0629\06CC\06A9',
          -- الهدف: ا ا ا ا ي ه ي ك
          U&'\0627\0627\0627\0627\064A\0647\064A\0643'
        ),
        U&'\0640',  -- التطويل
        ''
      )
    ),
    ''
  );
$$;

-- الصلاحيات: الواجهة (authenticated) والكتابة الخلفية (service_role)
revoke all on function public.aani_city_key(text) from public, anon;
grant execute on function public.aani_city_key(text) to authenticated, service_role;

-- 2) مفتاح المدينة المُطبَّع: عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها
alter table public.profiles
  add column if not exists city_key text
  generated always as (public.aani_city_key(city)) stored;

-- 2ب) إعادة احتساب القيم المخزّنة إن كانت نسخة أقدم من الدالة قد طُبّقت
--     (العمود مُولَّد ويُحسب عند الكتابة). city تُكتب كما هي بلا أي تغيير.
update public.profiles
   set city = city
 where city_key is distinct from public.aani_city_key(city);

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
-- اختبار (1): الرياض والرِّيَاض والريــاض والریاض → مفتاح واحد
-- =====================================================================
-- تُبنى الأشكال من الأساس نفسه بـ U&'\XXXX' لضمان الحروف المقصودة فعلياً:
--   الأساس: الرياض = U+0627 U+0644 U+0631 U+064A U+0627 U+0636
--   التشكيل: كسرة قبل الياء وفتحة بعدها
--   التطويل: ــ U+0640 بعد الياء
--   الياء الفارسية: استبدال U+064A بـ U+06CC
with base as (
  select U&'\0627\0644\0631\064A\0627\0636'::text as city
),
variants(label, raw) as (
  select 'عادي', city from base
  union all
  select 'تشكيل', replace(city, U&'\064A', U&'\0650\064A\064E') from base
  union all
  select 'تطويل', replace(city, U&'\064A', U&'\064A\0640\0640') from base
  union all
  select 'ياء فارسية', replace(city, U&'\064A', U&'\06CC') from base
)
select label, raw, public.aani_city_key(raw) as city_key
from variants
order by label;

-- المتوقع: distinct_keys = 1 (كل الأشكال تؤول إلى مفتاح واحد)
with base as (
  select U&'\0627\0644\0631\064A\0627\0636'::text as city
),
variants(raw) as (
  select city from base
  union all select replace(city, U&'\064A', U&'\0650\064A\064E') from base
  union all select replace(city, U&'\064A', U&'\064A\0640\0640') from base
  union all select replace(city, U&'\064A', U&'\06CC') from base
)
select count(distinct public.aani_city_key(raw)) as distinct_keys
from variants;

-- =====================================================================
-- اختبار (2): الكاف الفارسية تُوحَّد أيضاً
-- =====================================================================
-- كركوك = U+0643 U+0631 U+0643 U+0648 U+0643
-- کرکوك بالكاف الفارسية = U+06A9 U+0631 U+06A9 U+0648 U+0643
-- المتوقع: kaf_unified = true
select
  public.aani_city_key(U&'\06A9\0631\06A9\0648\0643')
    = public.aani_city_key(U&'\0643\0631\0643\0648\0643') as kaf_unified;

-- =====================================================================
-- اختبار (3): المدن المختلفة لا تتطابق
-- =====================================================================
-- جدة = U+062C U+062F U+0629  |  الرياض = U+0627 U+0644 U+0631 U+064A U+0627 U+0636
-- المتوقع: different = true
select
  public.aani_city_key(U&'\062C\062F\0629')
    <> public.aani_city_key(U&'\0627\0644\0631\064A\0627\0636') as different;

-- =====================================================================
-- اختبار (4): صلاحيات الدالتين
-- =====================================================================
-- المتوقع:
--   aani_city_key      : authenticated=true,  service_role=true,  anon=false
--   aani_nearby_people : authenticated=true,  service_role=false, anon=false
select
  p.proname,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_execute,
  has_function_privilege('anon', p.oid, 'execute') as anon_execute
from pg_proc p
where p.proname in ('aani_city_key', 'aani_nearby_people')
order by p.proname;

-- =====================================================================
-- اختبار (5): بيانات حقيقية — أشكال متعددة لنفس المدينة
-- =====================================================================
select city, public.aani_city_key(city) as city_key, count(*) as rows
from public.profiles
where city is not null and btrim(city) <> ''
group by 1, 2
order by 2, 1;

-- أي صفين لهما city مختلفان و city_key واحد = شكلان لنفس المدينة (مطلوب)
-- أي صفين لنفس المدينة منطقياً و city_key مختلفان = تطبيع ناقص يستحق المراجعة

-- =====================================================================
-- اختبار (6): city الأصلية لم تتغيّر
-- =====================================================================
select count(*) as profiles_with_city from public.profiles where city is not null;

-- =====================================================================
-- اختبار (7): الدالتان SECURITY INVOKER (prosecdef = false)
-- =====================================================================
select proname, prosecdef
from pg_proc
where proname in ('aani_city_key', 'aani_nearby_people')
order by proname;
