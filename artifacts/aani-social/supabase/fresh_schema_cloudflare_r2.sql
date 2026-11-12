-- ============================================================================
-- Aani — Fresh clean schema for the NEW Supabase project
-- (المصادقة والجداول فقط — بدون Supabase Storage إطلاقاً؛ الوسائط على Cloudflare R2)
--
-- التشغيل: Supabase SQL Editor → New query → الصق الملف كاملاً → Run.
-- مكتوب لمشروع جديد فارغ، بالترتيب الصحيح للعلاقات، بلا خطوات "إصلاح" قديمة.
-- ============================================================================

-- 1) الملفات الشخصية =========================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  full_name text not null,
  avatar_url text,
  cover_url text,
  cover_position_x real not null default 50,
  cover_position_y real not null default 50,
  location text,
  city text,
  job text,
  birth_date date,
  show_city boolean not null default true,
  show_job boolean not null default false,
  show_birth_date boolean not null default false,
  website text,
  bio text not null default '',
  display_name text not null default 'New member',
  notification_settings jsonb not null default '{"messages": true, "followers": true, "interactions": true, "stories": true}'::jsonb,
  appearance_preference text not null default 'dark' check (appearance_preference in ('dark', 'light', 'system')),
  language_preference text not null default 'ar' check (language_preference in ('ar', 'en')),
  hd_uploads boolean not null default true,
  data_saver boolean not null default false,
  font_preference text not null default 'alexandria' check (font_preference in ('alexandria', 'ibm-plex-sans-arabic', 'tajawal', 'cairo', 'noto-sans-arabic')),
  gender text not null default 'male' check (gender in ('male', 'female')),
  is_nearby_visible boolean not null default true,
  is_private boolean not null default false,
  is_deactivated boolean not null default false,
  fcm_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_username_lower_idx on public.profiles (lower(username));

grant update (fcm_token) on table public.profiles to authenticated;

-- 2) المنشورات (بكل الأعمدة التي يطلبها استعلام الواجهة فعلياً) ==============
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  content text not null default '',
  post_metadata jsonb not null default '[]'::jsonb,
  tagged_user_ids uuid[] not null default '{}'::uuid[],
  media_url text,
  media_urls text[],
  media_asset_id uuid,
  type text not null default 'text' check (type in ('text', 'photo', 'reel')),
  destination text not null default 'feed' check (destination in ('feed', 'reels') and (destination <> 'reels' or type = 'reel')),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  display_order integer not null default 0,
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  reposts_count integer not null default 0,
  shares_count integer not null default 0,
  comments_disabled boolean not null default false,
  hide_likes boolean not null default false,
  hide_comments boolean not null default false,
  comment_privacy text not null default 'public' check (comment_privacy in ('public', 'followers', 'custom')),
  allowed_commenters uuid[] not null default '{}'::uuid[],
  audio_url text,
  audio_title text,
  sound_id uuid,
  sound_trim_start real,
  sound_trim_end real,
  trim_start real,
  trim_end real,
  created_at timestamptz not null default now(),
  constraint posts_content_length_check check (
    char_length(content) <= 2000
    and (char_length(btrim(content)) > 0 or media_url is not null or post_metadata <> '[]'::jsonb)
  ),
  constraint posts_post_metadata_array_check check (jsonb_typeof(post_metadata) = 'array'),
  constraint posts_media_type_check check (
    (type = 'text' and media_url is null)
    or (type in ('photo', 'reel') and media_url is not null)
  )
);

create index posts_created_at_idx on public.posts (created_at desc);
create index posts_user_created_at_idx on public.posts (user_id, created_at desc);
create index posts_user_display_order_idx on public.posts (user_id, display_order, created_at desc);
create index posts_destination_created_at_idx on public.posts (destination, created_at desc);
create index posts_likes_count_idx on public.posts (likes_count desc);
create index posts_comments_count_idx on public.posts (comments_count desc);
create index posts_tagged_user_ids_idx on public.posts using gin (tagged_user_ids);

