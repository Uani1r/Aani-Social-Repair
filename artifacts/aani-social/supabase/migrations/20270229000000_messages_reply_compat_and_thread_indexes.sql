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
-- 2) فهارس:
--    aani_messages_thread_created_idx و aani_messages_thread_created_rev_idx
--    لدعم جلب المحادثة الثنائية بترتيب ثابت (created_at, id) في الاتجاهين،
--    ودعم صفحة أحدث الرسائل أولاً.
--
-- لا يغيّر: أي عمود آخر، أو سياسة RLS، أو صلاحية، أو دالة، أو trigger قائم.
-- ============================================================================

begin;

-- 1) توافق عمود الردود.
do $$
declare
  v_has_reply_id boolean;
  v_has_reply_message_id boolean;
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

  if not v_has_reply_message_id then
    alter table public.messages
      add column reply_to_message_id uuid;
  end if;

  -- تعبئة بلا فقدان: كل صف له reply_to_id ولم يُعبَّأ بعد يأخذ القيمة نفسها.
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

create index if not exists aani_messages_reply_to_message_id_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

-- 2) مزامنة العمودين إن وُجد reply_to_id، حتى تعمل كتابة أي عميل.
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

-- 3) فهارس المحادثة الثنائية بترتيب ثابت.
create index if not exists aani_messages_thread_created_idx
  on public.messages (sender_id, recipient_id, created_at desc, id desc);

create index if not exists aani_messages_thread_created_rev_idx
  on public.messages (recipient_id, sender_id, created_at desc, id desc);

commit;
