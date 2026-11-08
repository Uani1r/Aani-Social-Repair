begin;

create table if not exists public.message_conversation_requests (
  participant_one_id uuid not null references public.profiles(id) on delete cascade,
  participant_two_id uuid not null references public.profiles(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  decided_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (participant_one_id, participant_two_id),
  constraint message_conversation_requests_order_check check (participant_one_id < participant_two_id),
  constraint message_conversation_requests_participants_check check (
    requester_id <> recipient_id
    and requester_id in (participant_one_id, participant_two_id)
    and recipient_id in (participant_one_id, participant_two_id)
  )
);

create index if not exists aani_message_requests_recipient_status_idx
  on public.message_conversation_requests (recipient_id, status, updated_at desc);

alter table public.message_conversation_requests enable row level security;
revoke all on public.message_conversation_requests from public, anon, authenticated;
grant select on public.message_conversation_requests to authenticated;

drop policy if exists aani_message_requests_select_participant on public.message_conversation_requests;
create policy aani_message_requests_select_participant on public.message_conversation_requests
  for select to authenticated
  using (
    participant_one_id = (select auth.uid())
    or participant_two_id = (select auth.uid())
  );

create or replace function public.aani_track_message_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant_low uuid := least(new.sender_id, new.recipient_id);
  participant_high uuid := greatest(new.sender_id, new.recipient_id);
begin
  if new.sender_id = new.recipient_id then
    return new;
  end if;

  if not exists (
    select 1 from public.follows
    where follower_id = new.sender_id and following_id = new.recipient_id
  ) or not exists (
    select 1 from public.follows
    where follower_id = new.recipient_id and following_id = new.sender_id
  ) then
    insert into public.message_conversation_requests (
      participant_one_id, participant_two_id, requester_id, recipient_id, status
    ) values (
      participant_low, participant_high, new.sender_id, new.recipient_id, 'pending'
    )
    on conflict (participant_one_id, participant_two_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_messages_track_request on public.messages;
create trigger aani_messages_track_request
after insert on public.messages
for each row execute function public.aani_track_message_request();

with latest_messages as (
  select distinct on (least(message.sender_id, message.recipient_id), greatest(message.sender_id, message.recipient_id))
    least(message.sender_id, message.recipient_id) as participant_one_id,
    greatest(message.sender_id, message.recipient_id) as participant_two_id,
    message.sender_id as requester_id,
    message.recipient_id as recipient_id
  from public.messages as message
  where message.sender_id is not null
    and message.recipient_id is not null
    and message.sender_id <> message.recipient_id
  order by
    least(message.sender_id, message.recipient_id),
    greatest(message.sender_id, message.recipient_id),
    message.created_at desc,
    message.id desc
)
insert into public.message_conversation_requests (
  participant_one_id, participant_two_id, requester_id, recipient_id, status
)
select
  latest.participant_one_id,
  latest.participant_two_id,
  latest.requester_id,
  latest.recipient_id,
  case when exists (
    select 1 from public.messages as response
    where response.sender_id = latest.recipient_id
      and response.recipient_id = latest.requester_id
  ) then 'accepted' else 'pending' end
from latest_messages as latest
where not exists (
  select 1 from public.follows
  where follower_id = latest.requester_id and following_id = latest.recipient_id
)
   or not exists (
  select 1 from public.follows
  where follower_id = latest.recipient_id and following_id = latest.requester_id
)
on conflict (participant_one_id, participant_two_id) do nothing;

create or replace function public.aani_set_message_conversation_request(
  p_other_user_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  participant_low uuid;
  participant_high uuid;
  current_status text;
  request_recipient uuid;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;
  if p_status not in ('accepted', 'declined') then
    raise exception 'Invalid message request decision' using errcode = '22023';
  end if;

  participant_low := least(actor_id, p_other_user_id);
  participant_high := greatest(actor_id, p_other_user_id);
  select request.status, request.recipient_id
    into current_status, request_recipient
    from public.message_conversation_requests as request
   where request.participant_one_id = participant_low
     and request.participant_two_id = participant_high
   for update;

  if not found then
    if exists (
      select 1 from public.follows
      where follower_id = actor_id and following_id = p_other_user_id
    ) and exists (
      select 1 from public.follows
      where follower_id = p_other_user_id and following_id = actor_id
    ) then
      raise exception 'This conversation is not a message request' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.messages as message
      where message.sender_id = p_other_user_id
        and message.recipient_id = actor_id
    ) then
      raise exception 'This message request is not awaiting a decision' using errcode = '42501';
    end if;

    insert into public.message_conversation_requests (
      participant_one_id, participant_two_id, requester_id, recipient_id, status
    ) values (
      participant_low, participant_high, p_other_user_id, actor_id, 'pending'
    ) on conflict (participant_one_id, participant_two_id) do nothing;

    select request.status, request.recipient_id
      into current_status, request_recipient
      from public.message_conversation_requests as request
     where request.participant_one_id = participant_low
       and request.participant_two_id = participant_high
      for update;
  end if;

  if request_recipient <> actor_id or current_status <> 'pending' then
    raise exception 'This message request is not awaiting a decision' using errcode = '42501';
  end if;

  update public.message_conversation_requests
     set status = p_status,
         decided_by = actor_id,
         updated_at = now()
   where participant_one_id = participant_low
     and participant_two_id = participant_high;
end;
$$;

create or replace function public.aani_delete_declined_message_request(p_other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  participant_low uuid;
  participant_high uuid;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;

  participant_low := least(actor_id, p_other_user_id);
  participant_high := greatest(actor_id, p_other_user_id);
  if not exists (
    select 1 from public.message_conversation_requests as request
    where request.participant_one_id = participant_low
      and request.participant_two_id = participant_high
      and request.recipient_id = actor_id
      and request.status = 'declined'
  ) then
    raise exception 'This declined message request cannot be deleted' using errcode = '42501';
  end if;

  delete from public.messages as message
   where (message.sender_id = actor_id and message.recipient_id = p_other_user_id)
      or (message.sender_id = p_other_user_id and message.recipient_id = actor_id);
  delete from public.message_conversation_requests as request
   where request.participant_one_id = participant_low
     and request.participant_two_id = participant_high;
end;
$$;

create or replace function public.aani_enforce_message_request_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant_low uuid := least(new.sender_id, new.recipient_id);
  participant_high uuid := greatest(new.sender_id, new.recipient_id);
  request_status text;
  request_requester uuid;
  request_recipient uuid;
  already_messaged boolean;
begin
  select request.status, request.requester_id, request.recipient_id
    into request_status, request_requester, request_recipient
    from public.message_conversation_requests as request
   where request.participant_one_id = participant_low
     and request.participant_two_id = participant_high;

  if not found or request_status = 'accepted' then
    return new;
  end if;
  if request_status = 'declined' then
    raise exception 'This message request was declined' using errcode = '42501';
  end if;
  if new.sender_id = request_recipient then
    raise exception 'Accept the message request before replying' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.messages as message
    where (message.sender_id = new.sender_id and message.recipient_id = new.recipient_id)
       or (message.sender_id = new.recipient_id and message.recipient_id = new.sender_id)
  ) into already_messaged;
  if new.sender_id = request_requester and already_messaged then
    raise exception 'Wait for the message request to be accepted before sending again' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists aani_messages_enforce_request_send on public.messages;
create trigger aani_messages_enforce_request_send
before insert on public.messages
for each row execute function public.aani_enforce_message_request_send();

revoke all on function public.aani_track_message_request() from public, anon, authenticated;
revoke all on function public.aani_enforce_message_request_send() from public, anon, authenticated;
revoke all on function public.aani_set_message_conversation_request(uuid, text) from public, anon;
revoke all on function public.aani_delete_declined_message_request(uuid) from public, anon;
grant execute on function public.aani_set_message_conversation_request(uuid, text) to authenticated;
grant execute on function public.aani_delete_declined_message_request(uuid) to authenticated;

alter table public.message_conversation_requests replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'message_conversation_requests'
     ) then
    execute 'alter publication supabase_realtime add table public.message_conversation_requests';
  end if;
end;
$$;

commit;