-- 3) أصول الوسائط (سجل المعالجة — الروابط كلها R2 عامة كاملة) ===============
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  original_path text not null,
  storage_path text,
  processed_path text,
  video_url text,
  poster_url text,
  duration double precision,
  width integer,
  height integer,
  status text not null default 'uploading',
  processing_status text not null default 'uploading' check (processing_status in ('uploading', 'processing', 'ready', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);
create index media_assets_user_id_idx on public.media_assets (user_id);
create index posts_media_asset_id_idx on public.posts (media_asset_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.media_assets'::regclass and conname = 'media_assets_user_id_fkey'
  ) then
    alter table public.media_assets
      add constraint media_assets_user_id_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.posts'::regclass and conname = 'posts_media_asset_id_fkey'
  ) then
    alter table public.posts
      add constraint posts_media_asset_id_fkey
      foreign key (media_asset_id) references public.media_assets (id) on delete set null;
  end if;
end $$;

-- 4) التفاعلات ===============================================================
create table public.likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  parent_id uuid,
  content text not null,
  image_url text,
  created_at timestamptz not null default now(),
  constraint comments_content_or_image_check check (
    char_length(content) <= 2000
    and (char_length(btrim(content)) > 0 or nullif(btrim(image_url), '') is not null)
  )
);
alter table public.comments
  add constraint comments_parent_id_fkey
  foreign key (parent_id) references public.comments (id) on delete set null;
create index comments_post_created_at_idx on public.comments (post_id, created_at);
create index comments_parent_created_at_idx on public.comments (parent_id, created_at) where parent_id is not null;

-- يجب أن يتبع الردّ نفس المنشور
create function public.aani_validate_comment_parent()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null and not exists (
    select 1 from public.comments parent
    where parent.id = new.parent_id and parent.post_id = new.post_id
  ) then
    raise exception 'Reply must belong to the same post as its parent' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger aani_validate_comment_parent
  before insert or update of parent_id, post_id on public.comments
  for each row execute function public.aani_validate_comment_parent();

create table public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create table public.comment_dislikes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create function public.aani_clear_opposite_comment_reaction()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'comment_likes' then
    delete from public.comment_dislikes where comment_id = new.comment_id and user_id = new.user_id;
  else
    delete from public.comment_likes where comment_id = new.comment_id and user_id = new.user_id;
  end if;
  return new;
end $$;
create trigger aani_comment_likes_exclusive after insert on public.comment_likes
  for each row execute function public.aani_clear_opposite_comment_reaction();
create trigger aani_comment_dislikes_exclusive after insert on public.comment_dislikes
  for each row execute function public.aani_clear_opposite_comment_reaction();

create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_not_self_check check (follower_id <> following_id)
);
create index follows_following_idx on public.follows (following_id, follower_id);

create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_bookmarks_post_user_unique unique (post_id, user_id)
);
create index aani_bookmarks_user_idx on public.bookmarks (user_id);

create table public.reposts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_reposts_post_user_unique unique (post_id, user_id)
);
create index aani_reposts_user_idx on public.reposts (user_id);

create table public.post_shares (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index aani_post_shares_post_idx on public.post_shares (post_id);
create index aani_post_shares_user_idx on public.post_shares (user_id);

create table public.post_feedback (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  feedback text not null check (feedback in ('interested', 'not_interested')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aani_post_feedback_post_user_unique unique (post_id, user_id)
);
create index aani_post_feedback_user_idx on public.post_feedback (user_id, updated_at desc);
create index aani_post_feedback_post_idx on public.post_feedback (post_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reported_user_id uuid references public.profiles (id) on delete set null,
  reason text not null default 'محتوى غير مناسب',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
create unique index aani_reports_post_reporter_unique_idx on public.reports (post_id, reporter_id);
create index aani_reports_status_idx on public.reports (status, created_at desc);

-- 5) نظام الأصوات ============================================================
create table public.sounds (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_video_url text,
  creator_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index sounds_created_at_idx on public.sounds (created_at desc);

-- 6) الرسائل =================================================================
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  image_url text,
  reply_to_id uuid,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint messages_not_self_check check (sender_id <> recipient_id)
);
alter table public.messages
  add constraint messages_reply_to_id_fkey
  foreign key (reply_to_id) references public.messages (id) on delete set null;
create index messages_sender_created_at_idx on public.messages (sender_id, created_at);
create index messages_recipient_created_at_idx on public.messages (recipient_id, created_at);

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table public.message_conversation_settings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  other_user_id uuid not null references public.profiles (id) on delete cascade,
  is_muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
);

-- 7) الإشعارات ===============================================================
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  type text not null default 'system',
  content text,
  reference_id uuid,
  entity_id uuid,
  comment_id uuid,
  metadata jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index aani_notifications_user_idx on public.notifications (user_id, created_at desc);

