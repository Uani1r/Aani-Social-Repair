-- ============================================================================
-- تحقق ثابت من نتيجة ترحيل توافق الردود (يُشغَّل بعد تطبيقه في CI).
--
-- يفشل إن:
--   * وُجد أكثر من فهرس واحد مكافئ لعمود الردود، أو لم يوجد أي فهرس مكافئ،
--   * لم يُوسَّع trigger التحقق على مسار UPDATE ليشمل reply_to_id،
--   * غاب trigger المزامنة أو فهرسا المحادثة الثنائية.
--
-- التكافؤ هنا يُقارَن بتعريف الفهرس كاملاً (عمود مفتاحي واحد، btree، بلا
-- تعبيرات، وشرط جزئي مطابق)، لا بمجرد العمود وطريقة الفهرسة.
-- ============================================================================

do $$
declare
  v_reply_attribute smallint;
  v_equivalent_count integer;
  v_validator_oid oid;
  v_validator_security_definer boolean;
  v_validator_config text[];
  v_insert_trigger_def text;
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

  if v_equivalent_count <> 1 then
    raise exception 'عدد فهارس الردود المكافئة %، والمتوقع 1 (لا فهرس مكرر).', v_equivalent_count;
  end if;

  select procedure_row.oid, procedure_row.prosecdef, procedure_row.proconfig
    into v_validator_oid, v_validator_security_definer, v_validator_config
  from pg_proc as procedure_row
  join pg_namespace as schema_row on schema_row.oid = procedure_row.pronamespace
  where schema_row.nspname = 'public'
    and procedure_row.proname = 'aani_validate_message_reply_target'
    and procedure_row.prokind = 'f'
    and procedure_row.pronargs = 0;

  if v_validator_oid is null then
    raise exception 'دالة التحقق public.aani_validate_message_reply_target() غير موجودة.';
  end if;

  if exists (
    select 1
    from pg_proc as procedure_row
    cross join lateral aclexplode(coalesce(
      procedure_row.proacl,
      acldefault('f', procedure_row.proowner)
    )) as function_acl
    where procedure_row.oid = v_validator_oid
      and function_acl.grantee = 0
      and function_acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'ما زال PUBLIC يملك EXECUTE على دالة التحقق.';
  end if;

  if exists (
    select 1
    from pg_proc as procedure_row
    cross join lateral aclexplode(coalesce(
      procedure_row.proacl,
      acldefault('f', procedure_row.proowner)
    )) as function_acl
    where procedure_row.oid = v_validator_oid
      and function_acl.grantee in (
        select role_row.oid from pg_roles as role_row
        where role_row.rolname in ('anon', 'authenticated')
      )
      and function_acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'ما زال anon أو authenticated يملك EXECUTE مباشراً على دالة التحقق.';
  end if;

  if has_function_privilege('anon', v_validator_oid, 'EXECUTE') then
    raise exception 'ما زال anon يملك EXECUTE فعلياً على دالة التحقق.';
  end if;

  if has_function_privilege('authenticated', v_validator_oid, 'EXECUTE') then
    raise exception 'ما زال authenticated يملك EXECUTE فعلياً على دالة التحقق.';
  end if;

  if not v_validator_security_definer then
    raise exception 'دالة التحقق لا تعمل بصفة SECURITY DEFINER.';
  end if;

  if not ('search_path=""' = any(coalesce(v_validator_config, array[]::text[]))) then
    raise exception 'دالة التحقق لا تضبط SET search_path = ''.';
  end if;

  select pg_get_triggerdef(trigger_row.oid) into v_insert_trigger_def
  from pg_trigger as trigger_row
  where trigger_row.tgrelid = 'public.messages'::regclass
    and trigger_row.tgname = 'aani_validate_message_reply_target_insert'
    and not trigger_row.tgisinternal;

  if v_insert_trigger_def is null then
    raise exception 'trigger التحقق من هدف الرد على مسار INSERT غير موجود.';
  end if;

  if position('INSERT' in v_insert_trigger_def) = 0
    or position('aani_validate_message_reply_target()' in v_insert_trigger_def) = 0 then
    raise exception 'تعريف trigger التحقق على مسار INSERT غير صحيح: %', v_insert_trigger_def;
  end if;

  select pg_get_triggerdef(trigger_row.oid) into v_update_trigger_def
  from pg_trigger as trigger_row
  where trigger_row.tgrelid = 'public.messages'::regclass
    and trigger_row.tgname = 'aani_validate_message_reply_target_update'
    and not trigger_row.tgisinternal;

  if v_update_trigger_def is null then
    raise exception 'trigger التحقق من هدف الرد على مسار UPDATE غير موجود.';
  end if;

  if position('UPDATE' in v_update_trigger_def) = 0
    or position('reply_to_message_id' in v_update_trigger_def) = 0
    or position('sender_id' in v_update_trigger_def) = 0
    or position('recipient_id' in v_update_trigger_def) = 0
    or position('aani_validate_message_reply_target()' in v_update_trigger_def) = 0 then
    raise exception 'تعريف trigger التحقق على مسار UPDATE غير صحيح: %', v_update_trigger_def;
  end if;

  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_id'
      and attnum > 0 and not attisdropped
  ) and position('reply_to_id' in v_update_trigger_def) = 0 then
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
