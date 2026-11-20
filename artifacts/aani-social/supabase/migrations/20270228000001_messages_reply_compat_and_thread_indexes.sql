-- ============================================================================
-- الرسائل الفردية: توافق عمود الردود + فهارس الترتيب والدفعات
--
-- 1) توافق الردود:
--    بعض البيئات تحتوي reply_to_id فقط، والترحيل 20261205000000 يضيف
--    reply_to_message_id. هذا الترحيل يضمن وجود reply_to_message_id، ويعبّئه
--    من reply_to_id دون حذف أي قيمة، ويضيف مفتاحاً أجنبياً إن غاب، ويُزامن
--    العمودين في الاتجاهين عبر trigger حتى لا تفقد كتابة أي عميل روابط الردود.
--    لا يُحذف reply_to_id ولا يُعاد تسميته.
--
-- 2) فهرس عمود الردود: لا يُنشأ فهرس مكافئ ثانٍ (انظر الشرح عند موضعه).
--
-- 3) trigger التحقق من هدف الرد على مسار UPDATE يشمل reply_to_id أيضاً،
--    فلا يمكن تجاوز التحقق بتحديث العمود القديم وحده.
--
-- 4) فهارس:
--    aani_messages_thread_created_idx و aani_messages_thread_created_rev_idx
--    لدعم جلب المحادثة الثنائية بترتيب ثابت (created_at, id) في الاتجاهين،
--    ودعم صفحة أحدث الرسائل أولاً.
--
-- 5) التحقق من ترتيب تشغيل الـtriggers على مساري الإدراج والتحديث.
--
-- لا يغيّر: أي عمود آخر، أو سياسة RLS، أو صلاحية، أو دالة قائمة. التغيير
-- الوحيد على trigger قائم هو إعادة إنشاء تحقق UPDATE بقائمة أعمدة أوسع.
-- ============================================================================

begin;

-- 1) توافق عمود الردود.
do $$
declare
  v_has_reply_id boolean;
  v_has_reply_message_id boolean;
  v_conflicts integer;
  v_orphans integer;
  v_cross_conversation integer;
begin
  select exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_id'
      and attnum > 0 and not attisdropped
  ) into v_has_reply_id;

  select exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_message_id'
      and attnum > 0 and not attisdropped
  ) into v_has_reply_message_id;

  -- (أ) تعارض القيمتين: لا نستبدل أي قيمة بصمت. كل الفحوص قبل أي تعديل.
  if v_has_reply_id and v_has_reply_message_id then
    execute $conflicts$
      select count(*)
      from public.messages
      where reply_to_id is not null
        and reply_to_message_id is not null
        and reply_to_id is distinct from reply_to_message_id
    $conflicts$ into v_conflicts;

    if v_conflicts > 0 then
      raise exception 'تعارض في أعمدة الردود: % صفاً يحمل reply_to_id و reply_to_message_id بقيمتين مختلفتين. أوقف الترحيل دون أي تعديل؛ راجع الصفوف يدوياً.', v_conflicts
        using errcode = '23514';
    end if;
  end if;

  -- (ب) روابط يتيمة قبل التعبئة وقبل إضافة المفتاح الأجنبي.
  if v_has_reply_id then
    execute $orphans$
      select count(*)
      from public.messages as message
      where message.reply_to_id is not null
        and not exists (
          select 1 from public.messages as parent where parent.id = message.reply_to_id
        )
    $orphans$ into v_orphans;

    if v_orphans > 0 then
      raise exception 'روابط ردود يتيمة في reply_to_id: % صفاً يشير إلى رسالة غير موجودة. أوقف الترحيل دون أي تعديل.', v_orphans
        using errcode = '23503';
    end if;
  end if;

  if v_has_reply_message_id then
    execute $orphans$
      select count(*)
      from public.messages as message
      where message.reply_to_message_id is not null
        and not exists (
          select 1 from public.messages as parent where parent.id = message.reply_to_message_id
        )
    $orphans$ into v_orphans;

    if v_orphans > 0 then
      raise exception 'روابط ردود يتيمة في reply_to_message_id: % صفاً يشير إلى رسالة غير موجودة. أوقف الترحيل دون أي تعديل.', v_orphans
        using errcode = '23503';
    end if;
  end if;

  -- (ج) ردود قديمة تشير إلى رسالة من محادثة أخرى: التعبئة ستُشغّل trigger
  --     التحقق فيُفشل الترحيل برسالة غامضة. نفحصها الآن ونوقف الترحيل ببيان
  --     واضح قبل أي تعديل، بلا أي كتابة.
  if v_has_reply_id then
    execute $cross$
      select count(*)
      from public.messages as message
      join public.messages as parent on parent.id = message.reply_to_id
      where message.reply_to_id is not null
        and not (
          (parent.sender_id = message.sender_id and parent.recipient_id = message.recipient_id)
          or (parent.sender_id = message.recipient_id and parent.recipient_id = message.sender_id)
        )
    $cross$ into v_cross_conversation;

    if v_cross_conversation > 0 then
      raise exception 'ردود تشير إلى رسالة من محادثة أخرى في reply_to_id: % صفاً. أوقف الترحيل دون أي تعديل؛ صحّح هذه الصفوف يدوياً.', v_cross_conversation
        using errcode = '23503';
    end if;
  end if;

  -- (د) الآن فقط نضيف العمود إن غاب (قيمة reply_to_id تبقى المصدر).
  if not v_has_reply_message_id then
    alter table public.messages
      add column reply_to_message_id uuid;
  end if;

  -- (هـ) تعبئة بلا فقدان: كل صف له reply_to_id ولم يُعبَّأ بعد يأخذ القيمة نفسها.
  if v_has_reply_id then
    execute $fill$
      update public.messages
         set reply_to_message_id = reply_to_id
       where reply_to_message_id is null
         and reply_to_id is not null
    $fill$;
  end if;

  -- مفتاح أجنبي على العمود الجديد إن لم يكن موجوداً (بأي اسم).
  if not exists (
    select 1
    from pg_constraint as constraint_row
    join pg_class as table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = 'messages'
      and constraint_row.contype = 'f'
      and constraint_row.conkey = array[
        (select attnum from pg_attribute
          where attrelid = 'public.messages'::regclass and attname = 'reply_to_message_id')
      ]::smallint[]
  ) then
    alter table public.messages
      add constraint aani_messages_reply_to_message_id_fkey
      foreign key (reply_to_message_id)
      references public.messages (id)
      on delete set null;
  end if;