-- 8) الستوريز ================================================================
create table public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  media_url text,
  media_type text not null default 'text' check (media_type in ('text', 'image', 'video')),
  caption text,
  is_close_friends boolean not null default false,
  audience text not null default 'all' check (audience in ('all', 'followers', 'close_friends')),
  sound_id uuid references public.sounds (id) on delete set null,
  sound_trim_start real,
  sound_trim_end real,
  duration_seconds integer not null default 5 check (duration_seconds between 1 and 60),
  timed_texts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index aani_stories_user_expiry_idx on public.stories (user_id, expires_at);

create table public.story_likes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_story_likes_story_user_unique unique (story_id, user_id)
);

create table public.story_views (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_story_views_story_viewer_unique unique (story_id, viewer_id)
);
create index aani_story_views_story_idx on public.story_views (story_id, created_at desc);

create table public.story_mentions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  mentioned_user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_story_mentions_story_user_unique unique (story_id, mentioned_user_id)
);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- 9) العدّادات (تُحفظ تلقائياً عبر triggers ليتطابق كل العملاء) ==============
create function public.aani_sync_post_counters()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare target_post uuid; delta integer;
begin
  if tg_op = 'INSERT' then target_post := new.post_id; delta := 1;
  elsif tg_op = 'DELETE' then target_post := old.post_id; delta := -1;
  else return null; end if;
  if target_post is null then return null; end if;
  if tg_table_name = 'likes' then
    update public.posts set likes_count = case when hide_likes then 0 else greatest(0, coalesce(likes_count, 0) + delta) end where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts set comments_count = case when hide_comments then 0 else greatest(0, coalesce(comments_count, 0) + delta) end where id = target_post;
  elsif tg_table_name = 'reposts' then
    update public.posts set reposts_count = greatest(0, coalesce(reposts_count, 0) + delta) where id = target_post;
  elsif tg_table_name = 'post_shares' then
    update public.posts set shares_count = greatest(0, coalesce(shares_count, 0) + delta) where id = target_post;
  end if;
  return null;
end $$;

create trigger aani_likes_counter after insert or delete on public.likes
  for each row execute function public.aani_sync_post_counters();
create trigger aani_comments_counter after insert or delete on public.comments
  for each row execute function public.aani_sync_post_counters();
create trigger aani_reposts_counter after insert or delete on public.reposts
  for each row execute function public.aani_sync_post_counters();
create trigger aani_post_shares_counter after insert or delete on public.post_shares
  for each row execute function public.aani_sync_post_counters();

create function public.aani_sync_post_privacy_counters()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.posts p set
    likes_count = case when new.hide_likes then 0 else greatest(0, coalesce((select count(*) from public.likes l where l.post_id = new.id), 0)) end,
    comments_count = case when new.hide_comments then 0 else greatest(0, coalesce((select count(*) from public.comments c where c.post_id = new.id), 0)) end
  where p.id = new.id;
  return new;
end $$;
create trigger aani_post_privacy_counter_sync after update of hide_likes, hide_comments on public.posts
  for each row execute function public.aani_sync_post_privacy_counters();

-- 10) RPC موحد للتفاعلات =====================================================
create function public.get_post_interactions(p_post_ids uuid[])
returns table (
  post_id uuid, likes_count bigint, comments_count bigint, reposts_count bigint, shares_count bigint,
  liked_by_me boolean, reposted_by_me boolean, saved_by_me boolean, feedback_by_me text, shared_by_me boolean,
  like_count integer, comment_count integer, repost_count integer, share_count integer,
  liked boolean, bookmarked boolean, reposted boolean, shared boolean
)
language sql stable security definer set search_path = public, pg_temp as $$
  with summaries as (
    select p.id as post_id,
      case when p.hide_likes and p.user_id is distinct from auth.uid() then 0::bigint else (select count(*) from public.likes l where l.post_id = p.id)::bigint end as likes_count,
      case when p.hide_comments and p.user_id is distinct from auth.uid() then 0::bigint else (select count(*) from public.comments c where c.post_id = p.id)::bigint end as comments_count,
      (select count(*) from public.reposts r where r.post_id = p.id)::bigint as reposts_count,
      (select count(*) from public.post_shares s where s.post_id = p.id)::bigint as shares_count,
      exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked_by_me,
      exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted_by_me,
      exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as saved_by_me,
      (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid() limit 1) as feedback_by_me,
      exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared_by_me
    from public.posts p where p.id = any(coalesce(p_post_ids, '{}'::uuid[]))
      and (p.user_id = auth.uid() or p.visibility <> 'private')
  )
  select s.post_id, s.likes_count, s.comments_count, s.reposts_count, s.shares_count,
    s.liked_by_me, s.reposted_by_me, s.saved_by_me, s.feedback_by_me, s.shared_by_me,
    s.likes_count::integer, s.comments_count::integer, s.reposts_count::integer, s.shares_count::integer,
    s.liked_by_me, s.saved_by_me, s.reposted_by_me, s.shared_by_me
  from summaries s;
