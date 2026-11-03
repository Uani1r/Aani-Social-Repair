-- Aani Supabase schema and migration.
-- Safe to re-run: this adds the new app fields/tables and policies without
-- deleting existing profile or post rows.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  full_name text,
  avatar_url text,
  bio text not null default '',
  display_name text not null default 'New member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists display_name text not null default 'New member';
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- Backfill rows created by the previous Social Feed schema.
update public.profiles as p
set full_name = coalesce(
  nullif(btrim(p.full_name), ''),
  nullif(btrim(p.display_name), ''),
  nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
  'Member'
)
from auth.users as u
where p.id = u.id
  and (p.full_name is null or btrim(p.full_name) = '');

update public.profiles
set username = replace(id::text, '-', '')
where username is null or btrim(username) = '';

alter table public.profiles alter column username set not null;
alter table public.profiles alter column full_name set not null;
alter table public.profiles drop constraint if exists profiles_username_format_check;
alter table public.profiles
  add constraint profiles_username_format_check
  check (username ~ '^[a-z0-9_.]{3,32}$');
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  content text not null default '',
  media_url text,
  type text not null default 'text',
  created_at timestamptz not null default now()
);

alter table public.posts add column if not exists media_url text;
alter table public.posts add column if not exists type text not null default 'text';
alter table public.posts alter column content set default '';

-- The previous schema required non-empty text and capped it at 500 characters.
-- Media-only posts are now valid; existing content is preserved.
alter table public.posts drop constraint if exists posts_content_check;
alter table public.posts drop constraint if exists posts_content_length_check;
alter table public.posts
  add constraint posts_content_length_check
  check (
    char_length(content) <= 2000
    and (char_length(btrim(content)) > 0 or media_url is not null)
  );
alter table public.posts drop constraint if exists posts_type_check;
alter table public.posts
  add constraint posts_type_check
  check (type in ('text', 'photo', 'reel'));
alter table public.posts drop constraint if exists posts_media_type_check;
alter table public.posts
  add constraint posts_media_type_check
  check (
    (type = 'text' and media_url is null)
    or (type in ('photo', 'reel') and media_url is not null)
  );

create index if not exists posts_created_at_idx
  on public.posts (created_at desc);
create index if not exists posts_user_created_at_idx
  on public.posts (user_id, created_at desc);

create table if not exists public.likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  parent_id uuid,
  content text not null,
  image_url text,
  created_at timestamptz not null default now()
);

alter table public.comments add column if not exists parent_id uuid;
alter table public.comments add column if not exists image_url text;
alter table public.comments
  drop constraint if exists comments_content_check,
  drop constraint if exists comments_content_or_image_check;
