-- إصلاح نشر القصص عند بقاء مرجع إعادة مشاركة محذوف، وتسامح محدود مع فرق الساعة.
begin;

-- فحص وجود القصة الأصلية خارج حدود RLS مع قفلها حتى يكتمل الإدخال.
create or replace function public.aani_story_exists(p_story_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_story_id is null then
    return false;
  end if;

  perform 1
  from public.stories as story
  where story.id = p_story_id
  for key share;

  return found;
end;
$$;

revoke all on function public.aani_story_exists(uuid) from public;
grant execute on function public.aani_story_exists(uuid) to authenticated;

-- إنشاء القصة بساعة قاعدة البيانات، وإزالة مرجع إعادة المشاركة إذا حُذف أصله.
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
  normalized_original_story_id uuid := p_original_story_id;
  normalized_share_type text := coalesce(p_share_type, 'original');
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

  if normalized_original_story_id is not null
     and not public.aani_story_exists(normalized_original_story_id) then
    normalized_original_story_id := null;
    normalized_share_type := 'original';
  elsif normalized_original_story_id is null then
    normalized_share_type := 'original';
  elsif normalized_share_type <> 'reshare' then
    raise exception 'A story with an original reference must be a reshare' using errcode = '22023';
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
    normalized_original_story_id,
    normalized_share_type,
    now(),
    now() + pg_catalog.make_interval(secs => coalesce(p_expiry_seconds, 86400)::double precision)
  )
  returning id into created_story_id;

  return created_story_id;
end;
$$;

revoke all on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) from public;
grant execute on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) to authenticated;

-- تبقى القصة ذات التوقيت المستقبلي ضمن مهلة السماح قابلة للعرض أيضاً.
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
        or story.created_at > now() + interval '5 minutes'
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

-- مهلة خمس دقائق للمستقبل لمعالجة فرق الساعة، مع إبقاء حد عمر القصة 24 ساعة.
drop policy if exists aani_stories_insert_own on public.stories;
create policy aani_stories_insert_own on public.stories
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and created_at >= now() - interval '24 hours'
    and created_at <= now() + interval '5 minutes'
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
    and created_at <= now() + interval '5 minutes'
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

commit;
