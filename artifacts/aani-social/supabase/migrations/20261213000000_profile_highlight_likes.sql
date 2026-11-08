begin;

create table if not exists public.profile_highlight_likes (
  highlight_id uuid not null references public.profile_highlights(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (highlight_id, user_id)
);

create index if not exists aani_profile_highlight_likes_user_idx
  on public.profile_highlight_likes (user_id, highlight_id);

alter table public.profile_highlight_likes enable row level security;
grant select, insert, delete on public.profile_highlight_likes to authenticated;

drop policy if exists aani_profile_highlight_likes_select_own on public.profile_highlight_likes;
create policy aani_profile_highlight_likes_select_own on public.profile_highlight_likes
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists aani_profile_highlight_likes_insert_visible on public.profile_highlight_likes;
create policy aani_profile_highlight_likes_insert_visible on public.profile_highlight_likes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.profile_highlights as highlight
      where highlight.id = profile_highlight_likes.highlight_id
        and highlight.user_id <> (select auth.uid())
        and public.aani_can_view_profile_highlight(highlight.user_id, highlight.is_close_friends)
    )
  );

drop policy if exists aani_profile_highlight_likes_delete_own on public.profile_highlight_likes;
create policy aani_profile_highlight_likes_delete_own on public.profile_highlight_likes
  for delete to authenticated
  using (user_id = (select auth.uid()));

commit;
