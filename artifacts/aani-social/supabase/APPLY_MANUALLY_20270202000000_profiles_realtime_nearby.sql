-- =====================================================================
-- SQL المطلوب تنفيذه يدوياً في Supabase SQL Editor
-- =====================================================================
-- مأخوذ حرفياً من الترحيل:
--   artifacts/aani-social/supabase/migrations/20270202000000_profiles_realtime_nearby.sql
--
-- لم يُنفَّذ على أي قاعدة. آمن لإعادة التطبيق. لا يغيّر RLS ولا الصلاحيات.
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

alter table public.profiles replica identity full;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- تحقق بعد التنفيذ
-- =====================================================================

-- (1) هل أصبح profiles ضمن المنشور؟ المتوقع: صف واحد
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'profiles';

-- (2) replica identity؟ المتوقع: f (full)
select c.relname, c.relreplident
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'profiles';

-- (3) تأكيد أن RLS ما زال مفعّلاً على profiles (لم يُمسّ)
select relname, relrowsecurity
from pg_class
where relname = 'profiles';
