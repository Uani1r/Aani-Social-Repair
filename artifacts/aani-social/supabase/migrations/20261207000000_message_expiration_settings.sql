begin;

alter table public.messages
  add column if not exists expires_at timestamptz;

create index if not exists aani_messages_expires_at_idx
  on public.messages (expires_at)
  where expires_at is not null;

create table if not exists public.message_conversation_settings (
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  expiration_seconds integer,
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint aani_message_settings_participant_order check (user_a < user_b),
  constraint aani_message_settings_expiration_allowed check (
    expiration_seconds is null
    or expiration_seconds in (3600, 18000, 36000, 86400, 604800)
  )
);

alter table public.message_conversation_settings enable row level security;
revoke all on public.message_conversation_settings from public, anon, authenticated;

create or replace function public.aani_set_message_expiration(
  p_other_user_id uuid,
  p_duration_seconds integer
)
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
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;
  if p_duration_seconds is not null
     and p_duration_seconds not in (3600, 18000, 36000, 86400, 604800) then
    raise exception 'Unsupported message expiration duration' using errcode = '22023';
  end if;

  insert into public.message_conversation_settings (user_a, user_b, expiration_seconds, updated_at)
  values (least(actor_id, p_other_user_id), greatest(actor_id, p_other_user_id), p_duration_seconds, pg_catalog.now())
  on conflict (user_a, user_b) do update
    set expiration_seconds = excluded.expiration_seconds,
        updated_at = excluded.updated_at;
end;
$$;

create or replace function public.aani_get_message_expiration(p_other_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  configured_seconds integer;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;

  select setting.expiration_seconds into configured_seconds
  from public.message_conversation_settings as setting
  where setting.user_a = least(actor_id, p_other_user_id)
    and setting.user_b = greatest(actor_id, p_other_user_id);
  return configured_seconds;
end;
$$;

create or replace function public.aani_apply_message_expiration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  configured_seconds integer;
begin
  select setting.expiration_seconds into configured_seconds
  from public.message_conversation_settings as setting
  where setting.user_a = least(new.sender_id, new.recipient_id)
    and setting.user_b = greatest(new.sender_id, new.recipient_id);

  if configured_seconds is null then
    new.expires_at := null;
  else
    new.expires_at := pg_catalog.now() + (configured_seconds * interval '1 second');
  end if;
  return new;
end;
$$;

drop trigger if exists aani_apply_message_expiration on public.messages;
create trigger aani_apply_message_expiration
  before insert on public.messages
  for each row execute function public.aani_apply_message_expiration();

create or replace function public.aani_purge_expired_messages()
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  expired_message_ids uuid[];
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  with deleted_messages as (
    delete from public.messages as message
    where message.expires_at <= pg_catalog.now()
      and (message.sender_id = actor_id or message.recipient_id = actor_id)
    returning message.id
  )
  select coalesce(pg_catalog.array_agg(id), array[]::uuid[])
  into expired_message_ids
  from deleted_messages;

  return expired_message_ids;
end;
$$;

create or replace function public.aani_cleanup_expired_messages()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.messages as message
  where message.expires_at <= pg_catalog.now();
$$;

revoke all on function public.aani_set_message_expiration(uuid, integer) from public, anon;
revoke all on function public.aani_get_message_expiration(uuid) from public, anon;
revoke all on function public.aani_apply_message_expiration() from public, anon, authenticated;
revoke all on function public.aani_purge_expired_messages() from public, anon;
revoke all on function public.aani_cleanup_expired_messages() from public, anon, authenticated;
grant execute on function public.aani_set_message_expiration(uuid, integer) to authenticated;
grant execute on function public.aani_get_message_expiration(uuid) to authenticated;
grant execute on function public.aani_purge_expired_messages() to authenticated;

-- Use pg_cron when it is available; expiration still gets purged when either participant opens messages.
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      execute 'create extension if not exists pg_cron';
      execute $schedule$
        select cron.schedule(
          'aani-expired-message-cleanup',
          '* * * * *',
          'select public.aani_cleanup_expired_messages();'
        )
      $schedule$;
    exception when others then
      raise warning 'Could not schedule Aani message expiration cleanup: %', sqlerrm;
    end;
  end if;
end;
$$;

commit;
