-- =====================================================================
-- إصلاح «الأشخاص القريبون» — تناظر الظهور بين الحسابات المؤهلة
-- =====================================================================
-- لا جدول مواقع جديد: الميزة المعتمدة في هذا المشروع تعتمد على
-- public.profiles.city (ويُستخدم location كاحتياط للقراءة فقط)، مع
-- is_nearby_visible و is_deactivated. هذا الملف يضيف مفتاح مدينة مُطبَّع
-- ودالة قراءة متناظرة، بلا أي تعديل على بنية الأعمدة القائمة وبلا حذف بيانات.
--
-- سبب الخلل: المقارنة كانت نصية حرفية (city = '…')، فأي فرق في التشكيل أو
-- المسافات أو التطويل أو همزات الألف/الياء/التاء المربوطة بين ملفّين لنفس
-- المدينة يجعل أحدهما يرى الآخر دون العكس، إضافة إلى أن حدّ النتائج 60 كان
-- يقتطع جزءاً من القائمة عند ازدحام المدينة.
--
-- التطبيع في aani_city_key يشمل:
--   1) حذف التشكيل العربي (U+064B–U+065F) والعلامات القرآنية (U+06D6–U+06ED)
--      والألف الخنجرية (U+0670) ومحارف الاتجاه/الوصل غير المرئية.
--   2) حذف التطويل (ـ U+0640).
--   3) توحيد أشكال الألف (أ إ آ ٱ → ا) والياء (ى → ي) والتاء المربوطة (ة → ه).
--   4) lower + توحيد المسافات المتعددة + btrim.
-- عمود city الأصلي لا يُعدَّل إطلاقاً: التطبيع في عمود مُولَّد فقط.
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

-- 2) مفتاح المدينة المُطبَّع (عمود مُولَّد لا يُكتب يدوياً، لا يمسّ city نفسها)
alter table public.profiles
  add column if not exists city_key text
  generated always as (public.aani_city_key(city)) stored;

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
-- أمثلة تحقق من تطابق المفاتيح بعد التطبيع (نفّذها منفصلة بعد الـ commit)
-- =====================================================================
-- (أ) أشكال مختلفة للمدينة نفسها يجب أن تعطي مفتاحاً واحداً:
--
--   with samples(raw) as (
--     values
--       ('الرياض'),
--       (' الرياض '),
--       ('الرِّيَاض'),          -- تشكيل
--       ('الريــاض'),           -- تطويل
--       ('الريآض'),             -- ألف ممدودة
--       ('الریاض'),             -- ألف فارسية ٱ/ی
--       ('الريَاضُ')
--   )
--   select raw, public.aani_city_key(raw) as city_key from samples;
--
--   -- المتوقع: city_key = 'الرياض' لكل الصفوف
--
-- (ب) تأكيد أن كل الأشكال تؤول إلى مفتاح واحد:
--
--   with samples(raw) as (
--     values ('الرياض'), ('الرِّيَاض'), ('الريــاض'), ('الريآض'), ('الریاض')
--   )
--   select count(distinct public.aani_city_key(raw)) as distinct_keys from samples;
--
--   -- المتوقع: 1
--
-- (ج) مدن مختلفة يجب أن تبقى مختلفة:
--
--   select public.aani_city_key('جدة') <> public.aani_city_key('الرياض') as different;
--   -- المتوقع: true
--
-- (د) فحص البيانات الحقيقية: هل توجد صفوف لنفس المدينة بمفاتيح مختلفة؟
--
--   select city, public.aani_city_key(city) as key, count(*) as rows
--   from public.profiles
--   where city is not null and btrim(city) <> ''
--   group by 1, 2
--   order by 2, 1;
--
--   -- أي صفين لهما city مختلفان ولكن key واحد = شكلان لنفس المدينة (صحيح)
--   -- أي صفين لهما key مختلفان لنفس المدينة منطقياً = تطبيع ناقص يستحق المراجعة
--
-- (هـ) التأكد أن city الأصلية لم تتغيّر:
--
--   select count(*) from public.profiles where city is not null;
--   -- يجب أن يبقى كما هو قبل الترحيل (الترحيل لا يكتب على city إطلاقاً)
-- =====================================================================
