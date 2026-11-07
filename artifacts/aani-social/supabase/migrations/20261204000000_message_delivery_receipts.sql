begin;

alter table public.messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

create or replace function public.aani_mark_messages_delivered(p_message_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  update public.messages as message
     set delivered_at = now()
   where message.id = any(coalesce(p_message_ids, array[]::uuid[]))
     and message.recipient_id = actor_id
     and message.delivered_at is null;
end;
$$;

create or replace function public.aani_mark_conversation_read(p_sender_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_sender_id is null or p_sender_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;

  update public.messages as message
     set delivered_at = coalesce(message.delivered_at, now()),
         read_at = coalesce(message.read_at, now())
   where message.sender_id = p_sender_id
     and message.recipient_id = actor_id
     and message.read_at is null;
end;
$$;

revoke all on function public.aani_mark_messages_delivered(uuid[]) from public, anon;
revoke all on function public.aani_mark_conversation_read(uuid) from public, anon;
grant execute on function public.aani_mark_messages_delivered(uuid[]) to authenticated;
grant execute on function public.aani_mark_conversation_read(uuid) to authenticated;

commit;
