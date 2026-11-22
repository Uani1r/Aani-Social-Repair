-- Minimal throwaway PostgreSQL schema for the single-message delete RPC test.
-- Used only by CI; it never connects to a Supabase project.

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

create table public.messages (
  id uuid primary key,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null default '',
  created_at timestamptz not null default now(),
  constraint messages_not_self_check check (sender_id <> recipient_id)
);

create table public.message_hides (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.messages enable row level security;
alter table public.message_hides enable row level security;

-- Mimic Supabase's default grants so the migration's REVOKE/GRANT has to win.
revoke all on public.messages, public.message_hides from public, anon, authenticated;
grant select on public.messages to authenticated;
grant select on public.message_hides to authenticated;

create policy messages_select_participant on public.messages
  for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

create policy message_hides_select_own on public.message_hides
  for select to authenticated
  using (user_id = (select auth.uid()));

commit;
