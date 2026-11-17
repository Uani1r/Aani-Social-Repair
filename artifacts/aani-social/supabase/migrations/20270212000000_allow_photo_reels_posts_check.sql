-- ============================================================================
-- إصلاح مستقل: رفض نشر الصور داخل تبويب الريلز بسبب قيد الوجهة في public.posts
-- يُنفَّذ يدوياً في Supabase → SQL Editor. آمن للتكرار (idempotent).
--
-- المشكلة المؤكدة من قاعدة الإنتاج: القيد الحاكم اسمه `posts_check` وليس
-- `posts_destination_check`، وهو يفرض عند destination = 'reels' أن يكون
-- type = 'reel'. التطبيق ينشر الصورة بشكل صحيح كـ type = 'photo' مع
-- destination = 'reels'، فيرفضه القيد بـ SQLSTATE 23514.
--
-- الترحيلان السابقان (20270104000000_reels_photo_destination.sql و
-- 20270119000000_reels_publish_visibility_repair.sql) عدّلا القيد
-- `posts_destination_check` فقط، فبقي `posts_check` هو الذي يرفض النشر. لذلك
-- لا يكفي تعديل القيد القديم: يُزال القيدان المحتملان معاً ثم يُنشأ قيد واحد
-- صحيح باسم posts_destination_check.
--
-- نطاق هذا الملف: قيد الوجهة وحده.
--   * لا يغيّر type = 'photo' ولا يحوّله إلى 'reel'.
--   * لا يعدّل posts_media_type_check ولا أي قيد آخر.
--   * لا يغيّر RLS ولا GRANT ولا سياسات الخصوصية.
--   * لا يضيف جدولاً ولا فهرساً، ولا يعدّل أي صف.
--
-- ملاحظة: add constraint يتحقق من الصفوف الموجودة افتراضياً. لو وُجد صف قديم
-- يخالف التعريف المطلوب فسيفشل هذا الترحيل كاملاً وتُلغى المعاملة بلا أي
-- تغيير (لا نصف إصلاح). معالجة تلك الصفوف خارج نطاق هذا الملف.
-- ============================================================================

begin;

-- 1) التحقق من وجود جدول المنشورات قبل أي تعديل
do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts غير موجود: طبّق مخطط المشروع الأساسي أولاً.';
  end if;
end;
$$;

-- 2) إزالة القيدين المحتملين معاً:
--    posts_check                 = القيد المؤكد في الإنتاج (يفرض type = 'reel')
--    posts_destination_check     = القيد الذي عدّلته الترحيلات السابقة
alter table public.posts drop constraint if exists posts_check;
alter table public.posts drop constraint if exists posts_destination_check;

-- 3) قيد وجهة واحد صحيح: 'reels' تقبل الفيديو (reel) والصورة (photo)
alter table public.posts
  add constraint posts_destination_check
  check (
    destination in ('feed', 'reels')
    and (
      destination <> 'reels'
      or type in ('reel', 'photo')
    )
  );

-- 4) التحقق: القيد القديم posts_check لم يبقَ
do $$
begin
  if exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.posts'::regclass
      and c.conname = 'posts_check'
  ) then
    raise exception 'posts_check ما زال موجوداً بعد الحذف: لم يكتمل الإصلاح.';
  end if;
end;
$$;

-- 5) التحقق من التعريف الفعلي للقيد الجديد ومن أنه مُفعَّل على الصفوف الموجودة
--
-- pg_get_constraintdef يعيد صيغة `destination = ANY (ARRAY['feed', ...])` بدل
-- `in (...)`, لذلك يُطبَّع النص (حذف المسافات والأقواس وتحويلات النوع ::text
-- و::text[]) قبل مطابقته على القطع المطلوبة. أي اختلاف يتوقف عنده الترحيل
-- وتُلغى كل خطوات هذه المعاملة، فلا تبقى قاعدة نصف معدَّلة.
do $$
declare
  constraint_def text;
  constraint_valid boolean;
begin
  select pg_get_constraintdef(c.oid), c.convalidated
    into constraint_def, constraint_valid
  from pg_constraint c
  where c.conrelid = 'public.posts'::regclass
    and c.conname = 'posts_destination_check'
    and c.contype = 'c';

  if constraint_def is null then
    raise exception 'posts_destination_check غير موجود بعد الإنشاء.';
  end if;

  if not constraint_valid then
    raise exception 'posts_destination_check غير مُفعَّل على الصفوف الموجودة (NOT VALID).';
  end if;

  constraint_def := lower(constraint_def);
  constraint_def := replace(constraint_def, ' ', '');
  constraint_def := replace(constraint_def, '(', '');
  constraint_def := replace(constraint_def, ')', '');
  -- حذف أي تحويل نوع: ::text و ::text[] و ::character varying
  constraint_def := regexp_replace(constraint_def, '::[a-z_ ]+(\[\])?', '', 'g');
  constraint_def := replace(constraint_def, 'public.', '');

  -- destination in ('feed', 'reels')
  if position('destination=anyarray[''feed'',''reels'']' in constraint_def) = 0 then
    raise exception 'posts_destination_check لا يحصر destination في feed و reels. التعريف: %', constraint_def;
  end if;

  -- destination <> 'reels' or ...
  if position('destination<>''reels''' in constraint_def) = 0 then
    raise exception 'posts_destination_check لا يربط شرط type بالوجهة reels. التعريف: %', constraint_def;
  end if;

  -- ... or type in ('reel', 'photo')
  if position('type=anyarray[''reel'',''photo'']' in constraint_def) = 0 then
    raise exception 'posts_destination_check لا يسمح بـ type = photo داخل الريلز. التعريف: %', constraint_def;
  end if;
end;
$$;

commit;
