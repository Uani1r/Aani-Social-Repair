-- Verify the durable conversation membership and the Realtime Authorization
-- policies for the private message-deletion broadcast channel.

begin;

select set_config('test.a', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.b', '00000000-0000-0000-0000-00000000000b', true);
select set_config('test.c', '00000000-0000-0000-0000-00000000000c', true);

-- Membership was backfilled from the existing messages, and new messages keep
-- recording it.
do $$
declare
  pair_count integer;
begin
  select count(*) into pair_count from public.aani_message_conversation_members;
  if pair_count is distinct from 2 then
    raise exception 'Expected two backfilled conversations, got %', pair_count;
  end if;

  insert into public.messages (id, sender_id, recipient_id, content)
  values (
    '10000000-0000-0000-0000-0000000000c3',
    current_setting('test.c'),
    current_setting('test.a'),
    'C to A'
  );

  if not exists (
    select 1 from public.aani_message_conversation_members
    where user_a = least(current_setting('test.a')::uuid, current_setting('test.c')::uuid)
      and user_b = greatest(current_setting('test.a')::uuid, current_setting('test.c')::uuid)
  ) then
    raise exception 'A new message must record its conversation membership';
  end if;
end $$;

-- Deleting every message must not remove membership.
delete from public.messages;

do $$
declare
  pair_count integer;
begin
  select count(*) into pair_count from public.aani_message_conversation_members;
  if pair_count is distinct from 3 then
    raise exception 'Membership must survive message deletion, got %', pair_count;
  end if;
end $$;

-- Policies exist and anon has no access to membership.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'aani_message_conversation_members'
      and policyname = 'aani_message_conversation_members_select_own'
  ) then
    raise exception 'Missing membership select policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'aani_messages_conversation_broadcast_read'
      and cmd = 'SELECT'
  ) then
    raise exception 'Missing the private broadcast read policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'aani_messages_conversation_broadcast_write'
      and cmd = 'INSERT'
  ) then
    raise exception 'Missing the private broadcast write policy';
  end if;

  if has_table_privilege('anon', 'public.aani_message_conversation_members', 'SELECT') then
    raise exception 'anon must not read conversation membership';
  end if;
end $$;

-- The conversation row for A/B is what the topic is built from.
insert into realtime.messages (topic, extension, payload)
values (
  'aani-conversation:' || least(current_setting('test.a'), current_setting('test.b'))
    || ':' || greatest(current_setting('test.a'), current_setting('test.b')),
  'broadcast',
  '{}'::jsonb
);

set local role authenticated;

do $$
declare
  conversation_topic text := 'aani-conversation:'
    || least(current_setting('test.a'), current_setting('test.b'))
    || ':' || greatest(current_setting('test.a'), current_setting('test.b'));
  foreign_topic text := 'aani-conversation:'
    || least(current_setting('test.b'), current_setting('test.c'))
    || ':' || greatest(current_setting('test.b'), current_setting('test.c'));
  membership_count integer;
  visible integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.a'), true);

  -- A sees only his two conversation membership rows.
  select count(*) into membership_count from public.aani_message_conversation_members;
  if membership_count is distinct from 2 then
    raise exception 'A participant must see exactly their own memberships, saw %', membership_count;
  end if;

  perform set_config('realtime.topic', conversation_topic, true);

  -- A participant may publish to the conversation topic.
  insert into realtime.messages (topic, extension, payload)
  values (conversation_topic, 'broadcast', '{}'::jsonb);

  -- And can still read the topic after every message was deleted.
  select count(*) into visible from realtime.messages where topic = conversation_topic;
  if visible < 1 then
    raise exception 'A participant must read their conversation topic, saw %', visible;
  end if;

  -- A conversation they are not part of is invisible and cannot be published to.
  perform set_config('realtime.topic', foreign_topic, true);
  select count(*) into visible from realtime.messages where topic = foreign_topic;
  if visible is distinct from 0 then
    raise exception 'A foreign conversation topic must be invisible, saw %', visible;
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
    raise exception 'A third user must not read the A/B topic, saw %', visible;
  end if;
  begin
    insert into realtime.messages (topic, extension, payload)
    values (conversation_topic, 'broadcast', '{}'::jsonb);
    raise exception 'A third user must not publish to the A/B topic';
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
      'aani-conversation:' || least(current_setting('test.a'), current_setting('test.b'))
        || ':' || greatest(current_setting('test.a'), current_setting('test.b')),
      'broadcast',
      '{}'::jsonb
    );
    raise exception 'anon must not publish to private broadcast topics';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform count(*) from public.aani_message_conversation_members;
    raise exception 'anon must not read conversation membership';
  exception
    when insufficient_privilege then null;
  end;
end $$;

rollback;
