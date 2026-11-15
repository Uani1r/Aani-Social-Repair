-- =====================================================================
-- SQL المطلوب تنفيذه يدوياً في Supabase SQL Editor
-- =====================================================================
-- مأخوذ حرفياً من الترحيل:
--   artifacts/aani-social/supabase/migrations/20270202000000_profiles_realtime_nearby.sql
--
-- لم يُنفَّذ على أي قاعدة. آمن لإعادة التطبيق. لا يغيّر RLS ولا الصلاحيات.
--
-- يضيف public.profiles إلى منشور supabase_realtime لتصل أحداث INSERT وUPDATE
-- التي تُدخل شخصاً في «الأشخاص القريبون» أو تُخرجه منها.
--
-- لا يضبط replica identity: العميل لا يشترك في أحداث DELETE، والحذف (وكذلك
-- اختفاء من أوقف الظهور) يلتقطه الفحص الدوري في الشاشة كل 6 ثوانٍ.
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

-- =====================================================================
-- تحقق بعد التنفيذ
-- =====================================================================

-- (1) هل أصبح profiles ضمن المنشور؟ المتوقع: صف واحد
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'profiles';

-- (2) تأكيد أن RLS ما زال مفعّلاً على profiles (لم يُمسّ)
-- المتوقع: relrowsecurity = true
select relname, relrowsecurity
from pg_class
where relname = 'profiles';

-- (3) تأكيد أن replica identity لم تُغيَّر (d = default)
-- هذا الملف لا يغيّرها؛ القيمة قد تكون d أو f من إعداد سابق مستقل.
select c.relname, c.relreplident
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'profiles';
