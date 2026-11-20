-- Minimal throwaway PostgreSQL schema for the individual-message inbox RPC.
-- This harness is used only by CI and never connects to a Supabase project.

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

create schema auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (
  id uuid primary key
);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (blocker_id, blocked_user_id)
);

create or replace function public.aani_is_user_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and auth.uid() in (p_user_a, p_user_b)
    and exists (
      select 1
      from public.user_blocks as blocked
      where (blocked.blocker_id = p_user_a and blocked.blocked_user_id = p_user_b)
         or (blocked.blocker_id = p_user_b and blocked.blocked_user_id = p_user_a)
    ),
    false
  );
$$;
revoke all on function public.aani_is_user_blocked(uuid, uuid) from public, anon;
grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated;

create table public.messages (
  id uuid primary key,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null,
  created_at timestamptz not null,
  delivered_at timestamptz,
  read_at timestamptz,
  constraint messages_not_self_check check (sender_id <> recipient_id)
);

create index aani_messages_thread_created_idx
  on public.messages (sender_id, recipient_id, created_at desc, id desc);
create index aani_messages_thread_created_rev_idx
  on public.messages (recipient_id, sender_id, created_at desc, id desc);

create table public.message_hides (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.messages enable row level security;
alter table public.message_hides enable row level security;
revoke all on public.messages, public.message_hides from public, anon, authenticated;
grant select on public.messages, public.message_hides to authenticated;

create policy messages_select_participant on public.messages
  for select to authenticated
  using (
    (sender_id = auth.uid() or recipient_id = auth.uid())
    and not public.aani_is_user_blocked(auth.uid(), case when sender_id = auth.uid() then recipient_id else sender_id end)
  );
create policy message_hides_select_own on public.message_hides
  for select to authenticated
  using (user_id = auth.uid());

commit;