alter table public.comments
  add constraint comments_content_or_image_check
  check (
    char_length(content) <= 2000
    and (
      char_length(btrim(content)) > 0
      or nullif(btrim(image_url), '') is not null
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.comments'::regclass
      and conname = 'comments_parent_id_fkey'
  ) then
    alter table public.comments
      add constraint comments_parent_id_fkey
      foreign key (parent_id)
      references public.comments (id)
      on delete set null;
  end if;
end
$$;

create index if not exists comments_parent_created_at_idx
  on public.comments (parent_id, created_at)
  where parent_id is not null;

create or replace function public.aani_validate_comment_parent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.parent_id is not null and not exists (
    select 1
    from public.comments parent
    where parent.id = new.parent_id
      and parent.post_id = new.post_id
  ) then
    raise exception 'Reply must belong to the same post as its parent'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists aani_validate_comment_parent on public.comments;
create trigger aani_validate_comment_parent
  before insert or update of parent_id, post_id on public.comments
  for each row execute function public.aani_validate_comment_parent();

create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create unique index if not exists comment_likes_comment_user_uidx
  on public.comment_likes (comment_id, user_id);

create table if not exists public.comment_dislikes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_not_self_check check (follower_id <> following_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default now(),
  constraint messages_not_self_check check (sender_id <> recipient_id)
);

create index if not exists comments_post_created_at_idx
  on public.comments (post_id, created_at);
create index if not exists follows_following_idx
  on public.follows (following_id, follower_id);
create index if not exists messages_sender_created_at_idx
  on public.messages (sender_id, created_at);
create index if not exists messages_recipient_created_at_idx
  on public.messages (recipient_id, created_at);

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_dislikes enable row level security;
alter table public.follows enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Signed-in users can read profiles" on public.profiles;
create policy "Signed-in users can read profiles"
  on public.profiles for select to authenticated
  using (true);
drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "Signed-in users can read posts" on public.posts;
create policy "Signed-in users can read posts"
  on public.posts for select to authenticated
  using (true);
drop policy if exists "Users can create their own posts" on public.posts;
create policy "Users can create their own posts"
  on public.posts for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can delete their own posts" on public.posts;
create policy "Users can delete their own posts"
  on public.posts for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Signed-in users can read likes" on public.likes;
create policy "Signed-in users can read likes"
  on public.likes for select to authenticated
  using (true);
drop policy if exists "Users can like posts as themselves" on public.likes;
create policy "Users can like posts as themselves"
  on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can remove their own likes" on public.likes;
create policy "Users can remove their own likes"
  on public.likes for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Signed-in users can read comments" on public.comments;
create policy "Signed-in users can read comments"
  on public.comments for select to authenticated
  using (true);
drop policy if exists "Users can create comments as themselves" on public.comments;
create policy "Users can create comments as themselves"
  on public.comments for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can delete their own comments" on public.comments;
create policy "Users can delete their own comments"
  on public.comments for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Signed-in users can read comment likes" on public.comment_likes;
create policy "Signed-in users can read comment likes"
  on public.comment_likes for select to authenticated
  using (true);
drop policy if exists "Users can like comments as themselves" on public.comment_likes;
create policy "Users can like comments as themselves"
  on public.comment_likes for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can remove their own comment likes" on public.comment_likes;
create policy "Users can remove their own comment likes"
  on public.comment_likes for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Signed-in users can read comment dislikes" on public.comment_dislikes;
create policy "Signed-in users can read comment dislikes"
  on public.comment_dislikes for select to authenticated
  using (true);
drop policy if exists "Users can dislike comments as themselves" on public.comment_dislikes;
create policy "Users can dislike comments as themselves"
  on public.comment_dislikes for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can remove their own comment dislikes" on public.comment_dislikes;
create policy "Users can remove their own comment dislikes"
  on public.comment_dislikes for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.aani_clear_opposite_comment_reaction()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'comment_likes' then
    delete from public.comment_dislikes
    where comment_id = new.comment_id and user_id = new.user_id;
  else
    delete from public.comment_likes
    where comment_id = new.comment_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_comment_likes_exclusive on public.comment_likes;
create trigger aani_comment_likes_exclusive
  after insert on public.comment_likes
  for each row execute function public.aani_clear_opposite_comment_reaction();

drop trigger if exists aani_comment_dislikes_exclusive on public.comment_dislikes;
create trigger aani_comment_dislikes_exclusive
  after insert on public.comment_dislikes
  for each row execute function public.aani_clear_opposite_comment_reaction();

drop policy if exists "Signed-in users can read follows" on public.follows;
create policy "Signed-in users can read follows"
  on public.follows for select to authenticated
  using (true);
drop policy if exists "Users can follow as themselves" on public.follows;
create policy "Users can follow as themselves"
  on public.follows for insert to authenticated
  with check (follower_id = (select auth.uid()) and follower_id <> following_id);
drop policy if exists "Users can unfollow as themselves" on public.follows;
create policy "Users can unfollow as themselves"
  on public.follows for delete to authenticated
  using (follower_id = (select auth.uid()));

drop policy if exists "Users can read their own messages" on public.messages;
create policy "Users can read their own messages"
  on public.messages for select to authenticated
  using (
    sender_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );
drop policy if exists "Users can send messages as themselves" on public.messages;
create policy "Users can send messages as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and sender_id <> recipient_id
  );

grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.posts to authenticated;
grant select, insert, delete on public.likes to authenticated;
grant select, insert, delete on public.comments to authenticated;
grant select, insert, delete on public.comment_likes to authenticated;
grant select, insert, delete on public.comment_dislikes to authenticated;
grant select, insert, delete on public.follows to authenticated;
grant select, insert on public.messages to authenticated;

