-- ============================================================================
-- اختبار توافق عمودي الردود (لا يُشغَّل تلقائياً في CI؛ يُطبَّق على قاعدة اختبار)
--
-- يتحقق من:
--   1) لا تعارض بين reply_to_id و reply_to_message_id في البيانات الحالية.
--   2) لا روابط ردود يتيمة في أي من العمودين.
--   3) مزامنة الاتجاهين تعمل عند INSERT ثم UPDATE، ثم يُلغى كل شيء (rollback).
-- ============================================================================

begin;

do $$
declare
  v_conflicts integer;
  v_orphans integer;
begin
  select count(*) into v_conflicts
  from public.messages
  where reply_to_id is not null
    and reply_to_message_id is not null
    and reply_to_id is distinct from reply_to_message_id;

  if v_conflicts > 0 then
    raise exception 'اختبار الردود: % صفاً بقيمتين متعارضتين.', v_conflicts;
  end if;

  select count(*) into v_orphans
  from public.messages as message
  where message.reply_to_id is not null
    and not exists (select 1 from public.messages as parent where parent.id = message.reply_to_id);

  if v_orphans > 0 then
    raise exception 'اختبار الردود: % رابط يتيم في reply_to_id.', v_orphans;
  end if;

  select count(*) into v_orphans
  from public.messages as message
  where message.reply_to_message_id is not null
    and not exists (select 1 from public.messages as parent where parent.id = message.reply_to_message_id);

  if v_orphans > 0 then
    raise exception 'اختبار الردود: % رابط يتيم في reply_to_message_id.', v_orphans;
  end if;
end $$;

-- اختبار مزامنة INSERT: الكتابة في أحد العمودين تملأ الآخر.
do $$
declare
  v_sender uuid;
  v_recipient uuid;
  v_parent uuid;
  v_child uuid;
  v_reply_id uuid;
  v_reply_message_id uuid;
begin
  select sender_id, recipient_id into v_sender, v_recipient
  from public.messages order by created_at limit 1;

  if v_sender is null then
    raise notice 'اختبار الردود: لا رسائل لاختبار المزامنة.';
    return;
  end if;

  insert into public.messages (sender_id, recipient_id, content)
  values (v_sender, v_recipient, '[test] parent')
  returning id into v_parent;

  insert into public.messages (sender_id, recipient_id, content, reply_to_id)
  values (v_sender, v_recipient, '[test] child via reply_to_id', v_parent)
  returning id, reply_to_message_id into v_child, v_reply_message_id;

  if v_reply_message_id is distinct from v_parent then
    raise exception 'اختبار الردود: INSERT من reply_to_id لم يملأ reply_to_message_id.';
  end if;

  update public.messages set reply_to_message_id = null, reply_to_id = v_parent where id = v_child
  returning reply_to_id, reply_to_message_id into v_reply_id, v_reply_message_id;

  if v_reply_message_id is distinct from v_parent then
    raise exception 'اختبار الردود: UPDATE لم يعد مزامنة العمودين.';
  end if;

  raise notice 'اختبار الردود: نجح فحص التعارض واليتيم ومزامنة INSERT/UPDATE.';
end $$;

rollback;
