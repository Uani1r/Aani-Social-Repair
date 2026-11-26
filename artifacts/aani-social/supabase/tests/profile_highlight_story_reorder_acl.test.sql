-- Verifies the EXECUTE privileges of aani_reorder_profile_highlight_stories on a
-- throwaway CI database: authenticated may call it, anon and PUBLIC may not.
-- Never runs against a Supabase project.
--
-- Order matters: the reordering migration and this repository's ACL correction
-- (20270306000000) were applied, and Supabase's default grant to anon was
-- simulated in between, so Case 2 proves the correction removed a grant that was
-- really there.

begin;

-- Case 1: authenticated can execute the reordering function.
do $$
begin
  if not has_function_privilege('authenticated', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'authenticated must be able to execute the reordering function';
  end if;
end;
$$;

-- Case 2: anon cannot execute it, even though the simulated Supabase default
-- privileges had granted it before the correction migration.
do $$
begin
  if has_function_privilege('anon', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'anon must not be able to execute the reordering function';
  end if;
end;
$$;

-- Case 3: PUBLIC holds no EXECUTE, both in the stored ACL and in the effective
-- one (grantee 0 of the built-in default ACL).
do $$
begin
  if exists (
    select 1
    from pg_proc as function_row
    cross join lateral aclexplode(coalesce(function_row.proacl, acldefault('f', function_row.proowner))) as acl
    where function_row.oid = 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC must not be able to execute the reordering function';
  end if;
end;
$$;

-- Case 4: the correction touched privileges only — the function still exists
-- once, is SECURITY DEFINER, and keeps its hardened search_path.
do $$
declare
  v_oid oid := to_regprocedure('public.aani_reorder_profile_highlight_stories(uuid, uuid[])')::oid;
begin
  if v_oid is null then
    raise exception 'aani_reorder_profile_highlight_stories(uuid, uuid[]) must still exist after the ACL correction';
  end if;

  if (select count(*) from pg_proc where proname = 'aani_reorder_profile_highlight_stories') <> 1 then
    raise exception 'the ACL correction must not duplicate the reordering function';
  end if;

  if not (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'the reordering function must stay SECURITY DEFINER';
  end if;

  if not exists (
    select 1
    from unnest(coalesce((select proconfig from pg_proc where oid = v_oid), '{}'::text[])) as setting
    where setting like 'search_path=%'
      and setting not like '%public%'
  ) then
    raise exception 'the reordering function must keep its hardened search_path';
  end if;
end;
$$;

-- Case 5: an allowed call still works after the ACL change — the complete story
-- list is reordered as before, so the correction touched privileges only.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-00000000000a', true);

select public.aani_reorder_profile_highlight_stories(
  'c0000000-0000-4000-8000-00000000000a',
  array[
    '50000000-0000-4000-8000-0000000000a3',
    '50000000-0000-4000-8000-0000000000a1',
    '50000000-0000-4000-8000-0000000000a2'
  ]::uuid[]
);

do $$
declare
  v_order uuid[];
begin
  select array_agg(id order by position) into v_order
  from public.profile_highlights
  where collection_id = 'c0000000-0000-4000-8000-00000000000a';

  if v_order <> array[
    '50000000-0000-4000-8000-0000000000a3',
    '50000000-0000-4000-8000-0000000000a1',
    '50000000-0000-4000-8000-0000000000a2'
  ]::uuid[] then
    raise exception 'an allowed call must still reorder the collection: %', v_order;
  end if;
end;
$$;

reset role;

rollback;
