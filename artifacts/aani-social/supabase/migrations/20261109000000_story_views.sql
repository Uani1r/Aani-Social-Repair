-- سجل مشاهدات حقيقي وفريد لكل مستخدم/قصة، لا يراه إلا صاحب القصة.
begin;

create table if not exists public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create index if not exists aani_story_views_story_viewed_idx
  on public.story_views (story_id, viewed_at desc);

-- ربط ردود القصة بالمعرّف دون منع ردود متعددة على القصة نفسها.
drop index if exists public.aani_messages_story_unique;
create unique index aani_messages_story_unique
  on public.messages (recipient_id, story_id)
  where story_id is not null and content not like '[story-reply]%';

alter table public.story_views enable row level security;
grant select, insert on public.story_views to authenticated;

drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated
  using (
    exists (
      select 1
      from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
    )
  );

drop policy if exists aani_story_views_insert_viewer on public.story_views;
create policy aani_story_views_insert_viewer on public.story_views
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

commit;
