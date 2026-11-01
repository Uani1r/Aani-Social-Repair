-- خصوصية الحسابات، الأصدقاء المقربون، طلبات المتابعة، وسياسات القصص وإعادة المشاركة.
begin;

alter table public.profiles
  add column if not exists is_private boolean not null default false;

update public.profiles
set is_private = false
where is_private is null;

alter table public.profiles
  alter column is_private set default false,
  alter column is_private set not null;

alter table public.messages
  add column if not exists story_id uuid references public.stories(id) on delete set null;

create index if not exists aani_messages_story_idx
  on public.messages (story_id);

alter table public.stories
  add column if not exists original_story_id uuid references public.stories(id) on delete set null,
  add column if not exists share_type text not null default 'original',
  add column if not exists filter_key text;

alter table public.stories drop constraint if exists aani_story_duration_seconds_check;
alter table public.stories drop constraint if exists stories_duration_seconds_check;
alter table public.stories
  add constraint aani_story_duration_seconds_check
  check (duration_seconds between 1 and 120);

create index if not exists aani_stories_user_created_at_idx
  on public.stories (user_id, created_at desc);

create index if not exists aani_stories_expires_at_idx
  on public.stories (expires_at);

create table if not exists public.close_friends (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint aani_close_friends_not_self check (user_id <> friend_id)
);

create index if not exists aani_close_friends_friend_idx
  on public.close_friends (friend_id, user_id);

create table if not exists public.follow_requests (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (requester_id, recipient_id),
  constraint aani_follow_requests_not_self check (requester_id <> recipient_id)
);

create index if not exists aani_follow_requests_recipient_created_idx
  on public.follow_requests (recipient_id, created_at desc);

create or replace function public.aani_is_mutual_follow(p_user_id uuid, p_friend_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.follows as outgoing
    join public.follows as incoming
      on incoming.follower_id = outgoing.following_id
     and incoming.following_id = outgoing.follower_id
    where outgoing.follower_id = p_user_id
      and outgoing.following_id = p_friend_id
  );
$$;

revoke all on function public.aani_is_mutual_follow(uuid, uuid) from public;
grant execute on function public.aani_is_mutual_follow(uuid, uuid) to authenticated;

