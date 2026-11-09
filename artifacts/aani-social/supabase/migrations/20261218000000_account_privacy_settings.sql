-- Allow users to remove only their own block relationships from account settings.
begin;

create or replace function public.aani_unblock_user(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to unblock' using errcode = '22023';
  end if;

  delete from public.user_blocks
  where blocker_id = actor_id and blocked_user_id = p_blocked_user_id;
end;
$$;
revoke all on function public.aani_unblock_user(uuid) from public, anon;
grant execute on function public.aani_unblock_user(uuid) to authenticated;

commit;
