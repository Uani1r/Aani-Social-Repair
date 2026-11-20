-- ============================================================================
-- فهارس البحث عن الحسابات (المرحلة الأولى)
--
-- لماذا:
--   * SearchPage يبحث بـ ilike '%…%' على username و full_name و display_name،
--     وهو ما لا يخدمه أي فهرس قائم: الفهرس الفريد الحالي على lower(username)
--     يخدم التطابق الكامل/البادئة فقط، ولا يخدم المطابقة الجزئية.
--   * pg_trgm مُثبَّت في الإنتاج بالفعل، وفهارس GIN باستخدام gin_trgm_ops
--     هي ما يدعم ILIKE '%…%' على النص العادي (غير المطوي بـ lower).
--   * مع 16 شكلاً مطبَّعاً × 3 حقول، يصبح كل إدخال حتى 48 شرط ilike؛ بدون
--     فهرس مناسب يتحول ذلك إلى مسح كامل لجدول profiles عند كل كتابة.
--
-- ما لا يفعله هذا الترحيل:
--   * لا يغيّر أي سياسة RLS ولا صلاحية جدول ولا عموداً.
--   * لا ينشئ جداول أو Views.
--   * لا يلمس بيانات البحث أو سجلها.
--
-- ملاحظة تشغيلية: إنشاء index عادي داخل معاملة يقفل الكتابة على profiles
-- لحظياً. إن كان الجدول كبيراً في الإنتاج، يمكن استبدال كل create index بـ
-- create index concurrently في جلسة منفصلة خارج معاملة (نفس الأسماء).
-- ============================================================================

begin;

create extension if not exists pg_trgm;

create index if not exists profiles_username_trgm_idx
  on public.profiles using gin (username gin_trgm_ops);

create index if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name gin_trgm_ops);

create index if not exists profiles_display_name_trgm_idx
  on public.profiles using gin (display_name gin_trgm_ops);

commit;