-- يتحقق من صلاحية قراءة القصة وكل أصل مرتبط بها (بما في ذلك إعادة المشاركة المتسلسلة).
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
    exists (select 1 from story_chain where id = p_story_id)
    and not exists (
      select 1
      from story_chain as story
      join public.profiles as owner on owner.id = story.user_id
      where story.created_at < now() - interval '24 hours'
        or story.created_at > now()
        or story.expires_at <= now()
        or story.expires_at > story.created_at + interval '24 hours'
        or not story.parent_link_valid
        or (
          story.user_id <> p_viewer_id
          and (
            (owner.is_private and not exists (
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

create or replace function public.aani_can_reshare_story(
  p_story_id uuid,
  p_viewer_id uuid,
  p_media_url text,
  p_media_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.stories as original
    where original.id = p_story_id
      and original.user_id <> p_viewer_id
      and original.media_url is not null
      and original.media_url = p_media_url
      and original.media_type = p_media_type
      and public.aani_can_view_story(original.id, p_viewer_id)
  );
$$;

revoke all on function public.aani_can_reshare_story(uuid, uuid, text, text) from public;
grant execute on function public.aani_can_reshare_story(uuid, uuid, text, text) to authenticated;

alter table public.close_friends enable row level security;
alter table public.follow_requests enable row level security;
grant select, insert, delete on public.close_friends to authenticated;
grant select, insert, delete on public.follow_requests to authenticated;

drop policy if exists aani_close_friends_select_own on public.close_friends;
create policy aani_close_friends_select_own on public.close_friends
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists aani_close_friends_insert_mutual on public.close_friends;
create policy aani_close_friends_insert_mutual on public.close_friends
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and friend_id <> (select auth.uid())
    and public.aani_is_mutual_follow(user_id, friend_id)
  );

drop policy if exists aani_close_friends_delete_own on public.close_friends;
create policy aani_close_friends_delete_own on public.close_friends
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists aani_follow_requests_select_participant on public.follow_requests;
create policy aani_follow_requests_select_participant on public.follow_requests
  for select to authenticated
  using (
    requester_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );

drop policy if exists aani_follow_requests_insert_private on public.follow_requests;
create policy aani_follow_requests_insert_private on public.follow_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and requester_id <> recipient_id
    and exists (
      select 1 from public.profiles as recipient
      where recipient.id = recipient_id and recipient.is_private
    )
    and not exists (
      select 1 from public.follows as accepted
      where accepted.follower_id = requester_id
        and accepted.following_id = recipient_id
    )
  );

drop policy if exists aani_follow_requests_delete_participant on public.follow_requests;
create policy aani_follow_requests_delete_participant on public.follow_requests
  for delete to authenticated
  using (
    requester_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );

-- الحسابات العامة تحتفظ بالمتابعة المباشرة؛ متابعة الحساب الخاص تتطلب طلباً وموافقة مالكه.
drop policy if exists "Users can follow as themselves" on public.follows;
create policy "Users can follow as themselves"
  on public.follows for insert to authenticated
  with check (
    follower_id <> following_id
    and (
      (
        follower_id = (select auth.uid())
        and (
          exists (
            select 1 from public.profiles as target
            where target.id = following_id and not target.is_private
          )
          or exists (
            select 1 from public.follow_requests as request
            where request.requester_id = follower_id
              and request.recipient_id = following_id
          )
        )
      )
      or (
        following_id = (select auth.uid())
        and exists (
          select 1 from public.follow_requests as request
          where request.requester_id = follower_id
            and request.recipient_id = following_id
        )
      )
    )
  );

drop policy if exists aani_follows_private_guard on public.follows;
create policy aani_follows_private_guard on public.follows
  as restrictive for insert to authenticated
  with check (
    follower_id <> following_id
    and (
      (
        follower_id = (select auth.uid())
        and (
          exists (
            select 1 from public.profiles as target
            where target.id = following_id and not target.is_private
          )
          or exists (
            select 1 from public.follow_requests as request
            where request.requester_id = follower_id
              and request.recipient_id = following_id
          )
        )
      )
      or (
        following_id = (select auth.uid())
        and exists (
          select 1 from public.follow_requests as request
          where request.requester_id = follower_id
            and request.recipient_id = following_id
        )
      )
    )
  );

-- تُسمح القصص العامة على الملفات الشخصية؛ ويظل استعلام شريط الصفحة الرئيسية محصوراً بالمتابَعين.
drop policy if exists aani_stories_select_visible on public.stories;
create policy aani_stories_select_visible on public.stories
  for select to authenticated
  using (public.aani_can_view_story(id, (select auth.uid())));

drop policy if exists aani_stories_followers_guard on public.stories;
create policy aani_stories_followers_guard on public.stories
  as restrictive for select to authenticated
  using (public.aani_can_view_story(id, (select auth.uid())));

-- كل قصة جديدة لها صلاحية لا تتجاوز 24 ساعة؛ وإعادة المشاركة تحتفظ بمرجع الأصل.
drop policy if exists aani_stories_insert_own on public.stories;
create policy aani_stories_insert_own on public.stories
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and created_at >= now() - interval '24 hours'
    and created_at <= now()
    and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and (
      (original_story_id is null and share_type = 'original')
      or (
        original_story_id is not null
        and share_type = 'reshare'
        and public.aani_can_reshare_story(
          original_story_id,
          (select auth.uid()),
          media_url,
          media_type
        )
      )
    )
  );

drop policy if exists aani_stories_insert_guard on public.stories;
create policy aani_stories_insert_guard on public.stories
  as restrictive for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and created_at >= now() - interval '24 hours'
    and created_at <= now()
    and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and (
      (original_story_id is null and share_type = 'original')
      or (
        original_story_id is not null
        and share_type = 'reshare'
        and public.aani_can_reshare_story(
          original_story_id,
          (select auth.uid()),
          media_url,
          media_type
        )
      )
    )
  );

-- إنشاء القصة بوقت قاعدة البيانات لتفادي رفض RLS بسبب اختلاف ساعة الجهاز.
create or replace function public.aani_create_story(
  p_media_url text,
  p_media_type text,
  p_caption text,
  p_is_close_friends boolean,
  p_duration_seconds integer,
  p_timed_texts jsonb,
  p_filter_key text,
  p_original_story_id uuid,
  p_share_type text,
  p_expiry_seconds integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_story_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_media_type is null or p_media_type not in ('text', 'photo', 'video') then
    raise exception 'Invalid story media type' using errcode = '22023';
  end if;

  if p_expiry_seconds is not null and (p_expiry_seconds < 5 or p_expiry_seconds > 3600) then
    raise exception 'Story expiry must be between 5 seconds and 60 minutes' using errcode = '22023';
  end if;

  insert into public.stories (
    user_id,
    media_url,
    media_type,
    caption,
    is_close_friends,
    duration_seconds,
    timed_texts,
    filter_key,
    original_story_id,
    share_type,
    created_at,
    expires_at
  ) values (
    auth.uid(),
    p_media_url,
    p_media_type,
    p_caption,
    coalesce(p_is_close_friends, false),
    least(120, greatest(1, coalesce(p_duration_seconds, 30))),
    coalesce(p_timed_texts, '[]'::jsonb),
    p_filter_key,
    p_original_story_id,
    coalesce(p_share_type, 'original'),
    now(),
    now() + pg_catalog.make_interval(secs => coalesce(p_expiry_seconds, 86400)::double precision)
  )
  returning id into created_story_id;

  return created_story_id;
end;
$$;

revoke all on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) from public;
grant execute on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) to authenticated;

commit;
