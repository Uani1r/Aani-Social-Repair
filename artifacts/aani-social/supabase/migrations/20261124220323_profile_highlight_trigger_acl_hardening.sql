begin;
revoke all on function public.aani_assign_profile_highlight_collection_display_order()
  from public, anon, authenticated;
grant execute on function public.aani_assign_profile_highlight_collection_display_order()
  to service_role;
do $$
declare
  v_public_execute boolean;
begin
  select exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
    where p.oid = 'public.aani_assign_profile_highlight_collection_display_order()'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) into v_public_execute;
  if coalesce(v_public_execute, false)
     or has_function_privilege('anon', 'public.aani_assign_profile_highlight_collection_display_order()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.aani_assign_profile_highlight_collection_display_order()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.aani_assign_profile_highlight_collection_display_order()', 'EXECUTE') then
    raise exception 'Profile highlight trigger function ACL verification failed';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
