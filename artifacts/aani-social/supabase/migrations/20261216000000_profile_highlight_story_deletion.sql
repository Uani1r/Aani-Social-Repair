begin;

create or replace function public.aani_delete_profile_highlight(
  p_highlight_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_collection_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select highlight.collection_id
    into v_collection_id
  from public.profile_highlights as highlight
  join public.profile_highlight_collections as collection
    on collection.id = highlight.collection_id
  where highlight.id = p_highlight_id
    and highlight.user_id = v_user_id
    and collection.user_id = v_user_id
  for update of collection;

  if not found then
    raise exception using errcode = '42501', message = 'Highlight is not owned by the current user';
  end if;

  delete from public.profile_highlights
  where id = p_highlight_id
    and collection_id = v_collection_id;

  if not exists (
    select 1
    from public.profile_highlights as highlight
    where highlight.collection_id = v_collection_id
  ) then
    delete from public.profile_highlight_collections
    where id = v_collection_id
      and user_id = v_user_id;
    return true;
  end if;

  return false;
end;
$$;

alter function public.aani_delete_profile_highlight(uuid) owner to postgres;
revoke all on function public.aani_delete_profile_highlight(uuid) from public, anon;
grant execute on function public.aani_delete_profile_highlight(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
