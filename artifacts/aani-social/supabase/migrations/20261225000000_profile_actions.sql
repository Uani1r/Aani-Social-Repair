-- Profile menu actions: hide stories from a user and submit account reports.
begin;

create table if not exists public.story_hides (
  hider_id uuid not null references public.profiles(id) on delete cascade,
  hidden_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (hider_id, hidden_user_id),
  constraint aani_story_hides_not_self check (hider_id <> hidden_user_id)
);

create index if not exists aani_story_hides_hidden_user_idx
  on public.story_hides (hidden_user_id, hider_id);

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in ('spam', 'harassment', 'hate', 'fake_account', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint aani_user_reports_not_self check (reporter_id <> reported_user_id),
  constraint aani_user_reports_reporter_target_unique unique (reporter_id, reported_user_id)
);

create index if not exists aani_user_reports_target_created_idx
  on public.user_reports (reported_user_id, created_at desc);

alter table public.story_hides enable row level security;
alter table public.user_reports enable row level security;

revoke all on public.story_hides from public, anon, authenticated;
revoke all on public.user_reports from public, anon, authenticated;
grant select on public.story_hides, public.user_reports to authenticated;
grant insert (reporter_id, reported_user_id, category, details) on public.user_reports to authenticated;

drop policy if exists aani_story_hides_select_own on public.story_hides;
create policy aani_story_hides_select_own on public.story_hides
  for select to authenticated using (hider_id = (select auth.uid()));

drop policy if exists aani_user_reports_select_own on public.user_reports;
create policy aani_user_reports_select_own on public.user_reports
  for select to authenticated using (reporter_id = (select auth.uid()));
drop policy if exists aani_user_reports_insert_own on public.user_reports;
create policy aani_user_reports_insert_own on public.user_reports
  for insert to authenticated with check (
    reporter_id = (select auth.uid())
    and reporter_id <> reported_user_id
    and status = 'pending'
  );

create or replace function public.aani_hide_story_from_user(p_hidden_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_hidden_user_id is null or p_hidden_user_id = actor_id then
    raise exception 'Invalid user to hide stories from' using errcode = '22023';
  end if;

  insert into public.story_hides (hider_id, hidden_user_id)
  values (actor_id, p_hidden_user_id)
  on conflict (hider_id, hidden_user_id) do nothing;

  if pg_catalog.to_regclass('public.story_hidden_users') is not null then
    execute
      'insert into public.story_hidden_users (story_owner_id, hidden_user_id) values ($1, $2) on conflict (story_owner_id, hidden_user_id) do nothing'
      using actor_id, p_hidden_user_id;
  end if;
end;
$$;
revoke all on function public.aani_hide_story_from_user(uuid) from public, anon;
grant execute on function public.aani_hide_story_from_user(uuid) to authenticated;

create or replace function public.aani_unhide_story_from_user(p_hidden_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_hidden_user_id is null or p_hidden_user_id = actor_id then
    raise exception 'Invalid user to unhide' using errcode = '22023';
  end if;

  delete from public.story_hides
  where hider_id = actor_id and hidden_user_id = p_hidden_user_id;

  if pg_catalog.to_regclass('public.story_hidden_users') is not null then
    execute
      'delete from public.story_hidden_users where story_owner_id = $1 and hidden_user_id = $2'
      using actor_id, p_hidden_user_id;
  end if;
end;
$$;
revoke all on function public.aani_unhide_story_from_user(uuid) from public, anon;
grant execute on function public.aani_unhide_story_from_user(uuid) to authenticated;

-- Enforce story hiding for every stories query, including direct/profile fetches and reshares.
create or replace function public.aani_story_chain_hidden_from_user(p_story_id uuid, p_viewer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive story_chain (id, user_id, original_story_id) as (
    select story.id, story.user_id, story.original_story_id
    from public.stories as story
    where story.id = p_story_id

    union all

    select original.id, original.user_id, original.original_story_id
    from public.stories as original
    join story_chain as child on child.original_story_id = original.id
  )
  select coalesce(
    auth.uid() = p_viewer_id
    and exists (
      select 1
      from story_chain as chain
      join public.story_hides as hidden
        on hidden.hider_id = chain.user_id
       and hidden.hidden_user_id = p_viewer_id
    ),
    false
  );
$$;
revoke all on function public.aani_story_chain_hidden_from_user(uuid, uuid) from public, anon;
grant execute on function public.aani_story_chain_hidden_from_user(uuid, uuid) to authenticated;

drop policy if exists aani_stories_story_hides_guard on public.stories;
create policy aani_stories_story_hides_guard on public.stories
  as restrictive for select to authenticated
  using (not public.aani_story_chain_hidden_from_user(id, (select auth.uid())));

notify pgrst, 'reload schema';
commit;
