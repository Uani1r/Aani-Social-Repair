-- ============================================================================
-- يثبت سلوك اكتشاف الفهرس المكافئ بعد سيناريو messages_reply_index_scenarios.sql
-- (يُشغَّل في CI على قاعدة عابرة، بعد كل تطبيق للترحيل في هذا السيناريو).
--
-- يفشل إن:
--   * اعتُبر فهرس جزئي بشرط أضيق أو فهرس بعمودين مكافئين، فلم يُنشأ الفهرس
--     الصحيح،
--   * أُنشئ فهرس مكافئ ثانٍ (تكرار) عند إعادة تطبيق الترحيل،
--   * حُذف أي فهرس قائم في السيناريو.
--
-- التكافؤ: عمود مفتاحي واحد هو reply_to_message_id، btree، بلا تعبيرات،
-- والشرط إما غائب (فهرس كامل يغطي كل الصفوف) أو مطابق تماماً للشرط المطلوب.
-- ============================================================================

do $$
declare
  v_reply_attribute smallint;
  v_equivalent_count integer;
  v_index_count integer;
  v_created_predicate text;
  v_wrong_index text;
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

  -- الفهارس المكافئة تماماً للفهرس المطلوب.
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

  -- كل الفهارس التي أول عمود مفتاحي فيها هو العمود، أياً كان شرطها أو عدد أعمدتها.
  select count(*) into v_index_count
  from pg_index as index_row
  join pg_class as table_row on table_row.oid = index_row.indrelid
  join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
  where schema_row.nspname = 'public'
    and table_row.relname = 'messages'
    and index_row.indnkeyatts > 0
    and index_row.indkey[0] = v_reply_attribute;

  raise notice 'سيناريو الفهرس: % فهرس مكافئ، % فهرس إجمالي أوله reply_to_message_id.', v_equivalent_count, v_index_count;

  if v_equivalent_count <> 1 then
    raise exception 'عدد الفهارس المكافئة %، والمتوقع 1: إما أن فهرساً جزئياً بشرط أضيق عُومل كمكافئ، أو أن الفهرس الصحيح لم يُنشأ أو تُرك مكرراً.', v_equivalent_count;
  end if;

  -- فهرس الترحيل + الفهرسان غير المكافئين من السيناريو.
  if v_index_count <> 3 then
    raise exception 'عدد الفهارس على العمود %، والمتوقع 3 (فهرس الترحيل + فهرسان غير مكافئين)، وهذا يكشف فهرساً مكرراً أو محذوفاً.', v_index_count;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
      and indexname = 'aani_messages_reply_to_message_id_idx'
  ) then
    raise exception 'الفهرس الصحيح aani_messages_reply_to_message_id_idx لم يُنشأ رغم غياب أي فهرس مكافئ.';
  end if;

  select regexp_replace(lower(btrim(pg_get_expr(index_row.indpred, index_row.indrelid))), '\s+', ' ', 'g')
  into v_created_predicate
  from pg_index as index_row
  join pg_class as index_relation on index_relation.oid = index_row.indexrelid
  join pg_namespace as schema_row on schema_row.oid = index_relation.relnamespace
  where schema_row.nspname = 'public'
    and index_relation.relname = 'aani_messages_reply_to_message_id_idx';

  if v_created_predicate is null
    or v_created_predicate not in ('(reply_to_message_id is not null)', 'reply_to_message_id is not null') then
    raise exception 'فهرس الترحيل ليس الجزئي المطلوب: %', coalesce(v_created_predicate, 'فهرس كامل');
  end if;

  -- الترحيل لا يحذف أي فهرس قائم.
  foreach v_wrong_index in array array['test_reply_idx_wrong_predicate', 'test_reply_idx_two_columns'] loop
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'messages' and indexname = v_wrong_index
    ) then
      raise exception 'الفهرس غير المكافئ % اختفى؛ الترحيل لا يحذف فهارس قائمة.', v_wrong_index;
    end if;
  end loop;
end $$;
