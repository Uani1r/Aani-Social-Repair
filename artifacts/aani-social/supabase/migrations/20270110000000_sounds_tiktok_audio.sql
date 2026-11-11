-- نظام الأصوات بنمط TikTok:
-- 1) جدول public.sounds: كل صوت أصلي مرتبط بفيديو منشور — يعتمد
--    source_video_url على رابط الفيديو الأصلي لتشغيل الصوت دون استهلاك
--    مساحة Storage جديدة.
-- 2) عمود posts.sound_id يربط كل فيديو بصوته.
-- 3) ربط أثر رجعي (Backfill): كل فيديو منشور حالياً بلا sound_id يحصل
--    على سجل صوت مخصص له باسم صاحبه ويُربط به تلقائياً. آمن للتكرار:
--    لا يُنشئ أصواتاً مكررة لنفس (صاحب الفيديو + نفس رابط الفيديو).
begin;

-- 1) جدول الأصوات
create table if not exists public.sounds (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_video_url text,
  creator_id uuid references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.sounds enable row level security;

drop policy if exists "Signed-in users can read sounds" on public.sounds;
create policy "Signed-in users can read sounds"
  on public.sounds for select to authenticated
  using (true);

drop policy if exists "Users can create their own sounds" on public.sounds;
create policy "Users can create their own sounds"
  on public.sounds for insert to authenticated
  with check (creator_id = (select auth.uid()));

drop policy if exists "Users can update their own sounds" on public.sounds;
create policy "Users can update their own sounds"
  on public.sounds for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

drop policy if exists "Users can delete their own sounds" on public.sounds;
create policy "Users can delete their own sounds"
  on public.sounds for delete to authenticated
  using (creator_id = (select auth.uid()));

grant select, insert, update, delete on public.sounds to authenticated;

-- 2) ربط المنشورات بالأصوات
alter table public.posts
  add column if not exists sound_id uuid references public.sounds (id) on delete set null;

create index if not exists posts_sound_id_idx
  on public.posts (sound_id, created_at desc);

-- صلاحيات قراءة أعمدة المنشورات الصوتية (منح الأعمدة تراكمي ولا يمس أي منح سابق)
grant select (sound_id, audio_url, audio_title, trim_start, trim_end) on public.posts to authenticated;

-- 3) الربط بأثر رجعي: فيديو منشور بلا sound_id → صوت أصلي باسم صاحبه
--    الملف المرجعي يُقارَن على الرابط الأساسي بدون ترميز التعديل (#t= / #crop=)
with base_videos as (
  select p.id as post_id, p.user_id, split_part(p.media_url, '#', 1) as base_url
  from public.posts p
  where p.type = 'reel'
    and p.media_url is not null
    and btrim(split_part(p.media_url, '#', 1)) <> ''
    and p.sound_id is null
),
missing_sounds as (
  select distinct on (b.user_id, b.base_url)
    b.user_id, b.base_url
  from base_videos b
  where not exists (
    select 1 from public.sounds s
    where s.creator_id = b.user_id
      and s.source_video_url = b.base_url
  )
  order by b.user_id, b.base_url
)
insert into public.sounds (title, source_video_url, creator_id)
select 'الصوت الأصلي - ' || coalesce(
  nullif(btrim(p.full_name), ''),
  p.username,
  'المستخدم'
), m.base_url, m.user_id
from missing_sounds m
join public.profiles p on p.id = m.user_id;

-- ربط كل فيديو بلا sound_id بالصوت المطابق لصاحبه ورابطه الأساسي
update public.posts p
set sound_id = s.id
from public.sounds s
where p.type = 'reel'
  and p.media_url is not null
  and p.sound_id is null
  and s.creator_id = p.user_id
  and s.source_video_url = split_part(p.media_url, '#', 1);

commit;
