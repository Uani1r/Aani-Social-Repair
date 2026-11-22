-- Durable conversation membership + Realtime Authorization for the private
-- message-deletion Broadcast channel.
--
-- The client no longer subscribes to postgres_changes DELETE on messages or
-- message_reactions (a deleted row can carry its content). Deletions travel over
-- a private Broadcast channel per conversation, with ids only.
--
-- Joining that topic must stay possible even when the last message of the
-- conversation has been deleted, so authorization cannot depend on rows in
-- public.messages. This migration keeps a durable membership table:
--   * backfilled from every pair that already has messages,
--   * extended by a trigger for every new message,
--   * never deleted when messages are deleted.
-- Only the two participants can read their membership row, join the topic, or
-- publish to it.
--
-- Requires (dashboard): Realtime Settings -> disable "Allow public access".
-- Applying this migration to Supabase is required before private channels work;
-- without it the app keeps syncing deletions through the REST resync path.

begin;

create table if not exists public.aani_message_conversation_members (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint aani_message_conversation_members_order check (user_a < user_b)
);

create index if not exists aani_message_conversation_members_user_b_idx
  on public.aani_message_conversation_members (user_b) include (user_a);

-- Backfill every conversation that already has messages.
insert into public.aani_message_conversation_members (user_a, user_b)
select distinct
  least(message.sender_id, message.recipient_id),
  greatest(message.sender_id, message.recipient_id)
from public.messages as message
where message.sender_id <> message.recipient_id
on conflict (user_a, user_b) do nothing;

-- Remember new conversations as soon as the first message is written.
create or replace function public.aani_record_message_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_id is null or new.recipient_id is null or new.sender_id = new.recipient_id then
    return new;
  end if;

  insert into public.aani_message_conversation_members (user_a, user_b)
  values (least(new.sender_id, new.recipient_id), greatest(new.sender_id, new.recipient_id))
  on conflict (user_a, user_b) do nothing;

  return new;
end;
$$;

revoke all on function public.aani_record_message_conversation() from public, anon, authenticated;

drop trigger if exists aani_record_message_conversation on public.messages;
create trigger aani_record_message_conversation
  after insert on public.messages
  for each row execute function public.aani_record_message_conversation();

alter table public.aani_message_conversation_members enable row level security;
revoke all on public.aani_message_conversation_members from public, anon, authenticated;
grant select on public.aani_message_conversation_members to authenticated;

drop policy if exists aani_message_conversation_members_select_own on public.aani_message_conversation_members;
create policy aani_message_conversation_members_select_own on public.aani_message_conversation_members
  for select to authenticated
  using (
    user_a = (select auth.uid())
    or user_b = (select auth.uid())
  );

-- Realtime Authorization: only a participant of a recorded conversation can
-- join its topic or publish to it.
drop policy if exists aani_messages_conversation_broadcast_read on realtime.messages;
create policy aani_messages_conversation_broadcast_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1
      from public.aani_message_conversation_members as member
      where (member.user_a = (select auth.uid()) or member.user_b = (select auth.uid()))
        and 'aani-conversation:' || member.user_a || ':' || member.user_b = realtime.topic()
    )
  );

drop policy if exists aani_messages_conversation_broadcast_write on realtime.messages;
create policy aani_messages_conversation_broadcast_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1
      from public.aani_message_conversation_members as member
      where (member.user_a = (select auth.uid()) or member.user_b = (select auth.uid()))
        and 'aani-conversation:' || member.user_a || ':' || member.user_b = realtime.topic()
    )
  );

-- The earlier revision of this PR authorized by parsing the topic. Remove it so
-- no topic can be authorized without a membership row.
drop function if exists public.aani_is_messages_conversation_topic(text);

commit;
