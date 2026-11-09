begin;

-- A previous broad table grant can expose the private allowed_commenters column.
-- Restore the intended column allowlist and include the profile ordering field.
revoke select on table public.posts from public, anon, authenticated;
grant select (
  id,
  user_id,
  content,
  post_metadata,
  media_url,
  media_urls,
  type,
  destination,
  visibility,
  display_order,
  created_at,
  likes_count,
  comments_count,
  reposts_count,
  shares_count,
  comments_disabled,
  audio_url,
  audio_title,
  hide_likes,
  hide_comments,
  comment_privacy
) on table public.posts to authenticated;
grant select on table public.posts to service_role;

notify pgrst, 'reload schema';

commit;
