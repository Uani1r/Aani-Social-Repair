-- Per-post interaction privacy and comment audience controls.
begin;

alter table public.posts
  add column if not exists hide_likes boolean not null default false,
  add column if not exists hide_comments boolean not null default false,
  add column if not exists comment_privacy text not null default 'public',
  add column if not exists allowed_commenters uuid[] not null default '{}'::uuid[];

update public.posts
set comment_privacy = 'public'
where comment_privacy is null or comment_privacy not in ('public', 'followers', 'custom');

update public.posts
set allowed_commenters = '{}'::uuid[]
where allowed_commenters is null;

alter table public.posts alter column hide_likes set default false;
alter table public.posts alter column hide_likes set not null;
alter table public.posts alter column hide_comments set default false;
alter table public.posts alter column hide_comments set not null;
alter table public.posts alter column comment_privacy set default 'public';
alter table public.posts alter column comment_privacy set not null;
alter table public.posts alter column allowed_commenters set default '{}'::uuid[];
alter table public.posts alter column allowed_commenters set not null;
alter table public.posts drop constraint if exists posts_comment_privacy_check;
alter table public.posts
  add constraint posts_comment_privacy_check
  check (comment_privacy in ('public', 'followers', 'custom'));
alter table public.posts drop constraint if exists posts_allowed_commenters_no_nulls_check;
alter table public.posts
  add constraint posts_allowed_commenters_no_nulls_check
  check (array_position(allowed_commenters, null::uuid) is null);

-- Keep the custom commenter UUID list private to the post owner while allowing
-- ordinary post fields to remain readable by authenticated users.
revoke select on table public.posts from public, anon, authenticated;
grant select (
  id, user_id, content, post_metadata, media_url, media_urls, type, visibility, created_at,
  likes_count, comments_count, reposts_count, shares_count, comments_disabled, audio_url, audio_title,
  hide_likes, hide_comments, comment_privacy
) on table public.posts to authenticated;
grant select on table public.posts to service_role;

create or replace function public.aani_get_allowed_commenters(p_post_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p.allowed_commenters, '{}'::uuid[])
  from public.posts p
  where p.id = p_post_id and p.user_id = auth.uid();
$$;
revoke all on function public.aani_get_allowed_commenters(uuid) from public, anon, authenticated;
grant execute on function public.aani_get_allowed_commenters(uuid) to authenticated;

-- SECURITY DEFINER helpers keep the policies independent of caller-visible
-- rows in follows/posts and are also used by the authoritative insert trigger.
create or replace function public.aani_can_view_post_comments(
  p_post_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and p_viewer_id = auth.uid()
      and (
        p.user_id = p_viewer_id
        or (
          not p.hide_comments
          and p.visibility <> 'private'
        )
      )
  );
$$;

create or replace function public.aani_can_comment_on_post(
  p_post_id uuid,
  p_commenter_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and p.comments_disabled = false
      and (p_commenter_id = auth.uid() or auth.role() = 'service_role')
      and (
        p.user_id = p_commenter_id
        or (
          p.visibility <> 'private'
          and not p.hide_comments
          and case p.comment_privacy
            when 'followers' then exists (
              select 1
              from public.follows f
              where f.follower_id = p_commenter_id
                and f.following_id = p.user_id
            )
            when 'custom' then
              p.allowed_commenters @> array[p_commenter_id]
              and exists (
                select 1
                from public.follows f1
                join public.follows f2
                  on f2.follower_id = f1.following_id
                 and f2.following_id = f1.follower_id
                where f1.follower_id = p.user_id
                  and f1.following_id = p_commenter_id
              )
            else true
          end
        )
      )
  );
$$;

revoke all on function public.aani_can_view_post_comments(uuid, uuid) from public, anon;
revoke all on function public.aani_can_comment_on_post(uuid, uuid) from public, anon;
grant execute on function public.aani_can_view_post_comments(uuid, uuid) to authenticated;
grant execute on function public.aani_can_comment_on_post(uuid, uuid) to authenticated;

-- Restrictive policies combine with the existing permissive policies using AND.
drop policy if exists aani_comments_privacy_read_guard on public.comments;
create policy aani_comments_privacy_read_guard on public.comments
  as restrictive for select to authenticated
  using (public.aani_can_view_post_comments(post_id, (select auth.uid())));

drop policy if exists aani_comments_privacy_insert_guard on public.comments;
create policy aani_comments_privacy_insert_guard on public.comments
  as restrictive for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.aani_can_comment_on_post(post_id, (select auth.uid()))
  );

drop policy if exists aani_likes_privacy_read_guard on public.likes;
create policy aani_likes_privacy_read_guard on public.likes
  as restrictive for select to authenticated
  using (
    exists (
      select 1
      from public.posts p
      where p.id = likes.post_id
        and (
          p.user_id = (select auth.uid())
          or (
            p.visibility <> 'private'
            and (not p.hide_likes or likes.user_id = (select auth.uid()))
          )
        )
    )
  );

