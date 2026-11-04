-- The destination column was added after posts received column-level SELECT grants.
-- Grant only this field so the private allowed_commenters column stays protected.
begin;

grant select (destination) on table public.posts to authenticated;

commit;
