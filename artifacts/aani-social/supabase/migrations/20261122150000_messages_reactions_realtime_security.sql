-- Documented copy of the message_reactions RLS, grant, and Realtime fix that
-- was already applied to Supabase production. This file exists so the fix is
-- reviewable and re-testable; CI applies it only to a throwaway PostgreSQL.
--
-- The statement order and policy bodies match the production fix: participant-
-- scoped reads, self-only writes that also require conversation participation,
-- table grants limited to authenticated, REPLICA IDENTITY FULL for Realtime
-- delete/update payloads, and membership in supabase_realtime.
--
-- Idempotent: every policy is dropped before it is created, grants are
-- re-applied, and adding the table to the publication tolerates an existing
-- membership.

begin;

alter table public.message_reactions enable row level security;

-- Old permissive policies.
drop policy if exists "Users read visible message reactions" on public.message_reactions;
drop policy if exists "Users react as themselves" on public.message_reactions;
drop policy if exists "Users remove own reactions" on public.message_reactions;

-- Re-apply the participant/self policies from a clean slate.
drop policy if exists aani_message_reactions_select_participant on public.message_reactions;
drop policy if exists aani_message_reactions_insert_own on public.message_reactions;
drop policy if exists aani_message_reactions_update_own on public.message_reactions;
drop policy if exists aani_message_reactions_delete_own on public.message_reactions;

create policy aani_message_reactions_select_participant on public.message_reactions
  for select to authenticated using (
    exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );

create policy aani_message_reactions_insert_own on public.message_reactions
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );

create policy aani_message_reactions_update_own on public.message_reactions
  for update to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  ) with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );

create policy aani_message_reactions_delete_own on public.message_reactions
  for delete to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );

-- Table privileges: authenticated only, and only the four DML privileges.
revoke all on table public.message_reactions from public;
revoke all on table public.message_reactions from anon;
revoke all on table public.message_reactions from authenticated;
grant select, insert, update, delete on table public.message_reactions to authenticated;

-- Realtime needs the full row for update/delete payloads and RLS checks.
alter table public.message_reactions replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.message_reactions;
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

commit;
