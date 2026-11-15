-- =====================================================================
-- إصلاح «الأشخاص القريبون» — تناظر الظهور بين الحسابات المؤهلة
-- =====================================================================
-- لا جدول مواقع جديد: الميزة المعتمدة في هذا المشروع تعتمد على
-- public.profiles.city (ويُستخدم location كاحتياط للقراءة فقط)، مع
-- is_nearby_visible و is_deactivated. هذا الملف يضيف مفتاح مدينة مُطبَّع
-- ودالة قراءة متناظرة، بلا أي تعديل على بنية الأعمدة القائمة وبلا حذف بيانات.
--
-- سبب الخلل: المقارنة كانت نصية حرفية (city = '…')، فأي فرق في التشكيل أو
-- المسافات أو التطويل أو أشكال الحروف (الألف/الياء/الكاف/التاء المربوطة)
-- بين ملفّين لنفس المدينة يجعل أحدهما يرى الآخر دون العكس، إضافة إلى أن حدّ
-- النتائج 60 كان يقتطع جزءاً من القائمة عند ازدحام المدينة.
--
-- التطبيع في aani_city_key يشمل:
--   1) حذف التشكيل العربي (U+064B–U+065F) والعلامات القرآنية (U+06D6–U+06ED)
--      والألف الخنجرية (U+0670) ومحارف الاتجاه/الوصل غير المرئية.
--   2) حذف التطويل (ـ U+0640).
--   3) توحيد أشكال الألف (أ إ آ ٱ → ا) والياء (ى → ي) والتاء المربوطة (ة → ه).
--   4) توحيد الحروف الفارسية مع العربية:
--        ی (U+06CC ياء فارسية) → ي (U+064A)
--        ک (U+06A9 كاف فارسية) → ك (U+0643)
--   5) lower + توحيد المسافات المتعددة + btrim.
-- عمود city الأصلي لا يُعدَّل إطلاقاً: التطبيع في عمود مُولَّد فقط.
--
-- ملاحظة تنفيذية: خرائط translate مكتوبة بصيغة U&'\XXXX' (رموز Unicode صريحة)
-- حتى لا تعتمد على ترميز ملف أو على شكل الحرف كما يُنسخ من محرر نصي.
--
-- الصلاحيات: الدالة تطبيع نصي بحت. تُمنح EXECUTE لـ authenticated
-- (استخدام الواجهة) ولـ service_role (عمليات الكتابة الخلفية على profiles
-- التي تُعيد احتساب العمود المُولَّد)، مع سحبها من PUBLIC و anon.
--
-- آمن لإعادة التشغيل: create or replace / add column if not exists /
-- create index if not exists / grant (idempotent).
-- =====================================================================

begin;

-- 1) دالة التطبيع — IMMUTABLE لتصلح لعمود مُولَّد، وSECURITY INVOKER
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

revoke all on function public.aani_city_key(text) from public, anon;
grant execute on function public.aani_city_key(text) to authenticated, service_role;

-- 2) مفتاح المدينة المُطبَّع (عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها)
alter table public.profiles
  add column if not exists city_key text
  generated always as (public.aani_city_key(city)) stored;

-- 2ب) إعادة احتساب القيم المخزّنة إن كانت نسخة أقدم من الدالة قد طُبّقت:
--     العمود مُولَّد، والقيمة تُحسب عند الكتابة فقط. لا تغيير في قيمة city
--     نفسها (تُكتب كما هي) — التحديث محصور في الصفوف التي مفتاحها قديم.
update public.profiles
   set city = city
 where city_key is distinct from public.aani_city_key(city);

-- 3) صلاحية القراءة على العمود الجديد فقط (لا توسيع لبقية الأعمدة)
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

-- 6) تحديث كاش PostgREST فوراً
notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- اختبارات التحقق — نسختها التنفيذية الجاهزة في
-- APPLY_MANUALLY_20270201000000_nearby_friends_symmetric.sql
-- =====================================================================
-- (1) الرياض / الرِّيَاض / الريــاض / الریاض (ياء فارسية) → مفتاح واحد
-- (2) الكاف الفارسية: aani_city_key('کرکوك') = aani_city_key('كركوك')
-- (3) مدن مختلفة لا تتطابق
-- (4) الصلاحيات: aani_city_key → authenticated=true, service_role=true,
--     anon=false | aani_nearby_people → authenticated=true, anon=false
-- =====================================================================
