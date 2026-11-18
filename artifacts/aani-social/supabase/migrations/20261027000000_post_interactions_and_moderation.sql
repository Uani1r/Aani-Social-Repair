alter table public.posts add column if not exists media_urls text[];

grant update on public.posts to authenticated;
drop policy if exists "Users can update their own posts" on public.posts;
create policy "Users can update their own posts"
  on public.posts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists aani_reposts_select_own on public.reposts;
drop policy if exists aani_reposts_select_authenticated on public.reposts;
create policy aani_reposts_select_authenticated on public.reposts
  for select to authenticated using (true);

create table if not exists public.post_feedback (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  feedback text not null check (feedback in ('interested', 'not_interested')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- public.post_reports (table, RLS and policies) is owned by
-- 20270214000000_create_post_reports.sql; nothing here creates or alters it.

alter table public.post_feedback enable row level security;
grant select, insert, update, delete on public.post_feedback to authenticated;

drop policy if exists post_feedback_select_own on public.post_feedback;
create policy post_feedback_select_own on public.post_feedback
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists post_feedback_insert_own on public.post_feedback;
create policy post_feedback_insert_own on public.post_feedback
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists post_feedback_update_own on public.post_feedback;
create policy post_feedback_update_own on public.post_feedback
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists post_feedback_delete_own on public.post_feedback;
create policy post_feedback_delete_own on public.post_feedback
  for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.get_post_interactions(p_post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    p.id,
    (select count(*) from public.likes l where l.post_id = p.id),
    (select count(*) from public.comments c where c.post_id = p.id),
    (select count(*) from public.reposts r where r.post_id = p.id),
    exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()),
    exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()),
    exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()),
    (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid())
  from public.posts p
  where p.id = any(coalesce(p_post_ids, '{}'::uuid[]));
$$;

revoke all on function public.get_post_interactions(uuid[]) from public;
grant execute on function public.get_post_interactions(uuid[]) to authenticated;