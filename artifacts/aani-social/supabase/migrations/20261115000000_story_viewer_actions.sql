-- Secure account actions from story viewer lists.
-- Block relationships, per-owner story hiding, account reports, and RLS guards.
begin;

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_user_id),
  constraint aani_user_blocks_not_self check (blocker_id <> blocked_user_id)
);

create table if not exists public.story_hidden_users (
  story_owner_id uuid not null references public.profiles(id) on delete cascade,
  hidden_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_owner_id, hidden_user_id),
  constraint aani_story_hidden_users_not_self check (story_owner_id <> hidden_user_id)
);

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

create index if not exists aani_user_blocks_blocked_user_idx
  on public.user_blocks (blocked_user_id, blocker_id);
create index if not exists aani_story_hidden_users_hidden_idx
  on public.story_hidden_users (hidden_user_id, story_owner_id);
create index if not exists aani_user_reports_target_created_idx
  on public.user_reports (reported_user_id, created_at desc);

alter table public.user_blocks enable row level security;
alter table public.story_hidden_users enable row level security;
alter table public.user_reports enable row level security;

revoke all on public.user_blocks from public, anon, authenticated;
revoke all on public.story_hidden_users from public, anon, authenticated;
revoke all on public.user_reports from public, anon, authenticated;
grant select on public.user_blocks, public.story_hidden_users, public.user_reports to authenticated;
grant insert (reporter_id, reported_user_id, category, details) on public.user_reports to authenticated;

drop policy if exists aani_user_blocks_select_own on public.user_blocks;
create policy aani_user_blocks_select_own on public.user_blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

drop policy if exists aani_story_hidden_users_select_own on public.story_hidden_users;
create policy aani_story_hidden_users_select_own on public.story_hidden_users
  for select to authenticated using (story_owner_id = (select auth.uid()));

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

-- Callable inside restrictive RLS policies and triggers, but users can only
-- ask about a relationship that includes their own account.
create or replace function public.aani_is_user_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and auth.uid() in (p_user_a, p_user_b)
    and exists (
      select 1
      from public.user_blocks as blocked
      where (blocked.blocker_id = p_user_a and blocked.blocked_user_id = p_user_b)
         or (blocked.blocker_id = p_user_b and blocked.blocked_user_id = p_user_a)
    ),
    false
  );
$$;
revoke all on function public.aani_is_user_blocked(uuid, uuid) from public;
grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated;

create or replace function public.aani_block_user(p_blocked_user_id uuid)
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
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to block' using errcode = '22023';
  end if;

  insert into public.user_blocks (blocker_id, blocked_user_id)
  values (actor_id, p_blocked_user_id)
  on conflict (blocker_id, blocked_user_id) do nothing;

  delete from public.follows
  where (follower_id = actor_id and following_id = p_blocked_user_id)
     or (follower_id = p_blocked_user_id and following_id = actor_id);

  delete from public.follow_requests
  where (requester_id = actor_id and recipient_id = p_blocked_user_id)
     or (requester_id = p_blocked_user_id and recipient_id = actor_id);

  delete from public.close_friends
  where (user_id = actor_id and friend_id = p_blocked_user_id)
     or (user_id = p_blocked_user_id and friend_id = actor_id);
end;
$$;
revoke all on function public.aani_block_user(uuid) from public;
grant execute on function public.aani_block_user(uuid) to authenticated;

