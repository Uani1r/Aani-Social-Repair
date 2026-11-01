-- تنظيف سياسات إدخال القصص القديمة والإبقاء على سياسة permissive واحدة.
-- آمن للتشغيل عدة مرات، ويجب تشغيله بعد ترحيل خصوصية القصص.
begin;

grant usage on schema public to authenticated;
grant select, insert, delete on public.stories to authenticated;

-- فحص وجود الأصل خارج حدود RLS مع قفله حتى يكتمل الإدخال.
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

-- ينشئ القصص بوقت قاعدة البيانات، ويحوّل المرجع المحذوف إلى قصة أصلية.
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
grant execute on function public.aani_can_reshare_story(uuid, uuid, text, text) to authenticated;

-- إزالة السياسات القديمة المكررة والسياسة التقييدية؛ سيبقى إدخال القصص تحت سياسة واحدة.
drop policy if exists "Users can create their own stories" on public.stories;
drop policy if exists "Users can insert stories" on public.stories;
drop policy if exists "Users insert own stories" on public.stories;
drop policy if exists aani_stories_insert_guard on public.stories;
drop policy if exists aani_stories_insert_own on public.stories;

create policy aani_stories_insert_own on public.stories
  as permissive
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

commit;
