-- ============================================================================
-- فهارس البحث عن الحسابات (المرحلة الأولى)
--
-- لماذا:
--   * SearchPage يبحث بـ ilike على username و full_name و display_name،
--     بالبادئة (للتطابق التام/بداية الاسم) وبالنص الكامل (%…%) للمطابقات
--     الجزئية. الفهرس الفريد الحالي على lower(username) لا يخدم ilike على
--     القيمة الخام، ولا يخدم %…% إطلاقاً.
--   * pg_trgm هو امتداد Postgres الذي يخدم ILIKE '%…%' عبر فهارس GIN
--     باستخدام gin_trgm_ops.
--   * الفهارس الثلاثة ضرورية: كل استعلام يفلتر على الحقول الثلاثة في نفس
--     جملة OR، فأي حقل بلا فهرس يعيد المسح الكامل.
--
-- طريقة الإنشاء:
--   * create index concurrently لتفادي قفل الكتابة على profiles أثناء البناء.
--   * CONCURRENTLY لا يعمل داخل معاملة، لذا هذا الملف بلا begin/commit:
--     يجب أن يُطبَّق في جلسة تنفّذ كل عبارة على حدة. إن غلّف المشغّل الملف في
--     معاملة سيفشل بأمان برسالة PostgreSQL الواضحة
--     "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
--   * إن فشل البناء المتزامن يبقى فهرس غير صالح بنفس الاسم؛ يُحذف بـ
--     drop index concurrently <name> ثم يُعاد تشغيل الملف.
--
-- الامتداد:
--   * لا يُفترض وجود pg_trgm مسبقاً: يُنشأ عند الحاجة، في مخطط extensions إن
--     وُجد (سياسة Supabase)، وإلا في public.
--   * يُضاف مخطط الامتداد الفعلي إلى search_path حتى يُحلّ gin_trgm_ops.
--
-- ما لا يفعله هذا الترحيل:
--   * لا يغيّر أي سياسة RLS ولا صلاحية جدول أو عمود.
--   * لا ينشئ جداول أو Views، ولا يعدّل بيانات.
-- ============================================================================

-- 1) إنشاء الامتداد عند الحاجة، في مخططه الصحيح.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    return;
  end if;

  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension pg_trgm with schema extensions;
  else
    create extension pg_trgm with schema public;
  end if;
end $$;

-- 2) إضافة مخطط الامتداد الفعلي إلى search_path حتى يُحلّ gin_trgm_ops.
do $$
declare
  v_extension_schema text;
begin
  select namespace.nspname
    into v_extension_schema
  from pg_extension as extension
  join pg_namespace as namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if v_extension_schema is null then
    raise exception 'pg_trgm غير متاح بعد الإنشاء — أوقف الترحيل.';
  end if;

  execute format('set search_path = public, %I, pg_temp', v_extension_schema);
end $$;

-- 3) فهارس GIN ثلاثية الأحرف، بلا قفل كتابة.
create index concurrently if not exists profiles_username_trgm_idx
  on public.profiles using gin (username gin_trgm_ops);

create index concurrently if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name gin_trgm_ops);

create index concurrently if not exists profiles_display_name_trgm_idx
  on public.profiles using gin (display_name gin_trgm_ops);