end $$;

-- 2) فهرس عمود الردود الجديد.
-- الفهرس aani_messages_reply_to_idx (أُنشئ في الترحيل 20261205000000) مبني
-- على العمود نفسه بنفس الشروط: btree على reply_to_message_id حيث ليس null.
-- فإضافة فهرس ثانٍ مكافئ إهدار للكتابة والمساحة. نتحقق من التكافؤ بالأعمدة
-- والشرط وطريقة الفهرسة لا بالاسم، وننشئ الجديد فقط عند غياب أي مكافئ.
do $$
declare
  v_reply_attribute smallint;
  v_equivalent_index text;
begin
  select attnum into v_reply_attribute
  from pg_attribute
  where attrelid = 'public.messages'::regclass
    and attname = 'reply_to_message_id'
    and attnum > 0
    and not attisdropped;

  if v_reply_attribute is null then
    return;
  end if;

  -- أي فهرس btree أول عمود فيه هو reply_to_message_id يخدم نفس الاستعلام،
  -- سواء كان جزئياً على هذا العمود أو عاماً عليه.
  select index_row.relname into v_equivalent_index
  from pg_index as index_row
  join pg_class as table_row on table_row.oid = index_row.indrelid
  join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
  join pg_am as access_method on access_method.oid = index_row.relam
  where schema_row.nspname = 'public'
    and table_row.relname = 'messages'
    and access_method.amname = 'btree'
    and index_row.indnatts > 0
    and index_row.indkey[0] = v_reply_attribute
  limit 1;

  if v_equivalent_index is null then
    create index aani_messages_reply_to_message_id_idx
      on public.messages (reply_to_message_id)
      where reply_to_message_id is not null;
  else
    raise notice 'فهرس مكافئ لعمود الردود موجود مسبقاً (%)؛ لم نُنشئ فهرساً جديداً.', v_equivalent_index;
  end if;
end $$;

