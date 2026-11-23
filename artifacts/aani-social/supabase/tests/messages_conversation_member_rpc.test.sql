-- Verifies the conversation-membership RPC used before joining a private
-- conversation topic: idempotent, participant-only, and blocked pairs refused.

begin;

select set_config('test.a', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.b', '00000000-0000-0000-0000-00000000000b', true);
select set_config('test.c', '00000000-0000-0000-0000-00000000000c', true);
select set_config('test.d', '00000000-0000-0000-0000-00000000000d', true);

-- Anonymous callers cannot execute the function at all.
do $$
begin
  if has_function_privilege('anon', 'public.aani_ensure_message_conversation_member(uuid)', 'execute') then
    raise exception 'anon must not execute the membership RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_ensure_message_conversation_member(uuid)', 'execute') then
    raise exception 'authenticated must execute the membership RPC';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.a'), true);

-- A opens a conversation with C before any message exists between them.
do $$
declare
  ok boolean;
  pairs integer;
begin
  ok := public.aani_ensure_message_conversation_member(current_setting('test.c')::uuid);
  if ok is not true then
    raise exception 'A must be able to prepare a new conversation with C';
  end if;

  select count(*) into pairs from public.aani_message_conversation_members
  where user_a = least(current_setting('test.a')::uuid, current_setting('test.c')::uuid)
    and user_b = greatest(current_setting('test.a')::uuid, current_setting('test.c')::uuid);

  if pairs is distinct from 1 then
    raise exception 'Expected exactly one membership row for A-C, got %', pairs;
  end if;
end $$;

-- Idempotent: a repeated call adds no row (two backfilled pairs + A-C = 3).
do $$
declare
  ok boolean;
  total integer;
begin
  ok := public.aani_ensure_message_conversation_member(current_setting('test.c')::uuid);
  if ok is not true then
    raise exception 'A repeat call must stay successful';
  end if;

  select count(*) into total from public.aani_message_conversation_members;
  if total is distinct from 3 then
    raise exception 'A repeat call must not duplicate rows, got %', total;
  end if;
end $$;

-- The same pair, called from the other side, keeps a single row.
do $$
declare
  total integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.c'), true);
  perform public.aani_ensure_message_conversation_member(current_setting('test.a')::uuid);
  perform set_config('request.jwt.claim.sub', current_setting('test.a'), true);

  select count(*) into total from public.aani_message_conversation_members;
  if total is distinct from 3 then
    raise exception 'Both sides must share one membership row, got %', total;
  end if;
end $$;

-- A conversation with yourself is refused.
do $$
begin
  if public.aani_ensure_message_conversation_member(current_setting('test.a')::uuid) then
    raise exception 'Self membership must be refused';
  end if;
end $$;

-- A blocked pair is refused and writes no row.
insert into public.user_blocks (blocker_id, blocked_user_id)
values (current_setting('test.d')::uuid, current_setting('test.a')::uuid);

do $$
declare
  ok boolean;
  pairs integer;
begin
  ok := public.aani_ensure_message_conversation_member(current_setting('test.d')::uuid);
  if ok then
    raise exception 'A blocked pair must be refused';
  end if;

  select count(*) into pairs from public.aani_message_conversation_members
  where user_a = least(current_setting('test.a')::uuid, current_setting('test.d')::uuid)
    and user_b = greatest(current_setting('test.a')::uuid, current_setting('test.d')::uuid);

  if pairs is distinct from 0 then
    raise exception 'A blocked pair must not create membership, got %', pairs;
  end if;
end $$;

-- The migration must not widen the table: still select-only for participants.
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'aani_message_conversation_members'
      and cmd = 'INSERT'
  ) then
    raise exception 'The RPC migration must not add an INSERT policy';
  end if;
end $$;

rollback;
