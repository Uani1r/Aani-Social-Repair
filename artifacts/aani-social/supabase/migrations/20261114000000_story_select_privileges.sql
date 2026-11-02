-- منح أذونات القراءة اللازمة، مع استثناء صريح لقراءة المالك لقصصه النشطة.
begin;

grant usage on schema public to authenticated;
grant select on table public.stories, public.profiles, public.follows, public.close_friends to authenticated;

drop policy if exists aani_stories_select_visible on public.stories;
create policy aani_stories_select_visible on public.stories
  as permissive
  for select to authenticated
  using (
    (
      user_id = (select auth.uid())
      and created_at >= now() - interval '24 hours'
      and created_at <= now() + interval '5 minutes'
      and expires_at > now()
      and expires_at <= created_at + interval '24 hours'
    )
    or public.aani_can_view_story(id, (select auth.uid()))
  );

drop policy if exists aani_stories_followers_guard on public.stories;
create policy aani_stories_followers_guard on public.stories
  as restrictive
  for select to authenticated
  using (
    created_at >= now() - interval '24 hours'
    and created_at <= now() + interval '5 minutes'
    and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and (
      user_id = (select auth.uid())
      or public.aani_can_view_story(id, (select auth.uid()))
    )
  );

commit;