-- The bucket is public for media playback/rendering. Writes are still restricted
-- to the authenticated user's own UUID folder by the object policies below.
insert into storage.buckets (id, name, public)
values ('aani-media', 'aani-media', true)
on conflict (id) do nothing;

drop policy if exists "Aani media is readable by signed-in users" on storage.objects;
create policy "Aani media is readable by signed-in users"
  on storage.objects for select to authenticated
  using (bucket_id = 'aani-media');
drop policy if exists "Users can upload their own Aani media" on storage.objects;
create policy "Users can upload their own Aani media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'aani-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users can update their own Aani media" on storage.objects;
create policy "Users can update their own Aani media"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'aani-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'aani-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users can delete their own Aani media" on storage.objects;
create policy "Users can delete their own Aani media"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'aani-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Realtime only needs to broadcast new messages for the live chat flow.
alter table public.messages replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'messages'
     ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end;
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_full_name text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''),
    '[^a-z0-9_.]',
    '',
    'g'
  ));
  if char_length(requested_username) < 3 then
    requested_username := replace(new.id::text, '-', '');
  end if;

  requested_full_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Member'
  );

  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    left(requested_username, 32),
    left(requested_full_name, 120)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

-- =====================================================================
-- Persistent interactions: likes, comments, reposts, shares, bookmarks.
-- Same content as supabase/migrations/20261026000000_interaction_persistence.sql
-- so running this file alone on a fresh project is enough. Idempotent.
-- =====================================================================

alter table public.posts
  add column if not exists likes_count integer not null default 0,
  add column if not exists comments_count integer not null default 0,
  add column if not exists reposts_count integer not null default 0,
  add column if not exists shares_count integer not null default 0;

create index if not exists posts_likes_count_idx on public.posts (likes_count desc);
create index if not exists posts_comments_count_idx on public.posts (comments_count desc);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_bookmarks_post_user_unique unique (post_id, user_id)
);

create table if not exists public.reposts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_reposts_post_user_unique unique (post_id, user_id)
);

