begin;

alter table public.message_conversation_settings
  drop constraint if exists aani_message_settings_expiration_allowed;

alter table public.message_conversation_settings
  add constraint aani_message_settings_expiration_allowed check (
    expiration_seconds is null
    or expiration_seconds in (3600, 18000, 36000, 86400, 604800, 7776000)
  );

create table if not exists public.message_global_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  expiration_seconds integer,
  updated_at timestamptz not null default now(),
  constraint aani_message_global_expiration_allowed check (
    expiration_seconds is null
    or expiration_seconds in (86400, 604800, 7776000)
  )
);

alter table public.message_global_settings enable row level security;
revoke all on public.message_global_settings from public, anon, authenticated;

create or replace function public.aani_set_global_message_expiration(p_duration_seconds integer)
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
  if p_duration_seconds is not null
     and p_duration_seconds not in (86400, 604800, 7776000) then
    raise exception 'Unsupported global message expiration duration' using errcode = '22023';
  end if;

  insert into public.message_global_settings (user_id, expiration_seconds, updated_at)
  values (actor_id, p_duration_seconds, pg_catalog.now())
  on conflict (user_id) do update
    set expiration_seconds = excluded.expiration_seconds,
        updated_at = excluded.updated_at;
end;
$$;

create or replace function public.aani_get_global_message_expiration()
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
    return null;
  end if;

  select setting.expiration_seconds into configured_seconds
  from public.message_global_settings as setting
  where setting.user_id = actor_id;
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
  from public.message_global_settings as setting
  where setting.user_id = new.sender_id;

  if not found then
    select setting.expiration_seconds into configured_seconds
    from public.message_global_settings as setting
    where setting.user_id = new.recipient_id;
  end if;

  if not found then
    select setting.expiration_seconds into configured_seconds
    from public.message_conversation_settings as setting
    where setting.user_a = least(new.sender_id, new.recipient_id)
      and setting.user_b = greatest(new.sender_id, new.recipient_id);
  end if;

  if configured_seconds is null then
    new.expires_at := null;
  else
    new.expires_at := pg_catalog.now() + (configured_seconds * interval '1 second');
  end if;
  return new;
end;
$$;

revoke all on function public.aani_set_global_message_expiration(integer) from public, anon;
revoke all on function public.aani_get_global_message_expiration() from public, anon, authenticated, service_role;
revoke all on function public.aani_apply_message_expiration() from public, anon, authenticated;
grant execute on function public.aani_set_global_message_expiration(integer) to authenticated;
grant execute on function public.aani_get_global_message_expiration() to anon, authenticated, service_role;

commit;