$$;
grant execute on function public.get_post_interactions(uuid[]) to authenticated, anon;

create function public.aani_can_comment_on_post(p_post_id uuid, p_commenter_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.posts p
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
              select 1 from public.follows f
              where f.follower_id = p_commenter_id and f.following_id = p.user_id
            )
            when 'custom' then p.allowed_commenters @> array[p_commenter_id] and exists (
              select 1 from public.follows f1
              join public.follows f2
                on f2.follower_id = f1.following_id and f2.following_id = f1.follower_id
              where f1.follower_id = p.user_id and f1.following_id = p_commenter_id
            )
            else true
          end
        )
      )
  );
$$;
grant execute on function public.aani_can_comment_on_post(uuid, uuid) to authenticated;

create function public.aani_mark_messages_delivered(p_message_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  update public.messages as message
     set delivered_at = now()
   where message.id = any(coalesce(p_message_ids, array[]::uuid[]))
     and message.recipient_id = actor_id
     and message.delivered_at is null;
end $$;

create function public.aani_mark_conversation_read(p_sender_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_sender_id is null or p_sender_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;
  update public.messages as message
     set delivered_at = coalesce(message.delivered_at, now()),
         read_at = coalesce(message.read_at, now())
   where message.sender_id = p_sender_id
     and message.recipient_id = actor_id
     and message.read_at is null;
end $$;

grant execute on function public.aani_mark_messages_delivered(uuid[]) to authenticated;
grant execute on function public.aani_mark_conversation_read(uuid) to authenticated;

create function public.aani_cleanup_old_notifications()
returns bigint language plpgsql security definer set search_path = '' as $$
declare deleted_count bigint;
begin
  delete from public.notifications
  where user_id = (select auth.uid()) and created_at < now() - interval '7 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;
grant execute on function public.aani_cleanup_old_notifications() to authenticated;

-- 11) إنشاء ملف شخصي تلقائياً عند التسجيل ===================================
create function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  requested_username text;
  requested_full_name text;
  requested_gender text;
  requested_city text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-z0-9_.]', '', 'g'
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
  requested_gender := coalesce(new.raw_user_meta_data ->> 'gender', 'male');
  if requested_gender not in ('male', 'female') then requested_gender := 'male'; end if;
  requested_city := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')), '');

  insert into public.profiles (id, username, full_name, gender, city, location)
  values (new.id, left(requested_username, 32), left(requested_full_name, 120), requested_gender, requested_city, requested_city)
  on conflict (id) do update set
    gender = excluded.gender,
    city = coalesce(excluded.city, public.profiles.city),
    location = coalesce(excluded.location, public.profiles.location);
  return new;
end $$;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

-- 12) تفعيل RLS على كل الجداول ==============================================
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.media_assets enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_dislikes enable row level security;
alter table public.follows enable row level security;
alter table public.bookmarks enable row level security;
alter table public.reposts enable row level security;
alter table public.post_shares enable row level security;
alter table public.post_feedback enable row level security;
alter table public.reports enable row level security;
alter table public.sounds enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_conversation_settings enable row level security;
alter table public.notifications enable row level security;
alter table public.stories enable row level security;
alter table public.story_likes enable row level security;
alter table public.story_views enable row level security;
alter table public.story_mentions enable row level security;
alter table public.user_blocks enable row level security;

-- profiles -------------------------------------------------------------------
create policy "Signed-in users can read profiles"
  on public.profiles for select to authenticated using (true);
create policy "Users can create their own profile"
  on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- posts ----------------------------------------------------------------------
create policy "Signed-in users can read posts"
  on public.posts for select to authenticated
  using (user_id = (select auth.uid()) or visibility = 'public');
create policy "Users can create their own posts"
  on public.posts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users can update their own posts"
  on public.posts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users can delete their own posts"
  on public.posts for delete to authenticated using (user_id = (select auth.uid()));

