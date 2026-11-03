begin;

create table if not exists public.story_reports (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  status text not null default 'pending'
    check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint aani_story_reports_story_reporter_unique unique (story_id, reporter_id),
  constraint aani_story_reports_not_self check (reporter_id <> reported_user_id)
);

create index if not exists aani_story_reports_target_created_idx
  on public.story_reports (reported_user_id, created_at desc);

alter table public.story_reports enable row level security;
revoke all on public.story_reports from public, anon, authenticated;
grant insert (story_id, reporter_id, reported_user_id, reason)
  on public.story_reports to authenticated;

drop policy if exists aani_story_reports_insert_own on public.story_reports;
create policy aani_story_reports_insert_own on public.story_reports
  for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and reporter_id <> reported_user_id
    and status = 'pending'
    and exists (
      select 1
      from public.stories as story
      where story.id = story_reports.story_id
        and story.user_id = story_reports.reported_user_id
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

commit;
