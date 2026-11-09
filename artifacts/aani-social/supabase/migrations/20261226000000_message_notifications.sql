-- Create a notification row for each new direct message so the recipient can
-- receive it through Supabase Realtime and open the sender's conversation.
begin;

create or replace function public.aani_notify_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_id is null
    or new.recipient_id is null
    or new.sender_id = new.recipient_id
    or new.content like '[aani-call:v1]%'
    or exists (
      select 1
      from public.profiles as recipient
      where recipient.id = new.recipient_id
        and recipient.notification_settings->'messages' = 'false'::jsonb
    ) then
    return new;
  end if;

  insert into public.notifications (user_id, actor_id, type, content, reference_id)
  values (new.recipient_id, new.sender_id, 'message', 'أرسل لك رسالة', new.id);

  return new;
end;
$$;

revoke all on function public.aani_notify_on_message_insert() from public, anon, authenticated;

drop trigger if exists aani_message_notification_after_insert on public.messages;
create trigger aani_message_notification_after_insert
after insert on public.messages
for each row execute function public.aani_notify_on_message_insert();

commit;
