-- Verify the restored single-message delete RPCs on a throwaway CI database.
-- Never runs against a Supabase project.

begin;

-- Seed as the CI superuser (RLS bypassed).
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c');

insert into public.messages (id, sender_id, recipient_id, content) values
  -- A/B conversation.
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B, A hides it'),
  ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', 'B to A, A hides it and may not unsend it'),
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B, A unsends it'),
  ('10000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B, untouched'),
  -- B/C conversation, which A does not take part in.
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c', 'B to C, private');

-- Function shape and privileges after the migration was applied twice.
do $$
declare
  expected record;
  function_oid oid;
  function_config text[];
begin
  for expected in
    select * from (values
      ('aani_hide_message'),
      ('aani_delete_message_for_everyone')
    ) as functions(function_name)
  loop
    function_oid := to_regprocedure('public.' || expected.function_name || '(uuid)')::oid;

    if function_oid is null then
      raise exception 'public.%(uuid) must exist after the migration', expected.function_name;
    end if;

    select proconfig into function_config from pg_proc where oid = function_oid;

    if not (select prosecdef from pg_proc where oid = function_oid) then
      raise exception 'public.% must be SECURITY DEFINER', expected.function_name;
    end if;

    if (select prorettype from pg_proc where oid = function_oid) <> 'void'::regtype then
      raise exception 'public.% must return void', expected.function_name;
    end if;

    if not exists (
      select 1
      from unnest(coalesce(function_config, '{}'::text[])) as setting
      where setting like 'search_path=%'
        and setting not like '%public%'
    ) then
      raise exception 'public.% must run with a hardened search_path', expected.function_name;
    end if;

    if not has_function_privilege('authenticated', function_oid, 'EXECUTE') then
      raise exception 'authenticated must be able to execute public.%', expected.function_name;
    end if;

    if has_function_privilege('anon', function_oid, 'EXECUTE') then
      raise exception 'anon must not be able to execute public.%', expected.function_name;
    end if;

    if exists (
      select 1
      from pg_proc as proc, aclexplode(proc.proacl) as privilege
      where proc.oid = function_oid
        and privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE'
    ) then
      raise exception 'PUBLIC must not hold EXECUTE on public.%', expected.function_name;
    end if;
  end loop;
end $$;

-- A: hide as sender, hide as recipient, and unsend only what A sent.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

do $$
declare
  hide_count integer;
  visible_count integer;
  error_message text;
begin
  -- The sender hides a message they sent.
  perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a1'::uuid);

  -- Repeating the call must not create a second row.
  perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a1'::uuid);

  -- The recipient hides a message they received.
  perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a2'::uuid);

  select count(*) into hide_count from public.message_hides;
  if hide_count is distinct from 2 then
    raise exception 'A must own exactly 2 hides after 3 hide calls, saw %', hide_count;
  end if;

  -- A does not take part in the B/C conversation.
  begin
    perform public.aani_hide_message('10000000-0000-0000-0000-0000000000b2'::uuid);
    raise exception 'A non-participant must not hide a message';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Message is unavailable to this user%' then
        raise exception 'Expected the participant guard for hide, got: %', error_message;
      end if;
  end;

  -- A received a2, so only its sender may delete it for everyone.
  begin
    perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a2'::uuid);
    raise exception 'A recipient must not delete a message for everyone';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Only the message sender may delete it for everyone%' then
        raise exception 'Expected the sender guard for delete, got: %', error_message;
      end if;
  end;

  begin
    perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000b2'::uuid);
    raise exception 'A non-participant must not delete a message for everyone';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Only the message sender may delete it for everyone%' then
        raise exception 'Expected the sender guard for a foreign conversation, got: %', error_message;
      end if;
  end;

  -- A sent a3, so A may delete it for everyone.
  perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a3'::uuid);

  -- The row is already gone, so a retry returns quietly instead of raising.
  perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a3'::uuid);

  -- A still sees a1, a2, and a4: only a3 was removed, and the B/C message was
  -- never visible to A.
  select count(*) into visible_count from public.messages;
  if visible_count is distinct from 3 then
    raise exception 'A must still see 3 messages after unsending only a3, saw %', visible_count;
  end if;
end $$;