create table if not exists public.post_shares (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists aani_post_shares_post_user_unique
  on public.post_shares (post_id, user_id);
create index if not exists aani_post_shares_post_idx on public.post_shares (post_id);
create index if not exists aani_post_shares_user_idx on public.post_shares (user_id);
create index if not exists aani_bookmarks_user_idx on public.bookmarks (user_id);
create index if not exists aani_reposts_user_idx on public.reposts (user_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null default 'system',
  content text,
  reference_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists aani_notifications_user_idx
  on public.notifications (user_id, created_at desc);

alter table public.bookmarks enable row level security;
alter table public.reposts enable row level security;
alter table public.post_shares enable row level security;
alter table public.notifications enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'post_shares' and policyname = 'aani_post_shares_select_own') then
    create policy aani_post_shares_select_own on public.post_shares
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'post_shares' and policyname = 'aani_post_shares_insert_own') then
    create policy aani_post_shares_insert_own on public.post_shares
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'post_shares' and policyname = 'aani_post_shares_delete_own') then
    create policy aani_post_shares_delete_own on public.post_shares
      for delete using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bookmarks' and policyname = 'aani_bookmarks_select_own') then
    create policy aani_bookmarks_select_own on public.bookmarks
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bookmarks' and policyname = 'aani_bookmarks_insert_own') then
    create policy aani_bookmarks_insert_own on public.bookmarks
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bookmarks' and policyname = 'aani_bookmarks_delete_own') then
    create policy aani_bookmarks_delete_own on public.bookmarks
      for delete using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reposts' and policyname = 'aani_reposts_select_own') then
    create policy aani_reposts_select_own on public.reposts
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reposts' and policyname = 'aani_reposts_insert_own') then
    create policy aani_reposts_insert_own on public.reposts
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reposts' and policyname = 'aani_reposts_delete_own') then
    create policy aani_reposts_delete_own on public.reposts
      for delete using (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, delete on public.bookmarks to authenticated;
grant select, insert, delete on public.reposts to authenticated;
grant select, insert on public.post_shares to authenticated, anon;
grant select, update, insert on public.notifications to authenticated;

-- Counters are maintained by triggers so every client sees the same numbers.
create or replace function public.aani_sync_post_counters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post uuid;
  delta integer;
begin
  if tg_op = 'INSERT' then
    target_post := new.post_id;
    delta := 1;
  else
    target_post := old.post_id;
    delta := -1;
  end if;

  if target_post is null then
    return null;
  end if;

  if tg_table_name = 'likes' then
    update public.posts
      set likes_count = greatest(0, coalesce(likes_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts
      set comments_count = greatest(0, coalesce(comments_count, 0) + delta)
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

drop trigger if exists aani_likes_counter on public.likes;
create trigger aani_likes_counter
  after insert or delete on public.likes
  for each row execute function public.aani_sync_post_counters();

drop trigger if exists aani_comments_counter on public.comments;
create trigger aani_comments_counter
  after insert or delete on public.comments
  for each row execute function public.aani_sync_post_counters();

drop trigger if exists aani_reposts_counter on public.reposts;
create trigger aani_reposts_counter
  after insert or delete on public.reposts
  for each row execute function public.aani_sync_post_counters();

drop trigger if exists aani_post_shares_counter on public.post_shares;
create trigger aani_post_shares_counter
  after insert or delete on public.post_shares
  for each row execute function public.aani_sync_post_counters();

update public.posts p set
  likes_count = coalesce((select count(*) from public.likes l where l.post_id = p.id), 0),
  comments_count = coalesce((select count(*) from public.comments c where c.post_id = p.id), 0),
  reposts_count = coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0),
  shares_count = coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0);

-- The unified interaction RPCs are defined after post_feedback below so both
-- endpoints expose the same counters and viewer-specific flags.

-- Broadcast interactions so counters update live across clients.
alter table public.posts replica identity full;
alter table public.likes replica identity full;
alter table public.comments replica identity full;
  alter table public.comment_likes replica identity full;
  alter table public.comment_dislikes replica identity full;
alter table public.reposts replica identity full;
alter table public.bookmarks replica identity full;
alter table public.post_shares replica identity full;

do $$
declare
  target text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target in array array['likes', 'comments', 'comment_likes', 'comment_dislikes', 'reposts', 'bookmarks', 'post_shares', 'posts']
    loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', target);
      exception
        when duplicate_object then null;
        when undefined_object then null;
        when others then null;
      end;
    end loop;
  end if;
end $$;

-- =====================================================================
-- Post reports (إبلاغ عن المنشورات)
-- Backs the post action dropdown "Report" option for non-owner users.
-- Idempotent: safe to run multiple times.
-- =====================================================================

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete set null,
  reason text not null default 'محتوى غير مناسب',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Repair / upgrade an existing table (no-op on a fresh database)
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists reporter_id uuid;
alter table public.reports add column if not exists reported_user_id uuid;
alter table public.reports add column if not exists status text not null default 'pending';
-- Kept only so legacy clients and legacy rows stay valid; newer code
-- writes reporter_id. Both are kept in sync by a trigger below.
alter table public.reports add column if not exists user_id uuid;

-- Backfill both directions for rows created by either code path.
update public.reports set reporter_id = user_id where reporter_id is null and user_id is not null;
update public.reports set user_id = reporter_id where user_id is null and reporter_id is not null;

-- Rows with no attributable reporter cannot satisfy the contract below.
delete from public.reports where reporter_id is null;

-- Deduplicate before enforcing one report per (post, user).
delete from public.reports a
 using public.reports b
 where a.ctid > b.ctid
   and a.post_id = b.post_id
   and a.reporter_id = b.reporter_id;

alter table public.reports alter column reporter_id set not null;
-- Legacy NOT NULL on user_id would block inserts that only send reporter_id.
alter table public.reports alter column user_id drop not null;

-- ---------------------------------------------------------------------
-- Foreign keys
-- Guarded by "does a FK already cover this column", not by constraint
-- name: `create table if not exists` above may have created inline FKs
-- with auto-generated names on a fresh database.
-- ---------------------------------------------------------------------
do $
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'post_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_post_fk
      foreign key (post_id) references public.posts(id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'reporter_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_reporter_fk
      foreign key (reporter_id) references public.profiles(id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'reported_user_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_reported_user_fk
      foreign key (reported_user_id) references public.profiles(id) on delete set null;
  end if;
end $;

create unique index if not exists aani_reports_post_reporter_unique_idx
  on public.reports (post_id, reporter_id);

create index if not exists aani_reports_status_idx
  on public.reports (status, created_at desc);
create index if not exists aani_reports_post_idx on public.reports (post_id);

-- ---------------------------------------------------------------------
-- Accept either insert shape: {reporter_id} or legacy {user_id}
-- ---------------------------------------------------------------------
create or replace function public.aani_reports_normalize()
returns trigger
language plpgsql
as $$
begin
  if new.reporter_id is null then
    new.reporter_id := new.user_id;
  end if;
  if new.user_id is null then
    new.user_id := new.reporter_id;
  end if;
  return new;
end $$;

drop trigger if exists aani_reports_normalize_trg on public.reports;
create trigger aani_reports_normalize_trg
  before insert or update on public.reports
  for each row execute function public.aani_reports_normalize();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.reports enable row level security;

-- Policies OR together, so these only ever widen access for the reporter
-- themselves. Pre-existing policies on the legacy table are left intact.
do $$
begin
  -- A reporter can read back their own reports (used to detect duplicates).
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_select_own') then
    create policy aani_reports_select_own on public.reports
      for select using (auth.uid() = reporter_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_insert_own') then
    create policy aani_reports_insert_own on public.reports
      for insert with check (auth.uid() = reporter_id);
  end if;

  -- Reporters may withdraw their own report.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_delete_own') then
    create policy aani_reports_delete_own on public.reports
      for delete using (auth.uid() = reporter_id);
  end if;

  -- Moderators (service role bypasses RLS) may triage reports; authenticated
  -- users never see other people's reports.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_update_own') then
    create policy aani_reports_update_own on public.reports
      for update using (auth.uid() = reporter_id) with check (auth.uid() = reporter_id);
  end if;
end $$;

grant select, insert, update, delete on public.reports to authenticated;

alter table public.reports replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.reports';
    exception
      when duplicate_object then null;
      when undefined_object then null;
      when others then null;
    end;
  end if;
end $$;

-- =====================================================================
-- Post controls (خيارات المنشور) — mirrors
-- supabase/migrations/20261028000000_post_controls.sql
-- =====================================================================

alter table public.posts add column if not exists comments_disabled boolean not null default false;
alter table public.posts add column if not exists audio_url text;
alter table public.posts add column if not exists audio_title text;

create table if not exists public.post_feedback (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  feedback text not null check (feedback in ('interested', 'not_interested')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aani_post_feedback_post_user_unique unique (post_id, user_id)
);

-- Both RPCs expose the same response and security semantics. Keep the legacy
-- field names as aliases while clients transition to the canonical names.
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

create index if not exists aani_post_feedback_user_idx
  on public.post_feedback (user_id, updated_at desc);
create index if not exists aani_post_feedback_post_idx
  on public.post_feedback (post_id);

alter table public.post_feedback enable row level security;

drop policy if exists "Users manage their own post feedback" on public.post_feedback;
create policy "Users manage their own post feedback"
  on public.post_feedback for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.post_feedback to authenticated;

alter table public.post_feedback replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'post_feedback'
     ) then
    begin
      execute 'alter publication supabase_realtime add table public.post_feedback';
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end $$;

create or replace function public.aani_touch_post_feedback()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists aani_post_feedback_touch on public.post_feedback;
create trigger aani_post_feedback_touch
  before update on public.post_feedback
  for each row execute function public.aani_touch_post_feedback();

-- Authoritative guard: no new comment on a post whose comments are closed.
create or replace function public.aani_block_closed_comments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.posts p
    where p.id = new.post_id and p.comments_disabled = true
  ) then
    raise exception 'comments are disabled for this post' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists aani_comments_closed_guard on public.comments;
create trigger aani_comments_closed_guard
  before insert on public.comments
  for each row execute function public.aani_block_closed_comments();
