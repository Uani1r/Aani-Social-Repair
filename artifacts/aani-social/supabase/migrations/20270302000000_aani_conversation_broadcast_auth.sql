-- Realtime Authorization for the private message-deletion broadcast channel.
--
-- The client no longer subscribes to postgres_changes DELETE on messages or
-- message_reactions (a deleted row can carry its content). Instead, a private
-- Broadcast channel per conversation carries message/reaction ids only.
--
-- This migration makes that private channel usable: authenticated users may
-- join a conversation topic only when they are one of its two members, and may
-- publish to it under the same rule. The function parses the topic itself, so no
-- table lookup is needed at join time.
--
-- Requires (dashboard): Realtime Settings -> disable "Allow public access".
-- Applying this migration to Supabase is required before private channels work;
-- without it the app keeps syncing deletions through the REST resync path.

begin;

create or replace function public.aani_is_messages_conversation_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  first_id text;
  second_id text;
begin
  if actor is null or p_topic is null then
    return false;
  end if;

  if p_topic !~* '^aani-conversation:[0-9a-f-]{36}:[0-9a-f-]{36}$' then
    return false;
  end if;

  first_id := split_part(p_topic, ':', 2);
  second_id := split_part(p_topic, ':', 3);

  -- الموضوع يُبنى دائماً بترتيب ثابت، فترتيب معكوس يعني موضوعاً غير صالح.
  return first_id < second_id
    and actor::text in (first_id, second_id);
end;
$$;

revoke all on function public.aani_is_messages_conversation_topic(text) from public, anon;
grant execute on function public.aani_is_messages_conversation_topic(text) to authenticated;

drop policy if exists aani_messages_conversation_broadcast_read on realtime.messages;
create policy aani_messages_conversation_broadcast_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.aani_is_messages_conversation_topic(realtime.topic())
  );

drop policy if exists aani_messages_conversation_broadcast_write on realtime.messages;
create policy aani_messages_conversation_broadcast_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.aani_is_messages_conversation_topic(realtime.topic())
  );

commit;
