-- ============================================================================
-- تهيئة سيناريو اختبار اكتشاف الفهرس المكافئ — قاعدة CI المؤقتة فقط.
--
-- هذا الملف جزء من الاختبار وليس من الترحيل: يحذف فهارس الردود الموجودة في
-- قاعدة CI العابرة (لا في أي قاعدة Supabase) ليصنع حالة "لا يوجد فهرس مكافئ"،
-- ثم ينشئ فهرسين غير مكافئين للفهرس المطلوب:
--   1) فهرس جزئي بشرط أضيق (reply_to_message_id IS NOT NULL AND sender_id IS NOT NULL)
--      لا يغطي كل الصفوف المطلوبة.
--   2) فهرس بعمودين مفتاحيين (reply_to_message_id, id) وليس نفس الفهرس.
--
-- الهدف: إثبات أن الترحيل لا يعتبرهما مكافئين، فينشئ الفهرس الصحيح.
-- ============================================================================

drop index if exists aani_messages_reply_to_idx;
drop index if exists aani_messages_reply_to_message_id_idx;
drop index if exists test_reply_idx_wrong_predicate;
drop index if exists test_reply_idx_two_columns;

create index test_reply_idx_wrong_predicate
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null and sender_id is not null;

create index test_reply_idx_two_columns
  on public.messages (reply_to_message_id, id);
