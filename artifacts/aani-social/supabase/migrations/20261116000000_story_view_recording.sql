-- Record a real story view through an authenticated, idempotent RPC.
begin;

create table if not exists public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create index if not exists aani_story_views_story_viewed_idx
  on public.story_views (story_id, viewed_at desc);

alter table public.story_views enable row level security;
grant select, insert on public.story_views to authenticated;

-- The story owner can read viewers; blocked accounts stay excluded.
drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_views.user_id)
    )
  );

drop policy if exists aani_story_views_owner_guard on public.story_views;
create policy aani_story_views_owner_guard on public.story_views
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_views.user_id)
    )
  );

drop policy if exists aani_story_views_insert_viewer on public.story_views;
create policy aani_story_views_insert_viewer on public.story_views
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

drop policy if exists aani_story_views_insert_guard on public.story_views;
create policy aani_story_views_insert_guard on public.story_views
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

create or replace function public.aani_record_story_view(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.stories as story
    where story.id = p_story_id
      and story.user_id <> viewer_id
      and public.aani_can_view_story(story.id, viewer_id)
  ) then
    raise exception 'Story is not available to this viewer' using errcode = '42501';
  end if;

  insert into public.story_views (story_id, user_id)
  values (p_story_id, viewer_id)
  on conflict (story_id, user_id) do nothing;
end;
$$;

revoke all on function public.aani_record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid) to authenticated;

commit;
