-- Exercise the inbox summary and delivery RPCs only on the temporary CI schema.

begin;

insert into public.profiles (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004');

insert into public.messages (id, sender_id, recipient_id, content, created_at, read_at) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'old incoming', '2027-01-01T09:00:00Z', null),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'read tie', '2027-01-01T10:00:00Z', '2027-01-01T10:05:00Z'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'unread tie, highest id', '2027-01-01T10:00:00Z', null),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'newer message hidden only from sender', '2027-01-01T11:00:00Z', null),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'hidden only from recipient', '2027-01-01T12:00:00Z', null),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'blocked conversation', '2027-01-01T13:00:00Z', null);

insert into public.message_hides (user_id, message_id) values
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003');

insert into public.user_blocks (blocker_id, blocked_user_id)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

do $$
declare
  row_count bigint;
  latest_id text;
  unread bigint;
begin
  if has_function_privilege('anon', 'public.aani_get_messages_inbox_summaries(jsonb,timestamptz)', 'EXECUTE') then
    raise exception 'Anonymous users must not execute the inbox summary RPC.';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_get_messages_inbox_summaries(jsonb,timestamptz)', 'EXECUTE') then
    raise exception 'Authenticated users must be able to execute the inbox summary RPC.';
  end if;
  if has_function_privilege('anon', 'public.aani_mark_inbox_messages_delivered()', 'EXECUTE') then
    raise exception 'Anonymous users must not execute the inbox delivery RPC.';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_mark_inbox_messages_delivered()', 'EXECUTE') then
    raise exception 'Authenticated users must be able to execute the inbox delivery RPC.';
  end if;

  select count(*) into row_count
  from public.aani_get_messages_inbox_summaries(
    '{"00000000-0000-0000-0000-000000000002":"2027-01-01T09:30:00Z"}'::jsonb,
    '2027-01-01T09:45:00Z'
  );
  if row_count is distinct from 1 then
    raise exception 'Expected exactly one summary per visible contact, got %.', row_count;
  end if;

  select summary.last_message ->> 'id', summary.unread_count
    into latest_id, unread
  from public.aani_get_messages_inbox_summaries(
    '{"00000000-0000-0000-0000-000000000002":"2027-01-01T09:30:00Z"}'::jsonb,
    '2027-01-01T09:45:00Z'
  ) as summary
  where summary.contact_id = '00000000-0000-0000-0000-000000000002';
  if latest_id is distinct from '10000000-0000-0000-0000-000000000003' then
    raise exception 'Equal timestamps must use id descending, and a message hidden by this participant must not win; got %.', latest_id;
  end if;
  if unread is distinct from 1 then
    raise exception 'Expected one unread message after both read cutoffs and read_at filtering, got %.', unread;
  end if;

  select summary.unread_count into unread
  from public.aani_get_messages_inbox_summaries('{}'::jsonb, '2027-01-01T10:00:00Z') as summary
  where summary.contact_id = '00000000-0000-0000-0000-000000000002';
  if unread is distinct from 0 then
    raise exception 'A message at the read cutoff must not count as unread, got %.', unread;
  end if;

  select summary.unread_count into unread
  from public.aani_get_messages_inbox_summaries(
    '{"00000000-0000-0000-0000-000000000002":"not-a-timestamp"}'::jsonb,
    null
  ) as summary
  where summary.contact_id = '00000000-0000-0000-0000-000000000002';
  if unread is distinct from 2 then
    raise exception 'Malformed local cutoffs must fall back safely and count the two unread rows, got %.', unread;
  end if;

  if exists (
    select 1
    from public.aani_get_messages_inbox_summaries('{}'::jsonb, null) as summary
    where summary.contact_id = '00000000-0000-0000-0000-000000000003'
  ) then
    raise exception 'A hidden or blocked conversation must not appear in this participant’s summaries.';
  end if;

  perform public.aani_mark_inbox_messages_delivered();
end $$;

-- Inspect raw delivery state as the test owner, because RLS deliberately hides
-- the blocked and per-user-hidden rows from the authenticated caller.
reset role;
do $$
begin
  if exists (
    select 1 from public.messages
    where id in (
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000003'
    ) and delivered_at is null
  ) then
    raise exception 'Visible incoming messages must retain the inbox delivery acknowledgement.';
  end if;
  if exists (
    select 1 from public.messages
    where id in (
      '10000000-0000-0000-0000-000000000005',
      '10000000-0000-0000-0000-000000000006'
    ) and delivered_at is not null
  ) then
    raise exception 'Hidden or blocked incoming messages must not be marked delivered by inbox loading.';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$
declare
  row_count bigint;
  latest_id text;
  unread bigint;
begin
  select count(*) into row_count
  from public.aani_get_messages_inbox_summaries('{}'::jsonb, null);
  if row_count is distinct from 1 then
    raise exception 'A participant must receive one summary for their shared conversation, got %.', row_count;
  end if;

  select summary.last_message ->> 'id', summary.unread_count
    into latest_id, unread
  from public.aani_get_messages_inbox_summaries('{}'::jsonb, null) as summary
  where summary.contact_id = '00000000-0000-0000-0000-000000000001';
  if latest_id is distinct from '10000000-0000-0000-0000-000000000004' then
    raise exception 'A hide by the other participant must not hide the latest message for this actor; got %.', latest_id;
  end if;
  if unread is distinct from 1 then
    raise exception 'Expected one unread incoming message for the second participant, got %.', unread;
  end if;

  perform public.aani_mark_inbox_messages_delivered();
  if (select delivered_at from public.messages where id = '10000000-0000-0000-0000-000000000004') is null then
    raise exception 'The visible incoming message must be marked delivered for its recipient.';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
do $$
declare
  row_count bigint;
begin
  select count(*) into row_count
  from public.aani_get_messages_inbox_summaries('{}'::jsonb, null);
  if row_count is distinct from 0 then
    raise exception 'A blocked participant must not see the shared conversation, got % summaries.', row_count;
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
do $$
declare
  row_count bigint;
begin
  select count(*) into row_count
  from public.aani_get_messages_inbox_summaries('{}'::jsonb, null);
  if row_count is distinct from 0 then
    raise exception 'A user must not receive summaries for unrelated participants, got % rows.', row_count;
  end if;
end $$;

select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform count(*) from public.aani_get_messages_inbox_summaries('{}'::jsonb, null);
    raise exception 'An unauthenticated call should fail.';
  exception
    when sqlstate '42501' then null;
  end;
end $$;

rollback;