create or replace function public.aani_hide_story_from_user(p_hidden_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_hidden_user_id is null or p_hidden_user_id = owner_id then
    raise exception 'Invalid user to hide stories from' using errcode = '22023';
  end if;

  insert into public.story_hidden_users (story_owner_id, hidden_user_id)
  values (owner_id, p_hidden_user_id)
  on conflict (story_owner_id, hidden_user_id) do nothing;
end;
$$;
revoke all on function public.aani_hide_story_from_user(uuid) from public;
grant execute on function public.aani_hide_story_from_user(uuid) to authenticated;

-- Keep the existing privacy, expiry, and reshare-chain rules while adding
-- mutual blocks and persistent per-owner hiding for every story in the chain.
create or replace function public.aani_can_view_story(p_story_id uuid, p_viewer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive story_chain (
    id,
    user_id,
    is_close_friends,
    original_story_id,
    created_at,
    expires_at,
    media_url,
    media_type,
    share_type,
    parent_link_valid
  ) as (
    select
      story.id,
      story.user_id,
      story.is_close_friends,
      story.original_story_id,
      story.created_at,
      story.expires_at,
      story.media_url,
      story.media_type,
      story.share_type,
      true
    from public.stories as story
    where story.id = p_story_id

    union all

    select
      original.id,
      original.user_id,
      original.is_close_friends,
      original.original_story_id,
      original.created_at,
      original.expires_at,
      original.media_url,
      original.media_type,
      original.share_type,
      child.share_type = 'reshare'
        and child.media_url is not distinct from original.media_url
        and child.media_type = original.media_type
    from public.stories as original
    join story_chain as child on child.original_story_id = original.id
  )
  select
    p_viewer_id is not null
    and exists (select 1 from story_chain where id = p_story_id)
    and not exists (
      select 1
      from story_chain as story
      join public.profiles as owner on owner.id = story.user_id
      where story.created_at < now() - interval '24 hours'
        or story.created_at > now() + interval '5 minutes'
        or story.expires_at <= now()
        or story.expires_at > story.created_at + interval '24 hours'
        or not story.parent_link_valid
        or (
          story.user_id <> p_viewer_id
          and (
            exists (
              select 1 from public.user_blocks as blocked
              where (blocked.blocker_id = story.user_id and blocked.blocked_user_id = p_viewer_id)
                 or (blocked.blocker_id = p_viewer_id and blocked.blocked_user_id = story.user_id)
            )
            or exists (
              select 1 from public.story_hidden_users as hidden
              where hidden.story_owner_id = story.user_id
                and hidden.hidden_user_id = p_viewer_id
            )
            or (owner.is_private and not exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = story.user_id
            ))
            or (
              story.is_close_friends
              and (
                not exists (
                  select 1
                  from public.close_friends as listed
                  where listed.user_id = story.user_id
                    and listed.friend_id = p_viewer_id
                )
                or not public.aani_is_mutual_follow(story.user_id, p_viewer_id)
              )
            )
          )
        )
    );
$$;
revoke all on function public.aani_can_view_story(uuid, uuid) from public;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;

-- Keep a restrictive stories policy bound to the updated server-side visibility function.
drop policy if exists aani_stories_followers_guard on public.stories;
create policy aani_stories_followers_guard on public.stories
  as restrictive for select to authenticated
  using (public.aani_can_view_story(id, (select auth.uid())));

drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_views.user_id)
    )
  );
drop policy if exists aani_story_views_owner_guard on public.story_views;
create policy aani_story_views_owner_guard on public.story_views
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_views.user_id)
    )
  );

drop policy if exists aani_story_views_insert_guard on public.story_views;
create policy aani_story_views_insert_guard on public.story_views
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

drop policy if exists aani_story_likes_select_own on public.story_likes;
create policy aani_story_likes_select_own on public.story_likes
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_likes.user_id)
    )
  );
drop policy if exists aani_story_likes_owner_guard on public.story_likes;
create policy aani_story_likes_owner_guard on public.story_likes
  as restrictive for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_likes.user_id)
    )
  );

drop policy if exists aani_story_likes_insert_own on public.story_likes;
create policy aani_story_likes_insert_own on public.story_likes
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );
drop policy if exists aani_story_likes_insert_guard on public.story_likes;
create policy aani_story_likes_insert_guard on public.story_likes
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

