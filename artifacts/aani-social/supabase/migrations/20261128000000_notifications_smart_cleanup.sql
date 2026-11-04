-- Clean up only the authenticated user's notifications older than seven days.
create or replace function public.aani_cleanup_old_notifications()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    return 0;
  end if;

  delete from public.notifications
  where user_id = current_user_id
    and created_at < now() - interval '7 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.aani_cleanup_old_notifications() from public, anon;
grant execute on function public.aani_cleanup_old_notifications() to authenticated;
