-- Restore owner-only post publishing when the posts INSERT policy or
-- authenticated column privileges are missing. Reels remain in public.posts.
begin;

do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts must exist before applying the post publishing permissions repair';
  end if;
end;
$$;

-- Keep row-level security enabled and restrict writes to the signed-in owner.
alter table public.posts enable row level security;

drop policy if exists "Users can create their own posts" on public.posts;
create policy "Users can create their own posts"
  on public.posts for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update their own posts" on public.posts;
create policy "Users can update their own posts"
  on public.posts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Upserts need INSERT privileges and UPDATE privileges for the conflict path.
-- Grant only app-facing post/media columns; private moderation/privacy columns
-- such as allowed_commenters stay inaccessible through these grants.
grant select (
  id, user_id, content, post_metadata, media_url, media_urls, media_asset_id,
  type, destination, created_at, tagged_user_ids, sound_id, audio_url, audio_title,
  trim_start, trim_end, sound_trim_start, sound_trim_end
) on table public.posts to authenticated;

grant insert (
  id, user_id, content, post_metadata, media_url, media_urls, media_asset_id,
  type, destination, created_at, tagged_user_ids, sound_id, audio_url, audio_title,
  trim_start, trim_end, sound_trim_start, sound_trim_end
) on table public.posts to authenticated;

grant update (
  id, user_id, content, post_metadata, media_url, media_urls, media_asset_id,
  type, destination, created_at, tagged_user_ids, sound_id, audio_url, audio_title,
  trim_start, trim_end, sound_trim_start, sound_trim_end
) on table public.posts to authenticated;

notify pgrst, 'reload schema';
commit;
