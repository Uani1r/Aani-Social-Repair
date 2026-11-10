-- الرسائل والمكالمات الواردة لم تعد تنشئ سجلات في جدول الإشعارات العامة.
-- تحديث تبويب الرسائل والمحادثات يتم عبر اشتراكات Realtime على جدول messages
-- (كما هو في MessagesPage)، والإشعار الفوري FCM يُرسل عبر Webhook جدول messages
-- إلى POST /api/webhook/push في خادم api-server.
begin;

-- إيقاف التريغر الذي كان يضيف إشعار "رسالة جديدة" إلى public.notifications
drop trigger if exists aani_message_notification_after_insert on public.messages;
drop function if exists public.aani_notify_on_message_insert();

-- تنظيف الإشعارات القديمة الخاصة بالرسائل والمكالمات من القائمة العامة
-- (احذف هذا السطر إن أردت الاحتفاظ بسجل الإشعارات القديمة)
delete from public.notifications where type in ('message', 'call', 'incoming_call');

notify pgrst, 'reload schema';

commit;
