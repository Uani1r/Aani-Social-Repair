begin;

grant update (content) on public.messages to authenticated;

drop policy if exists aani_messages_update_own_content on public.messages;
create policy aani_messages_update_own_content on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

commit;
