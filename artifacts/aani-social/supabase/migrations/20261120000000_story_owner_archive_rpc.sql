begin;

-- Expose expired stories only to their authenticated owner without widening
-- the normal stories table policies used by other clients.
create or replace function public.aani_get_my_story_archive(
  p_limit integer default 100,
  p_offset integer default 0
)
returns setof public.stories
language sql
stable
security definer
set search_path = ''
as $$
  select story.*
  from public.stories as story
  where (select auth.uid()) is not null
    and story.user_id = (select auth.uid())
    and story.expires_at <= pg_catalog.now()
  order by story.created_at desc, story.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

alter function public.aani_get_my_story_archive(integer, integer) owner to postgres;
revoke all on function public.aani_get_my_story_archive(integer, integer) from public;
grant execute on function public.aani_get_my_story_archive(integer, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