drop policy if exists aani_comment_likes_privacy_read_guard on public.comment_likes;
create policy aani_comment_likes_privacy_read_guard on public.comment_likes
  as restrictive for select to authenticated
  using (exists (
    select 1 from public.comments c
    where c.id = comment_likes.comment_id
      and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
  ));
drop policy if exists aani_comment_likes_privacy_insert_guard on public.comment_likes;
create policy aani_comment_likes_privacy_insert_guard on public.comment_likes
  as restrictive for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.comments c
      where c.id = comment_likes.comment_id
        and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
    )
  );

drop policy if exists aani_comment_dislikes_privacy_read_guard on public.comment_dislikes;
create policy aani_comment_dislikes_privacy_read_guard on public.comment_dislikes
  as restrictive for select to authenticated
  using (exists (
    select 1 from public.comments c
    where c.id = comment_dislikes.comment_id
      and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
  ));
drop policy if exists aani_comment_dislikes_privacy_insert_guard on public.comment_dislikes;
create policy aani_comment_dislikes_privacy_insert_guard on public.comment_dislikes
  as restrictive for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.comments c
      where c.id = comment_dislikes.comment_id
        and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
    )
  );

-- The trigger protects inserts made outside the UI as well as RLS writes.
create or replace function public.aani_block_closed_comments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.aani_can_comment_on_post(new.post_id, new.user_id) then
    raise exception 'commenting is not allowed for this post'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists aani_comments_closed_guard on public.comments;
create trigger aani_comments_closed_guard
  before insert on public.comments
  for each row execute function public.aani_block_closed_comments();

-- Keep denormalized counters from disclosing counts hidden by the owner.
create or replace function public.aani_sync_post_counters()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_post uuid;
  delta integer;
begin
  if tg_op = 'INSERT' then
    target_post := new.post_id;
    delta := 1;
  elsif tg_op = 'DELETE' then
    target_post := old.post_id;
    delta := -1;
  else
    return null;
  end if;

  if target_post is null then
    return null;
  end if;

  if tg_table_name = 'likes' then
    update public.posts
      set likes_count = case
        when hide_likes then 0
        else greatest(0, coalesce(likes_count, 0) + delta)
      end
      where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts
      set comments_count = case
        when hide_comments then 0
        else greatest(0, coalesce(comments_count, 0) + delta)
      end
      where id = target_post;
  elsif tg_table_name = 'reposts' then
    update public.posts
      set reposts_count = greatest(0, coalesce(reposts_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'post_shares' then
    update public.posts
      set shares_count = greatest(0, coalesce(shares_count, 0) + delta)
      where id = target_post;
  end if;

  return null;
end;
$$;

create or replace function public.aani_sync_post_privacy_counters()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.posts p
  set
    likes_count = case
      when new.hide_likes then 0
      else greatest(0, coalesce((select count(*) from public.likes l where l.post_id = new.id), 0))
    end,
    comments_count = case
      when new.hide_comments then 0
      else greatest(0, coalesce((select count(*) from public.comments c where c.post_id = new.id), 0))
    end
  where p.id = new.id;
  return new;
end;
$$;

drop trigger if exists aani_post_privacy_counter_sync on public.posts;
create trigger aani_post_privacy_counter_sync
  after update of hide_likes, hide_comments on public.posts
  for each row execute function public.aani_sync_post_privacy_counters();

update public.posts p
set
  likes_count = case
    when p.hide_likes then 0
    else greatest(0, coalesce((select count(*) from public.likes l where l.post_id = p.id), 0))
  end,
  comments_count = case
    when p.hide_comments then 0
    else greatest(0, coalesce((select count(*) from public.comments c where c.post_id = p.id), 0))
  end;

-- The SECURITY DEFINER summary RPC is the only source of true counts for
-- clients. Other viewers receive zero for counts hidden by the post owner.
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
      case
        when p.hide_likes and p.user_id is distinct from auth.uid() then 0::bigint
        else (select count(*) from public.likes l where l.post_id = p.id)::bigint
      end as likes_count,
      case
        when p.hide_comments and p.user_id is distinct from auth.uid() then 0::bigint
        else (select count(*) from public.comments c where c.post_id = p.id)::bigint
      end as comments_count,
      (select count(*) from public.reposts r where r.post_id = p.id)::bigint as reposts_count,
      (select count(*) from public.post_shares s where s.post_id = p.id)::bigint as shares_count,
      exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked_by_me,
      exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted_by_me,
      exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as saved_by_me,
      (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid() limit 1) as feedback_by_me,
      exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared_by_me
    from public.posts p
    where p.id = any(coalesce(p_post_ids, '{}'::uuid[]))
      and (
        p.user_id = auth.uid()
        or p.visibility <> 'private'
      )
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

create or replace function public.get_post_interactions(p_post_ids uuid[])
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

create or replace function public.post_interaction_summaries(post_ids uuid[])
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

commit;