-- Blocks prevent further contacts/follows and all new social interactions with
-- the blocked profile. Existing content and messages are not deleted.
drop policy if exists "Users can read their own messages" on public.messages;
create policy "Users can read their own messages" on public.messages
  for select to authenticated using (
    (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
    and not public.aani_is_user_blocked(sender_id, recipient_id)
  );
drop policy if exists "Users can send messages as themselves" on public.messages;
create policy "Users can send messages as themselves" on public.messages
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and sender_id <> recipient_id
    and not public.aani_is_user_blocked(sender_id, recipient_id)
  );
drop policy if exists aani_messages_block_select_guard on public.messages;
create policy aani_messages_block_select_guard on public.messages
  as restrictive for select to authenticated using (
    (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
    and not public.aani_is_user_blocked(sender_id, recipient_id)
  );
drop policy if exists aani_messages_block_insert_guard on public.messages;
create policy aani_messages_block_insert_guard on public.messages
  as restrictive for insert to authenticated with check (
    sender_id = (select auth.uid())
    and sender_id <> recipient_id
    and not public.aani_is_user_blocked(sender_id, recipient_id)
  );

drop policy if exists aani_follows_block_guard on public.follows;
create policy aani_follows_block_guard on public.follows
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(follower_id, following_id));
drop policy if exists aani_follow_requests_block_guard on public.follow_requests;
create policy aani_follow_requests_block_guard on public.follow_requests
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(requester_id, recipient_id));
drop policy if exists aani_close_friends_block_guard on public.close_friends;
create policy aani_close_friends_block_guard on public.close_friends
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(user_id, friend_id));
drop policy if exists aani_story_mentions_block_guard on public.story_mentions;
create policy aani_story_mentions_block_guard on public.story_mentions
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(author_id, mentioned_id));
drop policy if exists aani_notifications_block_guard on public.notifications;
create policy aani_notifications_block_guard on public.notifications
  as restrictive for insert to authenticated
  with check (
    actor_id is null
    or user_id is null
    or not public.aani_is_user_blocked(actor_id, user_id)
  );
drop policy if exists aani_notifications_block_read_guard on public.notifications;
create policy aani_notifications_block_read_guard on public.notifications
  as restrictive for select to authenticated
  using (actor_id is null or not public.aani_is_user_blocked((select auth.uid()), actor_id));
drop policy if exists aani_story_mentions_block_read_guard on public.story_mentions;
create policy aani_story_mentions_block_read_guard on public.story_mentions
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), author_id));

drop policy if exists aani_posts_block_guard on public.posts;
create policy aani_posts_block_guard on public.posts
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));

drop policy if exists aani_comments_block_guard on public.comments;
create policy aani_comments_block_guard on public.comments
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));

drop policy if exists aani_likes_block_read_guard on public.likes;
create policy aani_likes_block_read_guard on public.likes
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));
drop policy if exists aani_comment_likes_block_read_guard on public.comment_likes;
create policy aani_comment_likes_block_read_guard on public.comment_likes
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));
drop policy if exists aani_comment_dislikes_block_read_guard on public.comment_dislikes;
create policy aani_comment_dislikes_block_read_guard on public.comment_dislikes
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));
drop policy if exists aani_reposts_block_read_guard on public.reposts;
create policy aani_reposts_block_read_guard on public.reposts
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));
drop policy if exists aani_post_shares_block_read_guard on public.post_shares;
create policy aani_post_shares_block_read_guard on public.post_shares
  as restrictive for select to authenticated
  using (not public.aani_is_user_blocked((select auth.uid()), user_id));

create or replace function public.aani_prevent_blocked_interaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  target_id uuid;
  parent_author_id uuid;
