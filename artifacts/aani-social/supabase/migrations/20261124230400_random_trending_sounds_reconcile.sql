-- تصحيحي: استعادة random_trending_sounds(integer)
-- (الملف الأصلي 20270112000000_random_trending_sounds.sql لم يُطبَّق).
--
-- create or replace: آمن لإعادة التطبيق. security invoker: سياسات RLS على
-- public.sounds تُطبَّق على المستدعي (ممنوعة على anon، متاحة لـ authenticated).
-- volatile بلا stable: random() يجب أن يُقيَّم في كل استدعاء، وstable يوهم
-- بأن النتيجة ثابتة داخل الاستعلام الواحد.
begin;

create or replace function public.random_trending_sounds(pool_size integer default 10)
returns table (id uuid, title text, source_video_url text)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select s.id, s.title, s.source_video_url
  from public.sounds s
  order by random()
  limit greatest(1, least(coalesce(pool_size, 10), 50));
$$;

revoke all on function public.random_trending_sounds(integer) from public, anon;
grant execute on function public.random_trending_sounds(integer) to authenticated;

notify pgrst, 'reload schema';

commit;
