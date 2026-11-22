-- Verify the Realtime Authorization policies for the private message-deletion
-- broadcast channel on a throwaway CI database.

begin;

select set_config('test.a', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.b', '00000000-0000-0000-0000-00000000000b', true);
select set_config('test.c', '00000000-0000-0000-0000-00000000000c', true);
select set_config('test.x', '00000000-0000-0000-0000-00000000000e', true);
select set_config('test.y', '00000000-0000-0000-0000-00000000000f', true);

do $$
begin
  if has_function_privilege('anon', 'public.aani_is_messages_conversation_topic(text)', 'EXECUTE') then
    raise exception 'anon must not execute the conversation topic helper';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_is_messages_conversation_topic(text)', 'EXECUTE') then
    raise exception 'authenticated must execute the conversation topic helper';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'aani_messages_conversation_broadcast_read'
      and cmd = 'SELECT'
      and roles = '{authenticated}'::name[]
  ) then
    raise exception 'Missing the private broadcast read policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'aani_messages_conversation_broadcast_write'
      and cmd = 'INSERT'
      and roles = '{authenticated}'::name[]
  ) then
    raise exception 'Missing the private broadcast write policy';
  end if;

  -- Topic parser: only a sorted pair containing the caller is accepted.
  if public.aani_is_messages_conversation_topic(
    'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b')
  ) then
    raise exception 'The topic helper must not authorize without a JWT subject';
  end if;
  if public.aani_is_messages_conversation_topic('aani-conversation:b:a') then
    raise exception 'The topic helper must reject reversed pair order';
  end if;
  if public.aani_is_messages_conversation_topic('aani-conversation:a:b:extra') then
    raise exception 'The topic helper must reject malformed topics';
  end if;
end $$;

-- Seed one broadcast row so the SELECT policy can be evaluated row by row.
insert into realtime.messages (topic, extension, payload)
values (
  'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b'),
  'broadcast',
  '{}'::jsonb
);

set local role authenticated;

do $$
declare
  conversation_topic text := 'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b');
  foreign_topic text := 'aani-conversation:' || current_setting('test.x') || ':' || current_setting('test.y');
  visible integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.a'), true);

  -- A participant may publish to the conversation topic.
  insert into realtime.messages (topic, extension, payload)
  values (conversation_topic, 'broadcast', '{}'::jsonb);

  -- A participant sees the conversation rows.
  perform set_config('realtime.topic', conversation_topic, true);
  select count(*) into visible from realtime.messages where topic = conversation_topic;
  if visible < 1 then
    raise exception 'A participant must read their conversation topic, saw %', visible;
  end if;

  -- A different conversation is invisible and publishing to it is denied.
  perform set_config('realtime.topic', foreign_topic, true);
  select count(*) into visible from realtime.messages where topic = foreign_topic;
  if visible is distinct from 0 then
    raise exception 'A non-participant topic must be invisible, saw %', visible;
  end if;
  begin
    insert into realtime.messages (topic, extension, payload)
    values (foreign_topic, 'broadcast', '{}'::jsonb);
    raise exception 'A user must not publish to a foreign conversation topic';
  exception
    when insufficient_privilege then null;
  end;

  -- C is outside the A/B conversation.
  perform set_config('request.jwt.claim.sub', current_setting('test.c'), true);
  perform set_config('realtime.topic', conversation_topic, true);
  select count(*) into visible from realtime.messages where topic = conversation_topic;
  if visible is distinct from 0 then
    raise exception 'A third user must not read the conversation topic, saw %', visible;
  end if;
  begin
    insert into realtime.messages (topic, extension, payload)
    values (conversation_topic, 'broadcast', '{}'::jsonb);
    raise exception 'A third user must not publish to the conversation topic';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- Anonymous access is denied.
reset role;
set local role anon;

do $$
begin
  begin
    insert into realtime.messages (topic, extension, payload)
    values (
      'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b'),
      'broadcast',
      '{}'::jsonb
    );
    raise exception 'anon must not publish to private broadcast topics';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform count(*) from realtime.messages;
    raise exception 'anon must not read private broadcast topics';
  exception
    when insufficient_privilege then null;
  end;
end $$;

rollback;
