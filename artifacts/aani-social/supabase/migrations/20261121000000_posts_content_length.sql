-- Align existing databases with the current 2000-character post limit.
-- NOT VALID keeps legacy rows intact while enforcing the rule on new writes.
begin;

alter table public.posts drop constraint if exists posts_content_check;
alter table public.posts drop constraint if exists posts_content_length_check;
alter table public.posts
  add constraint posts_content_length_check
  check (
    char_length(content) <= 2000
    and (char_length(btrim(content)) > 0 or media_url is not null)
  ) not valid;

notify pgrst, 'reload schema';

commit;
