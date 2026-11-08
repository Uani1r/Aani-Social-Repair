begin;

alter table public.profile_highlights
  add column if not exists duration_seconds integer;

alter table public.profile_highlights
  drop constraint if exists aani_profile_highlights_duration_seconds_check;
alter table public.profile_highlights
  add constraint aani_profile_highlights_duration_seconds_check
  check (duration_seconds is null or duration_seconds between 1 and 120);

-- Preserve durations on existing highlights before their source stories expire or are removed.
update public.profile_highlights as highlight
set duration_seconds = story.duration_seconds
from public.stories as story
where highlight.source_story_id = story.id
  and highlight.duration_seconds is null
  and story.duration_seconds between 1 and 120;

create or replace function public.aani_add_profile_highlight(
  p_collection_id uuid,
  p_collection_title text,
  p_media_url text,
  p_media_type text,
  p_caption text,
  p_source_story_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_collection public.profile_highlight_collections%rowtype;
  v_highlight public.profile_highlights%rowtype;
  v_position integer;
  v_is_close_friends boolean := false;
  v_duration_seconds integer := null;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_source_story_id is not null then
    select coalesce(story.is_close_friends, false), story.duration_seconds
      into v_is_close_friends, v_duration_seconds
    from public.stories as story
    where story.id = p_source_story_id
      and story.user_id = v_user_id;

    if not found then
      raise exception using errcode = '42501', message = 'Story is not owned by the current user';
    end if;
  end if;

  if p_collection_id is null then
    insert into public.profile_highlight_collections (user_id, title)
    values (v_user_id, coalesce(nullif(btrim(p_collection_title), ''), nullif(btrim(p_caption), ''), 'أبرز القصص'))
    returning * into v_collection;
  else
    select * into v_collection
    from public.profile_highlight_collections
    where id = p_collection_id
      and user_id = v_user_id
    for update;

    if not found then
      raise exception using errcode = '42501', message = 'Collection is not owned by the current user';
    end if;
  end if;

  select coalesce(max(item.position), -1) + 1
    into v_position
  from public.profile_highlights as item
  where item.collection_id = v_collection.id;

  insert into public.profile_highlights (
    user_id,
    collection_id,
    position,
    media_url,
    media_type,
    caption,
    source_story_id,
    is_close_friends,
    duration_seconds
  )
  values (
    v_user_id,
    v_collection.id,
    v_position,
    p_media_url,
    p_media_type,
    p_caption,
    p_source_story_id,
    v_is_close_friends,
    v_duration_seconds
  )
  returning * into v_highlight;

  return jsonb_build_object(
    'collection', jsonb_build_object(
      'id', v_collection.id,
      'user_id', v_collection.user_id,
      'title', v_collection.title,
      'created_at', v_collection.created_at
    ),
    'highlight', to_jsonb(v_highlight)
  );
end;
$$;

alter function public.aani_add_profile_highlight(uuid, text, text, text, text, uuid) owner to postgres;
revoke all on function public.aani_add_profile_highlight(uuid, text, text, text, text, uuid) from public;
grant execute on function public.aani_add_profile_highlight(uuid, text, text, text, text, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
