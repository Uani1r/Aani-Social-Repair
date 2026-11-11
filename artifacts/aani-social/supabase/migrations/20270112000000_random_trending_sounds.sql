-- الاقتراح الذكي للأصوات (نظام الأصوات بنمط TikTok):
-- دالة تجلب أصواتاً عشوائية تماماً (ORDER BY random()) من جدول public.sounds
-- فيعرض الاقتراح التلقائي صوتاً مختلفاً في كل اختيار/تغيير للصورة، مع استبعاد
-- آخر صوت مُقترح على مستوى العميل (sessionStorage: aani:last-suggested-sound-id)
-- لمنع تكرار نفس الصوت في محاولتين متتاليتين.
-- الدالة security invoker: سياسات RLS على public.sounds تنطبق على المستدعي
-- كما لو استعلم الجدول مباشرة (ممنوعة على anon، متاحة لـ authenticated).
begin;

create or replace function public.random_trending_sounds(pool_size integer default 10)
returns table (id uuid, title text, source_video_url text)
language sql
stable
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

commit;
