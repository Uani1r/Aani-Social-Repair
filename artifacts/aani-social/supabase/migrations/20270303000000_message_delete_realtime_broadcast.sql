-- Broadcasts message deletions from the database so the other participant
-- always receives them, even when the deleting client's private channel has not
-- finished subscribing yet.
--
-- Payload carries ids only: message id, sender id, recipient id. No message
-- content, no reaction emoji, nothing else.
--
-- The event goes to the same private conversation topic the client already uses
-- (`aani-conversation:<idA>:<idB>`, ids sorted), so the Realtime Authorization
-- policies from 20270302000000_aani_conversation_broadcast_auth.sql decide who
-- may receive it. No RLS change and no public channel.
--
-- Broadcasting is best effort: a failure inside realtime.send() must never abort
-- the delete itself, so the call is wrapped in an exception handler and the
-- trigger is only created when the platform function exists.

begin;

create or replace function public.aani_broadcast_message_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.sender_id is null or old.recipient_id is null or old.sender_id = old.recipient_id then
    return old;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object(
        'messageId', old.id,
        'senderId', old.sender_id,
        'recipientId', old.recipient_id
      ),
      'message_deleted',
      'aani-conversation:' || least(old.sender_id, old.recipient_id)
        || ':' || greatest(old.sender_id, old.recipient_id),
      true
    );
  exception
    when others then
      -- A broadcast problem must not turn a successful delete into an error.
      null;
  end;

  return old;
end;
$$;

revoke all on function public.aani_broadcast_message_deleted() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise notice 'realtime.send is unavailable; skipping the message deletion broadcast trigger';
    return;
  end if;

  drop trigger if exists aani_broadcast_message_deleted on public.messages;
  create trigger aani_broadcast_message_deleted
    after delete on public.messages
    for each row execute function public.aani_broadcast_message_deleted();
end
$$;

commit;
