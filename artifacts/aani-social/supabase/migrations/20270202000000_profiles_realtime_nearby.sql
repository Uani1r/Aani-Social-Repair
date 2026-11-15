-- =====================================================================
-- بث فوري لتغييرات public.profiles — لشاشة «الأشخاص القريبون»
-- =====================================================================
-- السبب المثبت بالفحص: جدول public.profiles غير مشمول في منشور
-- supabase_realtime (كل الترحيلات التي تضيف جداول للمنشور تخصّ جداول أخرى،
-- ولا يوجد أي ترحيل يضيف profiles). لذلك لا تصل أحداث INSERT/UPDATE إلى
-- العميل، ويبقى التحديث التلقائي معتمداً على الفحص الدوري فقط.
--
-- ما يفعله هذا الترحيل:
--   يضيف profiles إلى منشور supabase_realtime إن لم يكن مضافاً، لتصل أحداث
--   INSERT و UPDATE التي تُدخل شخصاً في القائمة أو تُخرجه منها.
--
-- ما لا يفعله:
--   - لا يضبط replica identity ولا يغيّرها: العميل لا يشترك في أحداث DELETE،
--     والحذف (وكذلك اختفاء من أوقف الظهور) يلتقطه الفحص الدوري في الشاشة كل
--     6 ثوانٍ، فلا حاجة لتسليم صف الحذف القديم.
--   - لا يغيّر RLS ولا الصلاحيات ولا أعمدة القراءة ولا أي سياسة خصوصية.
--
-- ملاحظة عن الأمان: Supabase Realtime يطبّق سياسة القراءة القائمة على
-- profiles عند تسليم كل حدث، فلا يصل لمشترك صفٌّ لا تسمح له قراءته أصلاً.
-- هذه الملاحظة تخصّ أحداث INSERT/UPDATE المشترَك بها هنا فقط.
--
-- آمن لإعادة التطبيق (idempotent).
-- =====================================================================

begin;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'profiles'
    ) then
      execute 'alter publication supabase_realtime add table public.profiles';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
