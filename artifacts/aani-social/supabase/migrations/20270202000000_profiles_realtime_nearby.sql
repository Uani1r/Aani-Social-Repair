-- =====================================================================
-- بث فوري لتغييرات public.profiles — لشاشة «الأشخاص القريبون»
-- =====================================================================
-- السبب المثبت بالفحص: جدول public.profiles غير مشمول في منشور
-- supabase_realtime (بقية الجداول تُضاف في ترحيلاتها، ولا يوجد أي ترحيل
-- يضيف profiles). لذلك لا تصل أي أحداث INSERT/UPDATE/DELETE إلى العميل،
-- ويبقى التحديث التلقائي معتمداً على الفحص الدوري فقط.
--
-- ما يفعله هذا الترحيل:
--   1) يضيف profiles إلى منشور supabase_realtime إن لم يكن مضافاً.
--   2) يجعل replica identity = full ليصل صف DELETE القديم كاملاً — وهو
--      شرط تسليم أحداث الحذف مع RLS في Supabase Realtime.
--
-- الخصوصية والأمان: لا تغيير في RLS ولا في الصلاحيات ولا في أعمدة القراءة.
-- Supabase Realtime يطبّق سياسات RLS للمشترك على كل حدث، فلا يستقبل أحد
-- بيانات صف إلا بما تسمح به سياسة القراءة القائمة على profiles أصلاً.
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

-- صف الحذف القديم كاملاً (مطلوب لتسليم DELETE مع RLS)
alter table public.profiles replica identity full;

notify pgrst, 'reload schema';

commit;
