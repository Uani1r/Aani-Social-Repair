-- Verify the message_reactions RLS, grant, and Realtime security migration on a
-- throwaway CI database. Never runs against a Supabase project.

begin;

-- Seed data as the CI superuser (RLS bypassed for the insert).
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c');

insert into public.messages (id, sender_id, recipient_id, content) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'A to B'),
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c', 'B to C');

-- B's reaction is seeded here so A can attempt to update/delete it below.
insert into public.message_reactions (message_id, user_id, emoji) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000b', '❤️');

-- Schema, policy, privilege, and Realtime assertions (as the superuser).
do $$
declare
  policy_count integer;
  expected record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.message_reactions'::regclass) then
    raise exception 'RLS must be enabled on public.message_reactions';
  end if;

  if not (select relreplident = 'f' from pg_class where oid = 'public.message_reactions'::regclass) then
    raise exception 'public.message_reactions must use REPLICA IDENTITY FULL';
  end if;

  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'message_reactions';
  if policy_count is distinct from 4 then
    raise exception 'Expected exactly 4 policies on message_reactions after re-apply, got %', policy_count;
  end if;

  for expected in
    select * from (values
      ('aani_message_reactions_select_participant', 'SELECT'),
      ('aani_message_reactions_insert_own', 'INSERT'),
      ('aani_message_reactions_update_own', 'UPDATE'),
      ('aani_message_reactions_delete_own', 'DELETE')
    ) as policies(policy_name, command)
  loop
    select count(*) into policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = 'message_reactions'
      and policyname = expected.policy_name
      and cmd = expected.command
      and roles = '{authenticated}'::name[];
    if policy_count is distinct from 1 then
      raise exception 'Policy % must exist exactly once for authenticated (%), found %',
        expected.policy_name, expected.command, policy_count;
    end if;
  end loop;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'message_reactions'
      and policyname in (
        'Users read visible message reactions',
        'Users react as themselves',
        'Users remove own reactions'
      )
  ) then
    raise exception 'Old permissive message_reactions policies must be removed';
  end if;

  for expected in
    select unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege
  loop
    if has_table_privilege('anon', 'public.message_reactions', expected.privilege) then
      raise exception 'anon must not have % on public.message_reactions', expected.privilege;
    end if;
    if not has_table_privilege('authenticated', 'public.message_reactions', expected.privilege) then
      raise exception 'authenticated must have % on public.message_reactions', expected.privilege;
    end if;
  end loop;

  for expected in
    select unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER']) as privilege
  loop
    if has_table_privilege('authenticated', 'public.message_reactions', expected.privilege) then
      raise exception 'authenticated must not have % on public.message_reactions', expected.privilege;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_publication_rel as publication_rel
    join pg_publication as publication on publication.oid = publication_rel.pubid
    where publication.pubname = 'supabase_realtime'
      and publication_rel.relid = 'public.message_reactions'::regclass
  ) then
    raise exception 'public.message_reactions must belong to the supabase_realtime publication';
  end if;
end $$;

-- RLS behavior as the message sender A.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

do $$
declare
  affected integer;
  visible_count integer;
begin
  -- A may insert their own reaction on a message they participate in.
  insert into public.message_reactions (message_id, user_id, emoji)
  values ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', '👍');

  -- Both participants' reactions are visible to A.
  select count(*) into visible_count
  from public.message_reactions
  where message_id = '10000000-0000-0000-0000-0000000000a1';
  if visible_count is distinct from 2 then
    raise exception 'A participant must see every reaction on their message, saw %', visible_count;
  end if;

  -- A may update and delete their own reaction.
  update public.message_reactions
    set emoji = '🔥'
    where message_id = '10000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected is distinct from 1 then
    raise exception 'A user must update their own reaction, affected % rows', affected;
  end if;

  -- Another user's reaction is filtered out by USING, so it is untouched.
  update public.message_reactions
    set emoji = '💔'
    where message_id = '10000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected is distinct from 0 then
    raise exception 'A user must not update another user''s reaction, affected % rows', affected;
  end if;

  delete from public.message_reactions
    where message_id = '10000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected is distinct from 0 then
    raise exception 'A user must not delete another user''s reaction, affected % rows', affected;
  end if;

  -- A user may not write a reaction in someone else's name.
  begin
    insert into public.message_reactions (message_id, user_id, emoji)
    values ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000b', '😢');
    raise exception 'A user must not insert a reaction for another user';
  exception
    when insufficient_privilege then null;
  end;

  -- A user may not react to a conversation they do not participate in.
  begin
    insert into public.message_reactions (message_id, user_id, emoji)
    values ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000a', '👍');
    raise exception 'A non-participant must not react to a message';
  exception
    when insufficient_privilege then null;
  end;

  delete from public.message_reactions
    where message_id = '10000000-0000-0000-0000-0000000000a1'
      and user_id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected is distinct from 1 then
    raise exception 'A user must delete their own reaction, affected % rows', affected;
  end if;

  -- C does not participate in the A/B message and must not read its reactions.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  select count(*) into visible_count
  from public.message_reactions
  where message_id = '10000000-0000-0000-0000-0000000000a1';
  if visible_count is distinct from 0 then
    raise exception 'A non-participant must not read reactions, saw %', visible_count;
  end if;

  begin
    insert into public.message_reactions (message_id, user_id, emoji)
    values ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000c', '👍');
    raise exception 'A non-participant must not insert a reaction';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- Anonymous access is denied for every table privilege.
reset role;
set local role anon;

do $$
declare
  row_count integer;
begin
  begin
    select count(*) into row_count from public.message_reactions;
    raise exception 'anon must not read message_reactions';
  exception
    when insufficient_privilege then null;
  end;
end $$;

rollback;
