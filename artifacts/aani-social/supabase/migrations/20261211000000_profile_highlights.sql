begin;

create table if not exists public.profile_highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_url text,
  media_type text not null check (media_type in ('image', 'video', 'text')),
  caption text,
  source_story_id uuid references public.stories(id) on delete set null,
  is_close_friends boolean not null default false,
  created_at timestamptz not null default now(),
  constraint aani_profile_highlights_media_check check (
    (media_type = 'text' and media_url is null)
    or (media_type in ('image', 'video') and media_url is not null)
  )
);

create index if not exists aani_profile_highlights_user_created_idx
  on public.profile_highlights (user_id, created_at desc);
create unique index if not exists aani_profile_highlights_source_story_unique_idx
  on public.profile_highlights (user_id, source_story_id)
  where source_story_id is not null;

alter table public.profile_highlights enable row level security;
grant select, insert, delete on public.profile_highlights to authenticated;

create or replace function public.aani_can_view_profile_highlight(
  p_owner_id uuid,
  p_is_close_friends boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      p_owner_id = (select auth.uid())
      or (
        not public.aani_is_user_blocked(p_owner_id, (select auth.uid()))
        and exists (
          select 1
          from public.profiles as owner
          where owner.id = p_owner_id
            and (
              not owner.is_private
              or exists (
                select 1
                from public.follows as accepted
                where accepted.follower_id = (select auth.uid())
                  and accepted.following_id = p_owner_id
              )
            )
        )
        and (
          not coalesce(p_is_close_friends, false)
          or (
            public.aani_is_mutual_follow(p_owner_id, (select auth.uid()))
            and exists (
              select 1
              from public.close_friends as listed
              where listed.user_id = p_owner_id
                and listed.friend_id = (select auth.uid())
            )
          )
        )
      )
    );
$$;

alter function public.aani_can_view_profile_highlight(uuid, boolean) owner to postgres;
revoke all on function public.aani_can_view_profile_highlight(uuid, boolean) from public;
grant execute on function public.aani_can_view_profile_highlight(uuid, boolean) to authenticated;

drop policy if exists aani_profile_highlights_select_visible on public.profile_highlights;
create policy aani_profile_highlights_select_visible on public.profile_highlights
  for select to authenticated
  using (public.aani_can_view_profile_highlight(user_id, is_close_friends));

drop policy if exists aani_profile_highlights_insert_own on public.profile_highlights;
create policy aani_profile_highlights_insert_own on public.profile_highlights
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists aani_profile_highlights_delete_own on public.profile_highlights;
create policy aani_profile_highlights_delete_own on public.profile_highlights
  for delete to authenticated
  using (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
