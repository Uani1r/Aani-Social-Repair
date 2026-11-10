-- الرسائل والمكالمات الفائتة (بما فيها missed_call) ممنوعة من جدول الإشعارات
-- العامة نهائياً: إشعارها الخارجي FCM يُرسل عبر Webhook جدول messages فقط،
-- والمكالمات تُدار عبر Realtime. هذا الترحيل:
--   1) يوقف تريغر إشعارات الرسائل (إن لم يُطبَّق 20261228 بعد).
--   2) يحذف سجلات هذه الأنواع من public.notifications.
--   3) يضيف تريغر حماية BEFORE INSERT يمنع كتابة هذه الأنواع مستقبلاً.
begin;

drop trigger if exists aani_message_notification_after_insert on public.messages;
drop function if exists public.aani_notify_on_message_insert();

delete from public.notifications
where lower(type) in ('message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call');

create or replace function public.aani_block_message_call_notifications()
returns trigger
language plpgsql
as $$
begin
  -- منع كتابة الرسائل والمكالمات في جدول الإشعارات العامة
  if lower(new.type) in ('message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call') then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_block_message_call_notifications on public.notifications;
create trigger aani_block_message_call_notifications
before insert on public.notifications
for each row execute function public.aani_block_message_call_notifications();

notify pgrst, 'reload schema';

commit;
