begin;

create table if not exists public.profile_highlight_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  created_at timestamptz not null default now()
);

alter table public.profile_highlights
  add column collection_id uuid,
  add column position integer;

-- Preserve existing highlights as one-story collections, carrying their current captions forward as titles.
insert into public.profile_highlight_collections (id, user_id, title, created_at)
select
  highlight.id,
  highlight.user_id,
  coalesce(nullif(btrim(highlight.caption), ''), 'أبرز القصص'),
  highlight.created_at
from public.profile_highlights as highlight;

update public.profile_highlights
set collection_id = id,
    position = 0;

alter table public.profile_highlights
  alter column collection_id set not null,
  alter column position set default 0,
  alter column position set not null,
  add constraint aani_profile_highlights_collection_fk
    foreign key (collection_id) references public.profile_highlight_collections(id) on delete cascade,
  add constraint aani_profile_highlights_position_check check (position >= 0);

create unique index if not exists aani_profile_highlights_collection_position_unique_idx
  on public.profile_highlights (collection_id, position);
create index if not exists aani_profile_highlight_collections_user_created_idx
  on public.profile_highlight_collections (user_id, created_at, id);

alter table public.profile_highlight_collections enable row level security;
grant select on public.profile_highlight_collections to authenticated;

drop policy if exists aani_profile_highlight_collections_select_visible on public.profile_highlight_collections;
create policy aani_profile_highlight_collections_select_visible on public.profile_highlight_collections
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.profile_highlights as item
      where item.collection_id = public.profile_highlight_collections.id
        and public.aani_can_view_profile_highlight(item.user_id, item.is_close_friends)
    )
  );

-- Collection writes go through the authenticated security-definer RPC below.
revoke insert on public.profile_highlights from authenticated;
drop policy if exists aani_profile_highlights_insert_own on public.profile_highlights;

drop policy if exists aani_profile_highlight_collections_insert_own on public.profile_highlight_collections;
drop policy if exists aani_profile_highlight_collections_delete_own on public.profile_highlight_collections;

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
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_source_story_id is not null then
    select coalesce(story.is_close_friends, false)
      into v_is_close_friends
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
    is_close_friends
  )
  values (
    v_user_id,
    v_collection.id,
    v_position,
    p_media_url,
    p_media_type,
    p_caption,
    p_source_story_id,
    v_is_close_friends
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
