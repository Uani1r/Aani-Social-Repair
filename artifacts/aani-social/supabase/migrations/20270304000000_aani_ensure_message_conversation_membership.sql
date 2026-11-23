-- Ensures a durable conversation-membership row exists before the client joins
-- the private conversation Broadcast topic.
--
-- Why: the membership table is written by a trigger on messages INSERT and by a
-- backfill. A conversation opened before its first message therefore has no
-- membership row, so joining its private topic is rejected (Unauthorized) and
-- typing indicators never flow. This function lets a participant materialise
-- the row first, using exactly the rule the messages INSERT policy already
-- enforces: the caller is the sender, the two users differ, and neither has
-- blocked the other. It grants nothing beyond that: it does not insert messages,
-- does not touch RLS or Realtime policies, and does not widen who may join.
--
-- Idempotent: the pair is stored once, ordered as (least, greatest), and a
-- repeated call is a no-op.
--
-- Applying this migration to the hosted project requires review and separate
-- approval; it is not applied by this repository.

begin;

do $$
begin
  if to_regclass('public.aani_message_conversation_members') is null then
    raise exception 'public.aani_message_conversation_members is missing. Apply 20270302000000 first.'
      using errcode = '42P01';
  end if;
  if to_regprocedure('public.aani_is_user_blocked(uuid, uuid)') is null then
    raise exception 'public.aani_is_user_blocked(uuid, uuid) is missing.'
      using errcode = '42883';
  end if;
end $$;

create or replace function public.aani_ensure_message_conversation_member(p_other_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  member_low uuid;
  member_high uuid;
begin
  -- The caller must be an authenticated participant other than the target.
  if caller_id is null or p_other_user_id is null or p_other_user_id = caller_id then
    return false;
  end if;

  -- The target must be a real profile.
  if not exists (
    select 1 from public.profiles as profile where profile.id = p_other_user_id
  ) then
    return false;
  end if;

  -- Same block rule as the messages INSERT policy: no membership for a blocked pair.
  if public.aani_is_user_blocked(caller_id, p_other_user_id) then
    return false;
  end if;

  member_low := least(caller_id, p_other_user_id);
  member_high := greatest(caller_id, p_other_user_id);

  insert into public.aani_message_conversation_members (user_a, user_b)
  values (member_low, member_high)
  on conflict (user_a, user_b) do nothing;

  return true;
end;
$$;

revoke all on function public.aani_ensure_message_conversation_member(uuid) from public, anon;
grant execute on function public.aani_ensure_message_conversation_member(uuid) to authenticated;

commit;
