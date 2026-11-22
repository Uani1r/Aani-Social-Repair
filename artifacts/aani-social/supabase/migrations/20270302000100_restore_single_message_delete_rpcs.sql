begin;

-- Restore the two single-message RPCs that MessagesPage calls when a user
-- deletes one message from an open conversation:
--
--   aani_hide_message(p_message_id)                  -> "delete for me"
--   aani_delete_message_for_everyone(p_message_id)   -> "delete for everyone"
--
-- Both were defined in
-- 20261205000000_message_reactions_reports_replies.sql but are missing from the
-- production database, so the per-message delete path fails there. Their
-- conversation-wide counterparts (aani_hide_message_conversation,
-- aani_delete_message_conversation_for_everyone) are intentionally untouched,
-- as are RLS, Realtime, Broadcast and notification behaviour.
--
-- CREATE OR REPLACE plus the REVOKE/GRANT pair makes this safe to re-apply.

create or replace function public.aani_hide_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  message_visible boolean;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  -- Only a participant of the conversation may hide the message, whether they
  -- sent it or received it. A missing message is treated the same way.
  select exists (
    select 1
    from public.messages as message
    where message.id = p_message_id
      and (message.sender_id = actor_id or message.recipient_id = actor_id)
  ) into message_visible;
  if not message_visible then
    raise exception 'Message is unavailable to this user' using errcode = '42501';
  end if;

  insert into public.message_hides (user_id, message_id)
  values (actor_id, p_message_id)
  on conflict (user_id, message_id) do nothing;
end;
$$;

create or replace function public.aani_delete_message_for_everyone(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  message_sender_id uuid;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select message.sender_id into message_sender_id
  from public.messages as message
  where message.id = p_message_id;

  -- The message is already gone: return quietly instead of raising, so a retry
  -- after a lost response cannot surface a spurious error to the sender.
  if not found then
    return;
  end if;

  if message_sender_id <> actor_id then
    raise exception 'Only the message sender may delete it for everyone' using errcode = '42501';
  end if;

  delete from public.messages as message
  where message.id = p_message_id
    and message.sender_id = actor_id;
end;
$$;

revoke all on function public.aani_hide_message(uuid) from public, anon;
revoke all on function public.aani_delete_message_for_everyone(uuid) from public, anon;
grant execute on function public.aani_hide_message(uuid) to authenticated;
grant execute on function public.aani_delete_message_for_everyone(uuid) to authenticated;

commit;
