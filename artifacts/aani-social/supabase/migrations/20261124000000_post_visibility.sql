-- Add owner-controlled visibility to posts.
-- Private posts are readable only by their author; public posts remain visible to all signed-in users.
begin;

alter table public.posts
  add column if not exists visibility text not null default 'public';

update public.posts
set visibility = 'public'
where visibility is null or visibility not in ('public', 'private');

alter table public.posts alter column visibility set default 'public';
alter table public.posts alter column visibility set not null;
alter table public.posts drop constraint if exists posts_visibility_check;
alter table public.posts
  add constraint posts_visibility_check
  check (visibility in ('public', 'private'));

grant select, update on public.posts to authenticated;

drop policy if exists "Signed-in users can read posts" on public.posts;
create policy "Signed-in users can read posts"
  on public.posts for select to authenticated
  using (user_id = (select auth.uid()) or visibility = 'public');

commit;
