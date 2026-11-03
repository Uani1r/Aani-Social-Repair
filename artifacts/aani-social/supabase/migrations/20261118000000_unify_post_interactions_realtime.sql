begin;

-- Both public RPCs delegate to one SECURITY DEFINER implementation so RLS on
-- individual interaction tables cannot make counters differ by viewer.
drop function if exists public.get_post_interactions(uuid[]);
drop function if exists public.post_interaction_summaries(uuid[]);

create or replace function public.aani_post_interaction_rows(p_post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  shares_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text,
  shared_by_me boolean,
  like_count integer,
  comment_count integer,
  repost_count integer,
  share_count integer,
  liked boolean,
  bookmarked boolean,
  reposted boolean,
  shared boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with summaries as (
    select
      p.id as post_id,
      (select count(*) from public.likes l where l.post_id = p.id)::bigint as likes_count,
      (select count(*) from public.comments c where c.post_id = p.id)::bigint as comments_count,
      (select count(*) from public.reposts r where r.post_id = p.id)::bigint as reposts_count,
      (select count(*) from public.post_shares s where s.post_id = p.id)::bigint as shares_count,
      exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked_by_me,
      exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted_by_me,
      exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as saved_by_me,
      (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid()) as feedback_by_me,
      exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared_by_me
    from public.posts p
    where p.id = any(coalesce(p_post_ids, '{}'::uuid[]))
  )
  select
    s.post_id,
    s.likes_count,
    s.comments_count,
    s.reposts_count,
    s.shares_count,
    s.liked_by_me,
    s.reposted_by_me,
    s.saved_by_me,
    s.feedback_by_me,
    s.shared_by_me,
    s.likes_count::integer as like_count,
    s.comments_count::integer as comment_count,
    s.reposts_count::integer as repost_count,
    s.shares_count::integer as share_count,
    s.liked_by_me as liked,
    s.saved_by_me as bookmarked,
    s.reposted_by_me as reposted,
    s.shared_by_me as shared
  from summaries s;
$$;

revoke all on function public.aani_post_interaction_rows(uuid[]) from public, anon, authenticated;

create function public.get_post_interactions(p_post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  shares_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text,
  shared_by_me boolean,
  like_count integer,
  comment_count integer,
  repost_count integer,
  share_count integer,
  liked boolean,
  bookmarked boolean,
  reposted boolean,
  shared boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.aani_post_interaction_rows(p_post_ids);
$$;

create function public.post_interaction_summaries(post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  shares_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text,
  shared_by_me boolean,
  like_count integer,
  comment_count integer,
  repost_count integer,
  share_count integer,
  liked boolean,
  bookmarked boolean,
  reposted boolean,
  shared boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.aani_post_interaction_rows(post_ids);
$$;

revoke all on function public.get_post_interactions(uuid[]) from public;
revoke all on function public.post_interaction_summaries(uuid[]) from public;
grant execute on function public.get_post_interactions(uuid[]) to authenticated, anon;
grant execute on function public.post_interaction_summaries(uuid[]) to authenticated, anon;

-- The centralized Realtime subscriber needs full OLD rows for deletes and a
-- single publication membership for every table it watches.
alter table public.posts replica identity full;
alter table public.likes replica identity full;
alter table public.comments replica identity full;
alter table public.reposts replica identity full;
alter table public.bookmarks replica identity full;
alter table public.post_shares replica identity full;
alter table public.post_feedback replica identity full;

do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['posts', 'likes', 'comments', 'reposts', 'bookmarks', 'post_shares', 'post_feedback']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = target_table
      ) then
        begin
          execute format('alter publication supabase_realtime add table public.%I', target_table);
        exception
          when duplicate_object then null;
          when undefined_object then null;
        end;
      end if;
    end loop;
  end if;
end;
$$;

commit;
