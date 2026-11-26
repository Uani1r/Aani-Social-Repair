-- Verifies aani_reorder_profile_highlight_stories on a throwaway CI database.
-- Never runs against a Supabase project. The harness seeded two owners, three
-- collections and five stories, with the real unique (collection_id, position)
-- index and the real position >= 0 check; the migration was already applied
-- twice.

begin;

-- Case 9 and 10: shape, hardened settings, and EXECUTE grants for one role only.
do $$
declare
  v_oid oid := to_regprocedure('public.aani_reorder_profile_highlight_stories(uuid, uuid[])')::oid;
begin
  if v_oid is null then
    raise exception 'aani_reorder_profile_highlight_stories(uuid, uuid[]) must exist after two migration runs';
  end if;

  if (select count(*) from pg_proc where proname = 'aani_reorder_profile_highlight_stories') <> 1 then
    raise exception 'the reordering function must exist exactly once after a re-run';
  end if;

  if not (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'the reordering function must be SECURITY DEFINER';
  end if;

  if not exists (
    select 1
    from unnest(coalesce((select proconfig from pg_proc where oid = v_oid), '{}'::text[])) as setting
    where setting like 'search_path=%'
      and setting not like '%public%'
  ) then
    raise exception 'the reordering function must run with a hardened search_path';
  end if;

  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'authenticated must be able to execute the reordering function';
  end if;

  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'anon must not be able to execute the reordering function';
  end if;

  if exists (
    select 1
    from pg_proc as function_row
    cross join lateral aclexplode(coalesce(function_row.proacl, acldefault('f', function_row.proowner))) as entry
    where function_row.oid = v_oid
      and entry.grantee = 0
      and entry.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC must not be able to execute the reordering function';
  end if;
end;
$$;

-- Case 11: the schema under test is the real one. Without the unique index and
-- the position check, the swap cases below would prove less than production.
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'profile_highlights'
      and indexname = 'aani_profile_highlights_collection_position_unique_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ) then
    raise exception 'the harness must carry the real unique (collection_id, position) index';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profile_highlights'::regclass
      and conname = 'aani_profile_highlights_position_check'
      and contype = 'c'
  ) then
    raise exception 'the harness must carry the real position >= 0 check constraint';
  end if;

  if exists (
    select 1
    from public.profile_highlights
    group by collection_id, position
    having count(*) > 1
  ) then
    raise exception 'the seeded positions must be unique per collection before any reorder';
  end if;
end;
$$;

-- Owner A reorders the first collection.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-00000000000a', true);

-- Case 1: owned collection reorders, positions restart from zero, and moving
-- the last story to the front never collides with the unique
-- (collection_id, position) index while positions are swapped.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a3',
        '50000000-0000-4000-8000-0000000000a1',
        '50000000-0000-4000-8000-0000000000a2'
      ]::uuid[]
    );
  exception
    when sqlstate '23505' then
      raise exception 'moving the last story to the front must not raise 23505 on the unique (collection_id, position) index';
  end;