-- 3) مزامنة العمودين إن وُجد reply_to_id، حتى تعمل كتابة أي عميل.
do $$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_id'
      and attnum > 0 and not attisdropped
  ) then
    create or replace function public.aani_sync_message_reply_ids()
    returns trigger
    language plpgsql
    set search_path = ''
    as $sync$
    begin
      if tg_op = 'INSERT' then
        if new.reply_to_message_id is null and new.reply_to_id is not null then
          new.reply_to_message_id := new.reply_to_id;
        elsif new.reply_to_message_id is not null then
          new.reply_to_id := new.reply_to_message_id;
        end if;
      elsif tg_op = 'UPDATE' then
        if new.reply_to_message_id is distinct from old.reply_to_message_id then
          new.reply_to_id := new.reply_to_message_id;
        elsif new.reply_to_id is distinct from old.reply_to_id then
          new.reply_to_message_id := new.reply_to_id;
        end if;
      end if;

      return new;
    end;
    $sync$;

    drop trigger if exists aani_sync_message_reply_ids on public.messages;
    create trigger aani_sync_message_reply_ids
      before insert or update of reply_to_message_id, reply_to_id on public.messages
      for each row execute function public.aani_sync_message_reply_ids();
  end if;
end $$;

-- 4) التحقق من هدف الرد يجب أن يعمل على مسار التحديث عند تغيير reply_to_id
--    وحده أيضاً. في الترحيل 20261205000000 كان trigger التحديث مقصوراً على
--    reply_to_message_id وsender_id وrecipient_id، فتحديث reply_to_id وحده
--    يُزامَن عبر aani_sync… لكنه لا يُتحقق منه، فيمكن ربط رد برسالة من
--    محادثة أخرى. نعيد إنشاء الـtrigger بقائمة الأعمدة الكاملة.
--    الترتيب يبقى صحيحاً: aani_sync… يسبق aani_validate… أبجدياً.
do $$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_id'
      and attnum > 0 and not attisdropped
  ) and exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname = 'aani_validate_message_reply_target_update'
      and not tgisinternal
  ) and exists (
    select 1 from pg_proc
    where proname = 'aani_validate_message_reply_target'
      and pronamespace = 'public'::regnamespace
  ) then
    drop trigger aani_validate_message_reply_target_update on public.messages;
    create trigger aani_validate_message_reply_target_update
      before update of reply_to_id, reply_to_message_id, sender_id, recipient_id on public.messages
      for each row execute function public.aani_validate_message_reply_target();
  end if;
end $$;

-- 5) فهارس المحادثة الثنائية بترتيب ثابت.
create index if not exists aani_messages_thread_created_idx
  on public.messages (sender_id, recipient_id, created_at desc, id desc);

create index if not exists aani_messages_thread_created_rev_idx
  on public.messages (recipient_id, sender_id, created_at desc, id desc);

-- 6) ترتيب تشغيل الـtriggers: المزامنة تقرأ/تكتب العمودين قبل تحقق هدف الرد.
--    أسماء BEFORE ROW triggers تُنفَّذ أبجدياً، فيجب أن يسبق aani_sync…
--    كلاً من aani_validate…_insert (مسار الإدراج) وaani_validate…_update
--    (مسار التحديث) معاً، لا مسار الإدراج وحده.
do $$
declare
  v_sync_trigger text := 'aani_sync_message_reply_ids';
  v_insert_trigger text := 'aani_validate_message_reply_target_insert';
  v_update_trigger text := 'aani_validate_message_reply_target_update';
  v_has_sync boolean;
  v_has_insert boolean;
  v_has_update boolean;
begin
  select exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = v_sync_trigger and not tgisinternal
  ) into v_has_sync;

  select exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = v_insert_trigger and not tgisinternal
  ) into v_has_insert;

  select exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = v_update_trigger and not tgisinternal
  ) into v_has_update;

  -- بيئة بلا ردود قديمة: لا trigger مزامنة ولا ترتيب نتحقق منه.
  if not v_has_sync then
    return;
  end if;

  if v_has_insert and v_sync_trigger > v_insert_trigger then
    raise exception 'ترتيب triggers خاطئ في مسار INSERT: يجب أن يُنفَّذ % قبل %، لكن اسمه يأتي بعده أبجدياً.', v_sync_trigger, v_insert_trigger
      using errcode = '55000';
  end if;

  if v_has_update and v_sync_trigger > v_update_trigger then
    raise exception 'ترتيب triggers خاطئ في مسار UPDATE: يجب أن يُنفَّذ % قبل %، لكن اسمه يأتي بعده أبجدياً.', v_sync_trigger, v_update_trigger
      using errcode = '55000';
  end if;
end $$;

commit;
