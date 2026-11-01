-- تشغيل إنشاء القصة بمالك موثوق لتجاوز RLS على INSERT مع إبقاء فحوص الهوية وإعادة المشاركة داخل الدالة.
begin;

create or replace function public.aani_story_exists(p_story_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_story_id is null then
    return false;
  end if;

  perform 1
  from public.stories as story
  where story.id = p_story_id
  for key share;

  return found;
end;
$$;

alter function public.aani_story_exists(uuid) owner to postgres;
revoke all on function public.aani_story_exists(uuid) from public, anon, authenticated;

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
  p_expiry_seconds integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_story_id uuid;
  normalized_original_story_id uuid := p_original_story_id;
  normalized_share_type text := coalesce(p_share_type, 'original');
  story_created_at timestamptz := now();
  expiry_seconds integer := coalesce(p_expiry_seconds, 86400);
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

  if normalized_original_story_id is null then
    normalized_share_type := 'original';
  elsif not public.aani_story_exists(normalized_original_story_id) then
    normalized_original_story_id := null;
    normalized_share_type := 'original';
  else
    if normalized_share_type <> 'reshare' then
      raise exception 'A story with an original reference must be a reshare' using errcode = '22023';
    end if;

    if not public.aani_can_reshare_story(
      normalized_original_story_id,
      auth.uid(),
      p_media_url,
      p_media_type
    ) then
      raise exception 'The original story is not available for resharing' using errcode = '42501';
    end if;
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
    expires_at
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
    story_created_at,
    story_created_at + pg_catalog.make_interval(secs => expiry_seconds::double precision)
  )
  returning id into created_story_id;

  return created_story_id;
end;
$$;

alter function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) owner to postgres;
revoke all on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) from public;
grant execute on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) to authenticated;

grant execute on function public.aani_can_reshare_story(uuid, uuid, text, text) to authenticated;

commit;
