-- Minimal throwaway PostgreSQL schema for the message_reactions security
-- migration test. Used only by CI; it never connects to a Supabase project.

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
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;
create policy messages_select_participant on public.messages
  for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- Mimic Supabase's default grants so the migration's REVOKE/GRANT has to win.
grant all on public.messages to anon, authenticated;
grant all on public.message_reactions to anon, authenticated;
revoke all on public.messages from anon;
grant select on public.messages to authenticated;

-- Old permissive policies that the production fix replaced.
create policy "Users read visible message reactions" on public.message_reactions
  for select to authenticated using (true);
create policy "Users react as themselves" on public.message_reactions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove own reactions" on public.message_reactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- The Realtime publication the migration must join.
create publication supabase_realtime;

commit;
