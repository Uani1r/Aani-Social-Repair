-- Text-only stories do not have an associated media URL.
begin;

alter table public.stories
  alter column media_url drop not null;

notify pgrst, 'reload schema';

commit;
