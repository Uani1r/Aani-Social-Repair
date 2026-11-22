-- Verify the message deletion broadcast trigger (20270303000000):
--   * one message_deleted broadcast per deleted row, sent to the private
--     conversation topic of the two participants, in both directions;
--   * the payload carries ids only (no content, no emoji);
--   * a conversation that is not involved gets no broadcast;
--   * "delete for me" (message_hides) never broadcasts;
--   * a broadcast failure never aborts the delete.
-- Runs only in CI against a throwaway PostgreSQL.

begin;

select set_config('test.a', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.b', '00000000-0000-0000-0000-00000000000b', true);
select set_config('test.c', '00000000-0000-0000-0000-00000000000c', true);

-- The trigger migration is applied before this test runs, and the harness rows
-- were inserted before it, so none of the inserts below may broadcast a deletion.
insert into public.messages (id, sender_id, recipient_id, content) values
  ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B 1'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', 'B to A 2'),
  ('20000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000c', 'A to C 3');

-- Inserting messages must not broadcast a deletion.
do $$
begin
  if (select count(*) from realtime.messages where event = 'message_deleted') <> 0 then
    raise exception 'Inserting messages must not broadcast a deletion';
  end if;
end $$;

-- 1. Deleting one A to B message broadcasts once, to the A/B topic, ids only.
do $$
declare
  last_event record;
  events_before integer;
  events_after integer;
  expected_topic text := 'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b');
begin
  select count(*) into events_before from realtime.messages where event = 'message_deleted';

  delete from public.messages where id = '20000000-0000-0000-0000-0000000000a1';

  select count(*) into events_after from realtime.messages where event = 'message_deleted';
  if events_after - events_before <> 1 then
    raise exception 'Expected exactly 1 message_deleted broadcast, got %', events_after - events_before;
  end if;

  select * into last_event from realtime.messages where event = 'message_deleted' order by id desc limit 1;
  if last_event.topic is distinct from expected_topic then
    raise exception 'Deletion broadcast went to %, expected %', last_event.topic, expected_topic;
  end if;
  if last_event.private is distinct from true then
    raise exception 'Deletion broadcast must be private';
  end if;
  if last_event.payload is distinct from jsonb_build_object(
    'messageId', '20000000-0000-0000-0000-0000000000a1',
    'senderId', current_setting('test.a'),
    'recipientId', current_setting('test.b')
  ) then
    raise exception 'Deletion payload must carry ids only, got %', last_event.payload;
  end if;
end $$;

-- 2. The reverse direction (B to A) goes to the same topic.
do $$
declare
  last_topic text;
begin
  delete from public.messages where id = '20000000-0000-0000-0000-0000000000b2';

  select topic into last_topic from realtime.messages where event = 'message_deleted' order by id desc limit 1;
  if last_topic is distinct from ('aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.b')) then
    raise exception 'A deletion sent by B must use the same sorted topic, got %', last_topic;
  end if;
end $$;

-- 3. "Delete for me" writes message_hides only and must not broadcast.
do $$
declare
  events_before integer;
begin
  select count(*) into events_before from realtime.messages where event = 'message_deleted';
  insert into public.message_hides (user_id, message_id)
  values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000c3');
  if (select count(*) from realtime.messages where event = 'message_deleted') <> events_before then
    raise exception 'Hiding a message for one user must not broadcast a deletion';
  end if;
end $$;

-- 4. A conversation that is not involved gets no broadcast and keeps its row.
do $$
begin
  if exists (
    select 1 from realtime.messages
    where event = 'message_deleted'
      and topic = 'aani-conversation:' || current_setting('test.a') || ':' || current_setting('test.c')
  ) then
    raise exception 'A/C conversation must not have a deletion broadcast yet';
  end if;
  if not exists (select 1 from public.messages where id = '20000000-0000-0000-0000-0000000000c3') then
    raise exception 'A/C message must still exist';
  end if;
end $$;

-- 5. Conversation-wide delete for both sides: each deleted row broadcasts once,
--    and the A/B conversation is emptied in both directions.
insert into public.messages (id, sender_id, recipient_id, content) values
  ('20000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B 4'),
  ('20000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', 'B to A 5');

do $$
declare
  events_before integer;
  ab_rows_before integer;
  remaining integer;
begin
  select count(*) into events_before from realtime.messages where event = 'message_deleted';
  -- The harness also seeds an A to B row, so count the rows before deleting
  -- instead of assuming how many there are.
  select count(*) into ab_rows_before
  from public.messages
  where (sender_id = '00000000-0000-0000-0000-00000000000a' and recipient_id = '00000000-0000-0000-0000-00000000000b')
     or (sender_id = '00000000-0000-0000-0000-00000000000b' and recipient_id = '00000000-0000-0000-0000-00000000000a');

  delete from public.messages
  where (sender_id = '00000000-0000-0000-0000-00000000000a' and recipient_id = '00000000-0000-0000-0000-00000000000b')
     or (sender_id = '00000000-0000-0000-0000-00000000000b' and recipient_id = '00000000-0000-0000-0000-00000000000a');

  if (select count(*) from realtime.messages where event = 'message_deleted') - events_before <> ab_rows_before then
    raise exception 'Conversation-wide delete must broadcast once per deleted row (expected %)', ab_rows_before;
  end if;

  select count(*) into remaining
  from public.messages
  where (sender_id = '00000000-0000-0000-0000-00000000000a' and recipient_id = '00000000-0000-0000-0000-00000000000b')
     or (sender_id = '00000000-0000-0000-0000-00000000000b' and recipient_id = '00000000-0000-0000-0000-00000000000a');
  if remaining <> 0 then
    raise exception 'Conversation-wide delete must remove both directions, % left', remaining;
  end if;

  -- The A/C message is untouched by the A/B conversation-wide delete.
  if not exists (select 1 from public.messages where id = '20000000-0000-0000-0000-0000000000c3') then
    raise exception 'Conversation-wide delete must not touch other conversations';
  end if;
end $$;

-- 6. No broadcast carries message content or emoji.
do $$
begin
  if exists (
    select 1 from realtime.messages
    where event = 'message_deleted'
      and (payload ? 'content' or payload ? 'emoji' or payload ? 'text')
  ) then
    raise exception 'Deletion broadcasts must not carry content';
  end if;
end $$;

-- 7. A failing realtime.send must not abort the delete. The stub is replaced for
--    this check only; the rollback at the end restores it.
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean)
returns void
language plpgsql
as $$
begin
  raise exception 'simulated realtime outage';
end;
$$;

delete from public.messages where id = '20000000-0000-0000-0000-0000000000c3';
do $$
begin
  if exists (select 1 from public.messages where id = '20000000-0000-0000-0000-0000000000c3') then
    raise exception 'The delete must succeed even when the broadcast fails';
  end if;
end $$;

rollback;
