-- ============================================================================
-- يثبت أن الفهرس الكامل (بلا شرط جزئي) على reply_to_message_id يُعد مكافئاً:
-- يغطي كل الصفوف، فلا ينشئ الترحيل فهرساً ثانياً.
-- يُشغَّل بعد messages_reply_index_full_scenario.sql، في CI على قاعدة عابرة.
-- ============================================================================

do $$
declare
  v_reply_attribute smallint;
  v_equivalent_count integer;
  v_index_count integer;
  v_predicate text;
begin
  select attnum into v_reply_attribute
  from pg_attribute
  where attrelid = 'public.messages'::regclass
    and attname = 'reply_to_message_id'
    and attnum > 0
    and not attisdropped;

  if v_reply_attribute is null then
    raise exception 'العمود reply_to_message_id غير موجود.';
  end if;

  -- الفهارس المكافئة تماماً (عمود مفتاحي واحد، btree، بلا تعبيرات، وشرط غائب
  -- أو مطابق للمطلوب).
  select count(*) into v_equivalent_count
  from pg_index as index_row
  join pg_class as table_row on table_row.oid = index_row.indrelid
  join pg_class as index_relation on index_relation.oid = index_row.indexrelid
  join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
  join pg_am as access_method on access_method.oid = index_relation.relam
  where schema_row.nspname = 'public'
    and table_row.relname = 'messages'
    and index_row.indisvalid
    and access_method.amname = 'btree'
    and index_row.indnkeyatts = 1
    and index_row.indkey[0] = v_reply_attribute
    and index_row.indexprs is null
    and (
      index_row.indpred is null
      or regexp_replace(lower(btrim(pg_get_expr(index_row.indpred, index_row.indrelid))), '\s+', ' ', 'g')
        in ('(reply_to_message_id is not null)', 'reply_to_message_id is not null')
    );

  select count(*) into v_index_count
  from pg_index as index_row
  join pg_class as table_row on table_row.oid = index_row.indrelid
  join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
  where schema_row.nspname = 'public'
    and table_row.relname = 'messages'
    and index_row.indnkeyatts > 0
    and index_row.indkey[0] = v_reply_attribute;

  raise notice 'سيناريو الفهرس الكامل: % فهرس مكافئ، % فهرس إجمالي على العمود.', v_equivalent_count, v_index_count;

  if v_equivalent_count <> 1 then
    raise exception 'عدد الفهارس المكافئة %، والمتوقع 1: الفهرس الكامل يجب أن يُعد مكافئاً فلا يُنشأ ثانٍ.', v_equivalent_count;
  end if;

  -- الفهرس الكامل وحده، دون أي فهرس إضافي من الترحيل.
  if v_index_count <> 1 then
    raise exception 'عدد الفهارس على العمود %، والمتوقع 1 (الفهرس الكامل فقط): أنشأ الترحيل فهرساً مكرراً.', v_index_count;
  end if;

  if exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
      and indexname = 'aani_messages_reply_to_message_id_idx'
  ) then
    raise exception 'أنشأ الترحيل aani_messages_reply_to_message_id_idx رغم وجود فهرس كامل يغطي كل الصفوف.';
  end if;

  select pg_get_expr(index_row.indpred, index_row.indrelid)
  into v_predicate
  from pg_index as index_row
  join pg_class as index_relation on index_relation.oid = index_row.indexrelid
  join pg_namespace as schema_row on schema_row.oid = index_relation.relnamespace
  where schema_row.nspname = 'public'
    and index_relation.relname = 'test_reply_idx_full';

  if v_predicate is not null then
    raise exception 'الفهرس الكامل في السيناريو صار جزئياً: %', v_predicate;
  end if;
end $$;