begin
  case tg_table_name
    when 'messages' then
      actor_id := new.sender_id;
      target_id := new.recipient_id;
    when 'follows' then
      actor_id := new.follower_id;
      target_id := new.following_id;
    when 'follow_requests' then
      actor_id := new.requester_id;
      target_id := new.recipient_id;
    when 'close_friends' then
      actor_id := new.user_id;
      target_id := new.friend_id;
    when 'story_mentions' then
      actor_id := new.author_id;
      target_id := new.mentioned_id;
    when 'notifications' then
      actor_id := new.actor_id;
      target_id := new.user_id;
    when 'likes' then
      actor_id := new.user_id;
      select post.user_id into target_id from public.posts as post where post.id = new.post_id;
    when 'comments' then
      actor_id := new.user_id;
      select post.user_id into target_id from public.posts as post where post.id = new.post_id;
      if new.parent_id is not null then
        select parent.user_id into parent_author_id
        from public.comments as parent
        where parent.id = new.parent_id;
      end if;
    when 'comment_likes' then
      actor_id := new.user_id;
      select comment.user_id into target_id from public.comments as comment where comment.id = new.comment_id;
    when 'comment_dislikes' then
      actor_id := new.user_id;
      select comment.user_id into target_id from public.comments as comment where comment.id = new.comment_id;
    when 'story_likes' then
      actor_id := new.user_id;
      select story.user_id into target_id from public.stories as story where story.id = new.story_id;
    when 'post_feedback' then
      actor_id := new.user_id;
      select post.user_id into target_id from public.posts as post where post.id = new.post_id;
    when 'post_shares' then
      actor_id := new.user_id;
      select post.user_id into target_id from public.posts as post where post.id = new.post_id;
    when 'reposts' then
      actor_id := new.user_id;
      select post.user_id into target_id from public.posts as post where post.id = new.post_id;
    else
      return new;
  end case;

  if actor_id is not null
     and actor_id = auth.uid()
     and (
       public.aani_is_user_blocked(actor_id, target_id)
       or public.aani_is_user_blocked(actor_id, parent_author_id)
     ) then
    raise exception 'Interaction is not allowed between blocked accounts' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.aani_prevent_blocked_interaction() from public;

drop trigger if exists aani_blocked_messages_trg on public.messages;
create trigger aani_blocked_messages_trg before insert or update on public.messages
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_follows_trg on public.follows;
create trigger aani_blocked_follows_trg before insert or update on public.follows
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_follow_requests_trg on public.follow_requests;
create trigger aani_blocked_follow_requests_trg before insert or update on public.follow_requests
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_close_friends_trg on public.close_friends;
create trigger aani_blocked_close_friends_trg before insert or update on public.close_friends
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_story_mentions_trg on public.story_mentions;
create trigger aani_blocked_story_mentions_trg before insert or update on public.story_mentions
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_notifications_trg on public.notifications;
create trigger aani_blocked_notifications_trg before insert or update on public.notifications
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_likes_trg on public.likes;
create trigger aani_blocked_likes_trg before insert or update on public.likes
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_comments_trg on public.comments;
create trigger aani_blocked_comments_trg before insert or update on public.comments
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_comment_likes_trg on public.comment_likes;
create trigger aani_blocked_comment_likes_trg before insert or update on public.comment_likes
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_comment_dislikes_trg on public.comment_dislikes;
create trigger aani_blocked_comment_dislikes_trg before insert or update on public.comment_dislikes
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_story_likes_trg on public.story_likes;
create trigger aani_blocked_story_likes_trg before insert or update on public.story_likes
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_post_feedback_trg on public.post_feedback;
create trigger aani_blocked_post_feedback_trg before insert or update on public.post_feedback
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_post_shares_trg on public.post_shares;
create trigger aani_blocked_post_shares_trg before insert or update on public.post_shares
  for each row execute function public.aani_prevent_blocked_interaction();
drop trigger if exists aani_blocked_reposts_trg on public.reposts;
create trigger aani_blocked_reposts_trg before insert or update on public.reposts
  for each row execute function public.aani_prevent_blocked_interaction();

alter table public.story_views replica identity full;
alter table public.story_likes replica identity full;
do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['story_views', 'story_likes'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', target_table);
      exception
        when duplicate_object then null;
        when undefined_object then null;
        when others then null;
      end;
    end loop;
  end if;
end;
$$;

commit;