-- media_assets ---------------------------------------------------------------
create policy "Users read own media assets"
  on public.media_assets for select to authenticated
  using (user_id = (select auth.uid()) or video_url is not null);
create policy "Users create own media assets"
  on public.media_assets for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users update own media assets"
  on public.media_assets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete own media assets"
  on public.media_assets for delete to authenticated using (user_id = (select auth.uid()));

-- likes ---------------------------------------------------------------------
create policy "Signed-in users can read likes"
  on public.likes for select to authenticated using (true);
create policy "Users can like posts as themselves"
  on public.likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users can remove their own likes"
  on public.likes for delete to authenticated using (user_id = (select auth.uid()));

-- comments -------------------------------------------------------------------
create policy "Signed-in users can read comments"
  on public.comments for select to authenticated using (true);
create policy "Users can create comments as themselves"
  on public.comments for insert to authenticated
  with check (user_id = (select auth.uid()) and public.aani_can_comment_on_post(post_id, (select auth.uid())));
create policy "Users can update their own comments"
  on public.comments for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users can delete their own comments"
  on public.comments for delete to authenticated using (user_id = (select auth.uid()));

-- comment_likes / comment_dislikes ------------------------------------------
create policy "Signed-in users can read comment likes"
  on public.comment_likes for select to authenticated using (true);
create policy "Users can like comments as themselves"
  on public.comment_likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users can remove their own comment likes"
  on public.comment_likes for delete to authenticated using (user_id = (select auth.uid()));
create policy "Signed-in users can read comment dislikes"
  on public.comment_dislikes for select to authenticated using (true);
create policy "Users can dislike comments as themselves"
  on public.comment_dislikes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users can remove their own comment dislikes"
  on public.comment_dislikes for delete to authenticated using (user_id = (select auth.uid()));

-- follows --------------------------------------------------------------------
create policy "Signed-in users can read follows"
  on public.follows for select to authenticated using (true);
create policy "Users can follow as themselves"
  on public.follows for insert to authenticated
  with check (follower_id = (select auth.uid()) and follower_id <> following_id);
create policy "Users can unfollow as themselves"
  on public.follows for delete to authenticated using (follower_id = (select auth.uid()));

-- bookmarks / reposts / post_shares / post_feedback / reports ---------------
create policy "aani_bookmarks_select_own" on public.bookmarks
  for select to authenticated using (user_id = (select auth.uid()));
create policy "aani_bookmarks_insert_own" on public.bookmarks
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "aani_bookmarks_delete_own" on public.bookmarks
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "aani_reposts_select_own" on public.reposts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "aani_reposts_insert_own" on public.reposts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "aani_reposts_delete_own" on public.reposts
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "aani_post_shares_select_own" on public.post_shares
  for select to authenticated using (user_id = (select auth.uid()));
create policy "aani_post_shares_insert_own" on public.post_shares
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "aani_post_shares_delete_own" on public.post_shares
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "Users manage their own post feedback"
  on public.post_feedback for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "aani_reports_select_own" on public.reports
  for select to authenticated using (auth.uid() = reporter_id);
create policy "aani_reports_insert_own" on public.reports
  for insert to authenticated with check (auth.uid() = reporter_id);
create policy "aani_reports_delete_own" on public.reports
  for delete to authenticated using (auth.uid() = reporter_id);

-- sounds ---------------------------------------------------------------------
create policy "Signed-in users can read sounds"
  on public.sounds for select to authenticated using (true);
create policy "Users create their own sounds"
  on public.sounds for insert to authenticated with check (creator_id = (select auth.uid()));

-- messages -------------------------------------------------------------------
create policy "Users can read their own messages"
  on public.messages for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy "Users can send messages as themselves"
  on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and sender_id <> recipient_id);
create policy "Users can update their own messages"
  on public.messages for update to authenticated
  using (sender_id = (select auth.uid())) with check (sender_id = (select auth.uid()));
create policy "Users can delete their own messages"
  on public.messages for delete to authenticated using (sender_id = (select auth.uid()));

create policy "Users read visible message reactions"
  on public.message_reactions for select to authenticated using (true);
create policy "Users react as themselves"
  on public.message_reactions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove own reactions"
  on public.message_reactions for delete to authenticated using (user_id = (select auth.uid()));

create policy "Users read own conversation settings"
  on public.message_conversation_settings for select to authenticated
  using (user_id = (select auth.uid()) or other_user_id = (select auth.uid()));
create policy "Users manage own conversation settings"
  on public.message_conversation_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- notifications --------------------------------------------------------------
