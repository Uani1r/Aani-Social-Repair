-- ============================================================================
-- تهيئة سيناريو "الفهرس الكامل" — قاعدة CI المؤقتة فقط.
--
-- هذا الملف جزء من الاختبار وليس من الترحيل: يحذف فهارس الردود في قاعدة CI
-- العابرة (لا في أي قاعدة Supabase) ثم ينشئ فهرساً كاملاً (بلا شرط جزئي) على
-- العمود نفسه. الفهرس الكامل يغطي كل الصفوف، ومنها كل الصفوف التي يشترطها
-- الفهرس الجزئي المطلوب، فيجب أن يُعد مكافئاً ولا يُنشئ الترحيل فهرساً ثانياً.
-- ============================================================================

drop index if exists aani_messages_reply_to_idx;
drop index if exists aani_messages_reply_to_message_id_idx;
drop index if exists test_reply_idx_wrong_predicate;
drop index if exists test_reply_idx_two_columns;
drop index if exists test_reply_idx_full;

create index test_reply_idx_full
  on public.messages (reply_to_message_id);
