begin;

alter table public.profile_highlight_collections
  add column if not exists cover_url text;

create or replace function public.aani_update_profile_highlight_collection(
  p_collection_id uuid,
  p_title text,
  p_cover_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if nullif(btrim(p_title), '') is null then
    raise exception using errcode = '22023', message = 'A collection title is required';
  end if;

  update public.profile_highlight_collections
  set title = btrim(p_title),
      cover_url = nullif(btrim(p_cover_url), '')
  where id = p_collection_id
    and user_id = v_user_id;

  if not found then
    raise exception using errcode = '42501', message = 'Collection is not owned by the current user';
  end if;

  return true;
end;
$$;

create or replace function public.aani_delete_profile_highlight_collection(
  p_collection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  delete from public.profile_highlight_collections
  where id = p_collection_id
    and user_id = v_user_id;

  if not found then
    raise exception using errcode = '42501', message = 'Collection is not owned by the current user';
  end if;

  return true;
end;
$$;

alter function public.aani_update_profile_highlight_collection(uuid, text, text) owner to postgres;
alter function public.aani_delete_profile_highlight_collection(uuid) owner to postgres;
revoke all on function public.aani_update_profile_highlight_collection(uuid, text, text) from public, anon;
revoke all on function public.aani_delete_profile_highlight_collection(uuid) from public, anon;
grant execute on function public.aani_update_profile_highlight_collection(uuid, text, text) to authenticated;
grant execute on function public.aani_delete_profile_highlight_collection(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
