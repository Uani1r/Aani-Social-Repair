-- ============================================================================
-- Seed direct EXECUTE grants in CI's throwaway PostgreSQL database so the
-- migration's role-specific REVOKEs are exercised on its next application.
-- ============================================================================

begin;

grant execute on function public.aani_validate_message_reply_target() to anon, authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc as procedure_row
    cross join lateral aclexplode(coalesce(
      procedure_row.proacl,
      acldefault('f', procedure_row.proowner)
    )) as function_acl
    where procedure_row.oid = 'public.aani_validate_message_reply_target()'::regprocedure
      and function_acl.grantee = 0
      and function_acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC ما زال يملك EXECUTE قبل اختبار سحب المنح المباشرة.';
  end if;

  if (
    select count(distinct role_row.rolname)
    from pg_proc as procedure_row
    cross join lateral aclexplode(coalesce(
      procedure_row.proacl,
      acldefault('f', procedure_row.proowner)
    )) as function_acl
    join pg_roles as role_row on role_row.oid = function_acl.grantee
    where procedure_row.oid = 'public.aani_validate_message_reply_target()'::regprocedure
      and role_row.rolname in ('anon', 'authenticated')
      and function_acl.privilege_type = 'EXECUTE'
  ) <> 2 then
    raise exception 'لم تُزرع منح EXECUTE المباشرة لكل من anon وauthenticated في سيناريو الاختبار.';
  end if;

  if not has_function_privilege('anon', 'public.aani_validate_message_reply_target()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.aani_validate_message_reply_target()', 'EXECUTE') then
    raise exception 'لم تُصبح منح EXECUTE المباشرة فعالة في سيناريو الاختبار.';
  end if;
end $$;

commit;