-- Remaining rows, checked as the superuser so every hide row is readable.
reset role;

do $$
declare
  remaining integer;
begin
  if exists (select 1 from public.messages where id = '10000000-0000-0000-0000-0000000000a3') then
    raise exception 'The sender delete must remove the message';
  end if;

  select count(*) into remaining
  from public.messages
  where id in (
    '10000000-0000-0000-0000-0000000000a1',
    '10000000-0000-0000-0000-0000000000a2',
    '10000000-0000-0000-0000-0000000000a4',
    '10000000-0000-0000-0000-0000000000b2'
  );
  if remaining is distinct from 4 then
    raise exception 'Deleting one message must leave the other 4 untouched, found %', remaining;
  end if;

  select count(*) into remaining from public.message_hides;
  if remaining is distinct from 2 then
    raise exception 'Only A''s 2 hides must exist, found %', remaining;
  end if;

  select count(*) into remaining
  from public.message_hides
  where user_id = '00000000-0000-0000-0000-00000000000a'
    and message_id in (
      '10000000-0000-0000-0000-0000000000a1',
      '10000000-0000-0000-0000-0000000000a2'
    );
  if remaining is distinct from 2 then
    raise exception 'The hides must belong to A on a1 and a2, found %', remaining;
  end if;

  -- A hide is recorded for the caller only, never mirrored onto the other party.
  if exists (
    select 1
    from public.message_hides
    where user_id <> '00000000-0000-0000-0000-00000000000a'
  ) then
    raise exception 'Hiding a message must not create a row for the other party';
  end if;
end $$;

-- B: hide as sender in both conversations, and never unsend what B received.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);

do $$
declare
  hide_count integer;
  error_message text;
begin
  perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a2'::uuid);
  perform public.aani_hide_message('10000000-0000-0000-0000-0000000000b2'::uuid);

  select count(*) into hide_count from public.message_hides;
  if hide_count is distinct from 2 then
    raise exception 'B must own exactly 2 hides, saw %', hide_count;
  end if;

  begin
    perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a4'::uuid);
    raise exception 'B received a4 and must not delete it for everyone';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Only the message sender may delete it for everyone%' then
        raise exception 'Expected the sender guard for B, got: %', error_message;
      end if;
  end;
end $$;

reset role;

do $$
declare
  remaining integer;
begin
  select count(*) into remaining from public.message_hides;
  if remaining is distinct from 4 then
    raise exception 'Expected 4 hides across A and B, found %', remaining;
  end if;

  select count(*) into remaining
  from public.message_hides
  where user_id = '00000000-0000-0000-0000-00000000000b'
    and message_id in (
      '10000000-0000-0000-0000-0000000000a2',
      '10000000-0000-0000-0000-0000000000b2'
    );
  if remaining is distinct from 2 then
    raise exception 'B''s hides must be on a2 and b2, found %', remaining;
  end if;
end $$;

-- An authenticated caller without a JWT subject is rejected by both RPCs.
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);

do $$
declare
  error_message text;
begin
  begin
    perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a1'::uuid);
    raise exception 'An unauthenticated caller must not hide a message';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Authentication is required%' then
        raise exception 'Expected the authentication guard for hide, got: %', error_message;
      end if;
  end;

  begin
    perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a1'::uuid);
    raise exception 'An unauthenticated caller must not delete a message for everyone';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%Authentication is required%' then
        raise exception 'Expected the authentication guard for delete, got: %', error_message;
      end if;
  end;
end $$;

-- Anonymous callers are blocked by the missing grant, not by a function guard.
reset role;
set local role anon;

do $$
declare
  error_message text;
begin
  begin
    perform public.aani_hide_message('10000000-0000-0000-0000-0000000000a1'::uuid);
    raise exception 'anon must not execute the hide RPC';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%permission denied for function%' then
        raise exception 'anon must be blocked by the grant, got: %', error_message;
      end if;
  end;

  begin
    perform public.aani_delete_message_for_everyone('10000000-0000-0000-0000-0000000000a1'::uuid);
    raise exception 'anon must not execute the delete-for-everyone RPC';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message not like '%permission denied for function%' then
        raise exception 'anon must be blocked by the grant, got: %', error_message;
      end if;
  end;
end $$;

reset role;

rollback;
