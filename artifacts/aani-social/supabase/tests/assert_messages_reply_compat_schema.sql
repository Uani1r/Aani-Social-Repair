-- ============================================================================
-- تحقق ثابت من نتيجة ترحيل توافق الردود (يُشغَّل بعد تطبيقه في CI).
--
-- يفشل إن:
--   * أُنشئ فهرس ثانٍ مكافئ على reply_to_message_id (تكرار aani_messages_reply_to_idx)،
--   * لم يُوسَّع trigger التحقق على مسار UPDATE ليشمل reply_to_id،
--   * غاب trigger المزامنة أو فهرسا المحادثة الثنائية.
-- ============================================================================

do $$
declare
  v_reply_attribute smallint;
  v_equivalent_count integer;
  v_update_trigger_def text;
begin
  select attnum into v_reply_attribute
  from pg_attribute
  where attrelid = 'public.messages'::regclass
    and attname = 'reply_to_message_id'
    and attnum > 0
    and not attisdropped;

  if v_reply_attribute is null then
    raise exception 'العمود reply_to_message_id غير موجود بعد الترحيل.';
  end if;

  select count(*) into v_equivalent_count
  from pg_index as index_row
  join pg_class as table_row on table_row.oid = index_row.indrelid
  join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
  join pg_am as access_method on access_method.oid = index_row.relam
  where schema_row.nspname = 'public'
    and table_row.relname = 'messages'
    and access_method.amname = 'btree'
    and index_row.indnatts > 0
    and index_row.indkey[0] = v_reply_attribute;

  if v_equivalent_count <> 1 then
    raise exception 'عدد فهارس الردود المكافئة %، والمتوقع 1 (لا فهرس مكرر).', v_equivalent_count;
  end if;

  select pg_get_triggerdef(trigger_row.oid) into v_update_trigger_def
  from pg_trigger as trigger_row
  where trigger_row.tgrelid = 'public.messages'::regclass
    and trigger_row.tgname = 'aani_validate_message_reply_target_update'
    and not trigger_row.tgisinternal;

  if v_update_trigger_def is null then
    raise exception 'trigger التحقق من هدف الرد على مسار UPDATE غير موجود.';
  end if;

  if position('reply_to_id' in v_update_trigger_def) = 0 then
    raise exception 'trigger التحقق على مسار UPDATE لا يراقب reply_to_id: %', v_update_trigger_def;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname = 'aani_sync_message_reply_ids'
      and not tgisinternal
  ) then
    raise exception 'trigger مزامنة عمودي الردود غير موجود.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
      and indexname = 'aani_messages_thread_created_idx'
  ) or not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
      and indexname = 'aani_messages_thread_created_rev_idx'
  ) then
    raise exception 'فهرسا المحادثة الثنائية غير موجودين.';
  end if;
end $$;