create policy "Users read own notifications"
  on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "Users update own notifications"
  on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete own notifications"
  on public.notifications for delete to authenticated using (user_id = (select auth.uid()));

-- stories --------------------------------------------------------------------
create policy "Signed-in users can read active stories"
  on public.stories for select to authenticated
  using (
    user_id = (select auth.uid())
    or (expires_at > now() and not is_close_friends)
  );
create policy "Users create their own stories"
  on public.stories for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users update their own stories"
  on public.stories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete their own stories"
  on public.stories for delete to authenticated using (user_id = (select auth.uid()));

create policy "Signed-in users read story likes"
  on public.story_likes for select to authenticated using (true);
create policy "Users like stories as themselves"
  on public.story_likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove own story likes"
  on public.story_likes for delete to authenticated using (user_id = (select auth.uid()));

create policy "Story viewers read views"
  on public.story_views for select to authenticated
  using (viewer_id = (select auth.uid()));
create policy "Users record own views"
  on public.story_views for insert to authenticated with check (viewer_id = (select auth.uid()));

create policy "Users read own mentions"
  on public.story_mentions for select to authenticated using (mentioned_user_id = (select auth.uid()));

create policy "Users manage own blocks"
  on public.user_blocks for all to authenticated
  using (blocker_id = (select auth.uid())) with check (blocker_id = (select auth.uid()));

-- 13) صلاحيات الجداول (GRANT) — تحل مسبقاً أي خطأ 42501/permission =========
revoke select on table public.profiles from public, anon, authenticated;
grant select (
  id, username, full_name, avatar_url, cover_url, cover_position_x, cover_position_y,
  location, city, job, birth_date, show_city, show_job, show_birth_date, website,
  bio, display_name, notification_settings, appearance_preference, language_preference,
  hd_uploads, data_saver, font_preference, gender, is_private, is_deactivated,
  is_nearby_visible, created_at, updated_at
) on table public.profiles to authenticated;
grant insert, update on public.profiles to authenticated;

grant select, insert, update, delete on public.posts to authenticated;
grant select, insert, update, delete on public.media_assets to authenticated;
grant select, insert, delete on public.likes to authenticated;
grant select, insert, update, delete on public.comments to authenticated;
grant select, insert, delete on public.comment_likes to authenticated;
grant select, insert, delete on public.comment_dislikes to authenticated;
grant select, insert, delete on public.follows to authenticated;
grant select, insert, delete on public.bookmarks to authenticated;
grant select, insert, delete on public.reposts to authenticated;
grant select, insert, delete on public.post_shares to authenticated;
grant select, insert, update, delete on public.post_feedback to authenticated;
grant select, insert, delete on public.reports to authenticated;
grant select, insert on public.sounds to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, delete on public.message_reactions to authenticated;
grant select, insert, update, delete on public.message_conversation_settings to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.stories to authenticated;
grant select, insert, delete on public.story_likes to authenticated;
grant select, insert on public.story_views to authenticated;
grant select on public.story_mentions to authenticated;
grant select, insert, delete on public.user_blocks to authenticated;

-- 14) Realtime (الرسائل والتفاعلات المباشرة) ================================
alter table public.messages replica identity full;
alter table public.posts replica identity full;
alter table public.likes replica identity full;
alter table public.comments replica identity full;
alter table public.reposts replica identity full;
alter table public.bookmarks replica identity full;
alter table public.post_shares replica identity full;

do $$
declare target text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target in array array['messages', 'posts', 'likes', 'comments', 'reposts', 'bookmarks', 'post_shares']
    loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', target);
      exception
        when duplicate_object then null;
        when undefined_object then null;
      end;
    end loop;
  end if;
end $$;

-- ============================================================================
-- ملاحظات نهائية:
-- 1. لا يوجد أي قسم storage.buckets هنا عن قصد: التخزين انتقل إلى Cloudflare R2،
--    وكل روابط الوسائط تُخزَّن كعناوين R2 عامة كاملة في media_url/video_url.
-- 2. قيم أعمدة posts تطابق تماماً ما يطلبه usePosts.ts و ProfileReelsPlayer.tsx،
--    فلن يعيد PostgREST أي خطأ 42703 (عمود ناقص) أو PGRST204.
-- 3. التحقق بعد التشغيل:
--      select table_name, column_name from information_schema.columns
--      where table_schema = 'public' order by table_name;
-- ============================================================================