end;
$$;

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
    raise exception 'positions were not updated to the requested order: %', v_order;
  end if;

  if (select min(position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 0
    or (select max(position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 2
    or (select count(distinct position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 3 then
    raise exception 'positions must be sequential from 0 without gaps or duplicates';
  end if;

  -- Case 8: the owner's other collection is untouched.
  if (select position from public.profile_highlights where id = '50000000-0000-4000-8000-0000000000a4') <> 0 then
    raise exception 'reordering one collection must not move another collection';
  end if;
end;
$$;

-- Case 12: the opposite direction — the first story moves to the end. This is
-- the mirror swap, which collides with the same unique index from the other
-- side, and it must also finish without 23505.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a1',
        '50000000-0000-4000-8000-0000000000a2',
        '50000000-0000-4000-8000-0000000000a3'
      ]::uuid[]
    );
  exception
    when sqlstate '23505' then
      raise exception 'moving the first story to the end must not raise 23505 on the unique (collection_id, position) index';
  end;
end;
$$;

do $$
declare
  v_order uuid[];
begin
  select array_agg(id order by position) into v_order
  from public.profile_highlights
  where collection_id = 'c0000000-0000-4000-8000-00000000000a';

  if v_order <> array[
    '50000000-0000-4000-8000-0000000000a1',
    '50000000-0000-4000-8000-0000000000a2',
    '50000000-0000-4000-8000-0000000000a3'
  ]::uuid[] then
    raise exception 'moving the first story to the end produced the wrong order: %', v_order;
  end if;

  -- The temporary high range of the two-phase update must not survive the call.
  if (select min(position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 0
    or (select max(position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 2
    or (select count(distinct position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a') <> 3 then
    raise exception 'the temporary offset range must be gone after the call';
  end if;

  -- The shift only touches the reordered collection.
  if (select position from public.profile_highlights where id = '50000000-0000-4000-8000-0000000000a4') <> 0 then
    raise exception 'the two-phase update leaked into another collection';
  end if;
end;
$$;

-- Restores the order Case 1 asserted, so the rejection cases below start from
-- exactly the state they were written for.
select public.aani_reorder_profile_highlight_stories(
  'c0000000-0000-4000-8000-00000000000a',
  array[
    '50000000-0000-4000-8000-0000000000a3',
    '50000000-0000-4000-8000-0000000000a1',
    '50000000-0000-4000-8000-0000000000a2'
  ]::uuid[]
);

-- Case 6: an incomplete list is rejected and changes nothing.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a3',
        '50000000-0000-4000-8000-0000000000a1'
      ]::uuid[]
    );
    raise exception 'an incomplete story list must be rejected';
  exception
    when sqlstate '22023' then null;
  end;
end;
$$;

-- Case 5: duplicate ids are rejected.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a3',
        '50000000-0000-4000-8000-0000000000a3',
        '50000000-0000-4000-8000-0000000000a1'
      ]::uuid[]
    );
    raise exception 'duplicate ids must be rejected';
  exception
    when sqlstate '22023' then null;
  end;
end;
$$;

-- Case 4: a story from another collection is rejected even when the count matches.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a3',
        '50000000-0000-4000-8000-0000000000a1',
        '50000000-0000-4000-8000-0000000000b1'
      ]::uuid[]
    );
    raise exception 'a story from another collection must be rejected';
  exception
    when sqlstate '42501' then null;
  end;
end;
$$;

-- Case 3: another owner's collection is not reorderable.
do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000c',
      array['50000000-0000-4000-8000-0000000000b1']::uuid[]
    );
    raise exception 'another owner''s collection must be rejected';
  exception
    when sqlstate '42501' then null;
  end;
end;
$$;

-- Case 7: every rejected call above left both owners' order exactly as it was.
do $$
begin
  if (select array_agg(id order by position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a')
    <> array[
      '50000000-0000-4000-8000-0000000000a3',
      '50000000-0000-4000-8000-0000000000a1',
      '50000000-0000-4000-8000-0000000000a2'
    ]::uuid[] then
    raise exception 'a rejected call must not change the previous order';
  end if;

  if (select array_agg(id order by position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000c')
    <> array['50000000-0000-4000-8000-0000000000b1']::uuid[] then
    raise exception 'another owner''s stories must stay untouched';
  end if;
end;
$$;

-- Case 2: no session means no reordering.
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    perform public.aani_reorder_profile_highlight_stories(
      'c0000000-0000-4000-8000-00000000000a',
      array[
        '50000000-0000-4000-8000-0000000000a1',
        '50000000-0000-4000-8000-0000000000a2',
        '50000000-0000-4000-8000-0000000000a3'
      ]::uuid[]
    );
    raise exception 'an anonymous session must be rejected';
  exception
    when sqlstate '42501' then null;
  end;
end;
$$;

reset role;

-- Case 8 again: owner B still reorders their own collection after A's failures.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-00000000000b', true);

select public.aani_reorder_profile_highlight_stories(
  'c0000000-0000-4000-8000-00000000000c',
  array['50000000-0000-4000-8000-0000000000b1']::uuid[]
);

do $$
begin
  if (select position from public.profile_highlights where id = '50000000-0000-4000-8000-0000000000b1') <> 0 then
    raise exception 'the owner must be able to reorder their own collection';
  end if;

  if (select array_agg(id order by position) from public.profile_highlights where collection_id = 'c0000000-0000-4000-8000-00000000000a')
    <> array[
      '50000000-0000-4000-8000-0000000000a3',
      '50000000-0000-4000-8000-0000000000a1',
      '50000000-0000-4000-8000-0000000000a2'
    ]::uuid[] then
    raise exception 'owner B''s reorder must not touch owner A''s collection';
  end if;
end;
$$;

reset role;

rollback;
