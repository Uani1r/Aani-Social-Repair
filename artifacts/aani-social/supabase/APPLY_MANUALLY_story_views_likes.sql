begin;

-- =====================================================================
-- 1) جداول الحظر والأصدقاء المقربين — تُنشأ تلقائياً إن غابت
-- =====================================================================

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint aani_user_blocks_not_self check (blocker_id <> blocked_id)
);

create table if not exists public.close_friends (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint aani_close_friends_not_self check (user_id <> friend_id)
);

-- =====================================================================
-- 2) دالة الحظر — تستخدم blocked_id
-- =====================================================================

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
      where (blocked.blocker_id = p_user_a and blocked.blocked_id = p_user_b)
         or (blocked.blocker_id = p_user_b and blocked.blocked_id = p_user_a)
    ),
    false
  );
$$;
revoke all on function public.aani_is_user_blocked(uuid, uuid) from public;
grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated;

-- =====================================================================
-- 3) دالة رؤية القصة
-- =====================================================================

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
      original.share_type,
      child.share_type = 'reshare'
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
              where (blocked.blocker_id = story.user_id and blocked.blocked_id = p_viewer_id)
                 or (blocked.blocker_id = p_viewer_id and blocked.blocked_id = story.user_id)
            )
            or (owner.is_private and not exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = story.user_id
            ))
            or (
              story.is_close_friends
              and not exists (
                select 1
                from public.close_friends as listed
                where listed.user_id = story.user_id
                  and listed.friend_id = p_viewer_id
              )
            )
          )
        )
    );
$$;
revoke all on function public.aani_can_view_story(uuid, uuid) from public;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;

-- =====================================================================
-- 4) عمود viewed_at المولَّد + فهرس التفرد + منظر القراءة
-- =====================================================================

alter table public.story_views
  add column if not exists viewed_at timestamptz
  generated always as (created_at) stored;

delete from public.story_views a
using public.story_views b
where a.ctid < b.ctid
  and a.story_id = b.story_id
  and a.viewer_id = b.viewer_id;

create unique index if not exists aani_story_views_story_viewer_uidx
  on public.story_views (story_id, viewer_id);

create index if not exists aani_story_views_story_viewed_idx
  on public.story_views (story_id, created_at desc);

create or replace view public.story_viewer_entries as
  select
    v.id,
    v.story_id,
    v.viewer_id as user_id,
    v.created_at as viewed_at,
    v.viewer_id
  from public.story_views as v;

-- =====================================================================
-- 5) صلاحيات و RLS على story_views و story_likes
-- =====================================================================

grant select on public.story_viewer_entries to authenticated;
grant select, insert on public.story_views to authenticated;
grant select, insert, delete on public.story_likes to authenticated;

alter table public.story_views enable row level security;
alter table public.story_likes enable row level security;

drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
    )
  );

drop policy if exists aani_story_views_owner_guard on public.story_views;
create policy aani_story_views_owner_guard on public.story_views
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
    )
  );

drop policy if exists aani_story_views_insert_viewer on public.story_views;
create policy aani_story_views_insert_viewer on public.story_views
  for insert to authenticated with check (
    viewer_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

drop policy if exists aani_story_views_insert_guard on public.story_views;
create policy aani_story_views_insert_guard on public.story_views
  as restrictive for insert to authenticated with check (
    viewer_id = (select auth.uid())
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
    )
  );

drop policy if exists aani_story_likes_insert_own on public.story_likes;
create policy aani_story_likes_insert_own on public.story_likes
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

drop policy if exists aani_story_likes_delete_own on public.story_likes;
create policy aani_story_likes_delete_own on public.story_likes
  for delete to authenticated using (user_id = (select auth.uid()));

-- =====================================================================
-- 6) دالة تسجيل المشاهدة (idempotent)
-- =====================================================================

create or replace function public.aani_record_story_view(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.stories as story
    where story.id = p_story_id
      and story.user_id <> viewer_id
      and public.aani_can_view_story(story.id, viewer_id)
  ) then
    raise exception 'Story is not available to this viewer' using errcode = '42501';
  end if;

  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, viewer_id)
  on conflict (story_id, viewer_id) do nothing;
end;
$$;
revoke all on function public.aani_record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid) to authenticated;

-- =====================================================================
-- 7) Realtime على الجدولين
-- =====================================================================

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
end $$;

-- =====================================================================
-- 8) تحديث كاش PostgREST
-- =====================================================================

notify pgrst, 'reload schema';

commit;
