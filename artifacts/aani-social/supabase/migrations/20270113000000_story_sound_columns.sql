-- صوت القصة (نظام الأصوات بنمط TikTok):
-- 1) أعمدة public.stories: sound_id (يرتبط بجدول الأصوات) + زمني اقتصاص الصوت
--    sound_trim_start/sound_trim_end (بالثواني) كي يسمع الجميع نفس الجزء المقتص.
-- 2) تحديث دالة النشر aani_create_story لتقبل الصوت كمعاملات اختيارية
--    (p_sound_id/p_sound_trim_start/p_sound_trim_end) — القيم تُخزَّن مع القصة
--    في نموذج نشر القصة (Story Publish Payload) وتُرجع مع قصص الجميع.
-- ملاحظة: الدالة الأقدم (بلا معاملات الصوت) تبقى قائمة كي يعمل الاحتياط
-- في العميل إن لم يُطبَّق هذا الترحيل بعد.
begin;

alter table public.stories
  add column if not exists sound_id uuid references public.sounds (id) on delete set null,
  add column if not exists sound_trim_start real,
  add column if not exists sound_trim_end real;

create index if not exists stories_sound_id_idx
  on public.stories (sound_id, created_at desc);

-- منح قراءة أعمدة الصوت (منح تراكمي لا يمس أي منح سابق)
grant select (sound_id, sound_trim_start, sound_trim_end) on public.stories to authenticated;

-- دالة النشر بمعاملات الصوت الاختيارية (نفس منطق الترحيل 20261110000000 + الصوت)
create or replace function public.aani_create_story(
  p_media_url text,
  p_media_type text,
  p_caption text,
  p_is_close_friends boolean,
  p_duration_seconds integer,
  p_timed_texts jsonb,
  p_filter_key text,
  p_original_story_id uuid,
  p_share_type text,
  p_expiry_seconds integer,
  p_sound_id uuid default null,
  p_sound_trim_start real default null,
  p_sound_trim_end real default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_story_id uuid;
  normalized_original_story_id uuid := p_original_story_id;
  normalized_share_type text := coalesce(p_share_type, 'original');
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_media_type is null or p_media_type not in ('text', 'photo', 'video') then
    raise exception 'Invalid story media type' using errcode = '22023';
  end if;

  if p_expiry_seconds is not null and (p_expiry_seconds < 5 or p_expiry_seconds > 3600) then
    raise exception 'Story expiry must be between 5 seconds and 60 minutes' using errcode = '22023';
  end if;

  if normalized_original_story_id is not null
     and not public.aani_story_exists(normalized_original_story_id) then
    normalized_original_story_id := null;
    normalized_share_type := 'original';
  elsif normalized_original_story_id is null then
    normalized_share_type := 'original';
  elsif normalized_share_type <> 'reshare' then
    raise exception 'A story with an original reference must be a reshare' using errcode = '22023';
  end if;

  insert into public.stories (
    user_id,
    media_url,
    media_type,
    caption,
    is_close_friends,
    duration_seconds,
    timed_texts,
    filter_key,
    original_story_id,
    share_type,
    created_at,
    expires_at,
    sound_id,
    sound_trim_start,
    sound_trim_end
  ) values (
    auth.uid(),
    p_media_url,
    p_media_type,
    p_caption,
    coalesce(p_is_close_friends, false),
    least(120, greatest(1, coalesce(p_duration_seconds, 30))),
    coalesce(p_timed_texts, '[]'::jsonb),
    p_filter_key,
    normalized_original_story_id,
    normalized_share_type,
    now(),
    now() + pg_catalog.make_interval(secs => coalesce(p_expiry_seconds, 86400)::double precision),
    p_sound_id,
    p_sound_trim_start,
    p_sound_trim_end
  )
  returning id into created_story_id;

  return created_story_id;
end;
$$;

revoke all on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, integer, integer, uuid, real, real) from public;
grant execute on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, integer, integer, uuid, real, real) to authenticated;

commit;
