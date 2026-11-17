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

-- 5) التحقق من المعنى الفعلي للقيد، لا من نصّه
--
-- pg_get_constraintdef/pg_get_expr يعيدان صياغة PostgreSQL نفسها: يحوّلان
-- `in (...)` إلى `= ANY (ARRAY[...])`، ويضيفان تحويلات نوع وأقواساً، وقد
-- يعيدان ترتيب الشروط. أي مطابقة نصية تتأثر بذلك فتفشل بلا سبب حقيقي (وهو ما
-- حدث في المحاولة السابقة). هنا يُؤخذ تعبير القيد المخزَّن نفسه (pg_get_expr)
-- ويُقيَّم على مصفوفة حالات فعلية (destination, type) لكل منها نتيجة متوقعة،
-- وتُقارن النتيجة الفعلية بالمتوقعة. لا يعتمد هذا الفحص على أي صياغة نصية.
do $$
declare
  check_expr text;
  constraint_valid boolean;
  mismatches integer;
begin
  select pg_get_expr(c.conbin, c.conrelid), c.convalidated
    into check_expr, constraint_valid
  from pg_constraint c
  where c.conrelid = 'public.posts'::regclass
    and c.conname = 'posts_destination_check'
    and c.contype = 'c';

  if check_expr is null then
    raise exception 'posts_destination_check غير موجود بعد الإنشاء.';
  end if;

  -- القيد يجب أن يكون مُفعَّلاً على الصفوف الموجودة، لا NOT VALID
  if not constraint_valid then
    raise exception 'posts_destination_check غير مُفعَّل على الصفوف الموجودة (NOT VALID).';
  end if;

  -- الحالات التي تحكم سلوك الريلز:
  --   * feed: أي type مسموح (بما فيها text و video).
  --   * reels: reel و photo فقط — وأي نوع آخر مرفوض، حتى لو كان نوعاً
  --     معروفاً في مكان آخر (audio) أو نوعاً غير معروف تماماً.
  --   * أي وجهة خارج feed و reels: مرفوضة.
  begin
    execute format($q$
      select count(*)
      from (
        values
          ('feed',  'photo', true),
          ('feed',  'reel',  true),
          ('feed',  'text',  true),
          ('feed',  'video', true),
          ('reels', 'reel',  true),
          ('reels', 'photo', true),
          ('reels', 'text',  false),
          ('reels', 'video', false),
          ('reels', 'audio', false),
          ('reels', 'unknown_type', false),
          ('other', 'photo', false),
          ('other', 'reel',  false)
      ) as cases (destination, type, expected)
      where coalesce((%s), false) <> cases.expected
    $q$, check_expr) into mismatches;
  exception
    when others then
      raise exception 'تعذّر تقييم تعبير posts_destination_check: % (التعريف: %)', sqlerrm, check_expr;
  end;

  if mismatches > 0 then
    raise exception 'posts_destination_check لا يطابق المعنى المطلوب: % حالة مخالفة من أصل 12 (التعريف: %)',
      mismatches, check_expr;
  end if;
end;
$$;

commit;
