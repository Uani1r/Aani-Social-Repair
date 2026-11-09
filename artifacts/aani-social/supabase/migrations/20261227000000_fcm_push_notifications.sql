begin;

alter table public.profiles
  add column if not exists fcm_token text;

-- Keep device destinations private while preserving the profile fields the app reads.
revoke select on table public.profiles from public, anon, authenticated;
grant select (
  id, username, full_name, avatar_url, cover_url, cover_position_x, cover_position_y,
  location, city, job, birth_date, show_city, show_job, show_birth_date, website,
  bio, display_name, notification_settings, appearance_preference, language_preference,
  hd_uploads, data_saver, font_preference, is_private, is_deactivated, created_at, updated_at
) on table public.profiles to authenticated;

grant update (fcm_token) on table public.profiles to authenticated;

notify pgrst, 'reload schema';

commit;
