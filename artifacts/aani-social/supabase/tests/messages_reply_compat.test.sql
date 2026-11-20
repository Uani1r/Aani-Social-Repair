-- ============================================================================
-- اختبار توافق عمودي الردود (يُطبَّق على قاعدة اختبار أو على مخطط CI المصغّر)
--
-- يتحقق من:
--   1) لا تعارض بين reply_to_id و reply_to_message_id في البيانات الحالية.
--   2) لا روابط ردود يتيمة في أي من العمودين.
--   3) مزامنة الاتجاهين في INSERT وUPDATE: كل حالة تلمس عموداً واحداً فقط
--      وتتحقق من تعبئة العمود الآخر.
--   4) رفض ربط رد برسالة من محادثة أخرى عند تحديث reply_to_id وحده، وعند
--      تحديث reply_to_message_id وحده (هذا ما يثبت أن trigger التحقق يعمل
--      على مساري التحديث معاً).
--   5) استمرار قبول الردود الصحيحة، وأن التعارض الصريح يُحسم للعمود الجديد.
-- ثم يُلغى كل شيء (rollback).
--
-- يتطلب وجود العمود القديم reply_to_id (بيئة التوافق) وtrigger المزامنة
-- aani_sync_message_reply_ids، ويتوقف برسالة واضحة إن غاب أحدهما.
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

-- مزامنة الاتجاهين والتحقق: كل حالة تلمس عموداً واحداً فقط.
do $$
declare
  v_sender uuid;
  v_recipient uuid;
  v_parent_one uuid;
  v_parent_two uuid;
  v_foreign_parent uuid;
  v_child_via_legacy uuid;
  v_child_via_new uuid;
  v_child_with_both uuid;
  v_legacy_reply uuid;
  v_new_reply uuid;
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.messages'::regclass
      and attname = 'reply_to_id'
      and attnum > 0 and not attisdropped
  ) then
    raise exception 'اختبار الردود: العمود reply_to_id غير موجود؛ هذا الاختبار لبيئة التوافق فقط.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname = 'aani_sync_message_reply_ids'
      and not tgisinternal
  ) then
    raise exception 'اختبار الردود: trigger المزامنة aani_sync_message_reply_ids غير موجود.';
  end if;

  select sender_id, recipient_id into v_sender, v_recipient
  from public.messages order by created_at limit 1;

  if v_sender is null then
    raise notice 'اختبار الردود: لا رسائل لاختبار المزامنة.';
    return;
  end if;

  -- رسالتان صالحتان للرد داخل المحادثة نفسها.
  insert into public.messages (sender_id, recipient_id, content)
  values (v_sender, v_recipient, '[test] parent 1')
  returning id into v_parent_one;

  insert into public.messages (sender_id, recipient_id, content)
  values (v_sender, v_recipient, '[test] parent 2')
  returning id into v_parent_two;

  -- الحالة أ: INSERT يكتب reply_to_id فقط.
  insert into public.messages (sender_id, recipient_id, content, reply_to_id)
  values (v_sender, v_recipient, '[test] child via reply_to_id', v_parent_one)
  returning id, reply_to_message_id into v_child_via_legacy, v_new_reply;

  if v_new_reply is distinct from v_parent_one then
    raise exception 'اختبار الردود (أ): INSERT بـ reply_to_id فقط لم يملأ reply_to_message_id.';
  end if;

  -- الحالة ب: INSERT يكتب reply_to_message_id فقط.
  insert into public.messages (sender_id, recipient_id, content, reply_to_message_id)
  values (v_sender, v_recipient, '[test] child via reply_to_message_id', v_parent_one)
  returning id, reply_to_id into v_child_via_new, v_legacy_reply;

  if v_legacy_reply is distinct from v_parent_one then
    raise exception 'اختبار الردود (ب): INSERT بـ reply_to_message_id فقط لم يملأ reply_to_id.';
  end if;

  -- الحالة ج: UPDATE يغيّر reply_to_id فقط (دون ذكر reply_to_message_id إطلاقاً).
  update public.messages
     set reply_to_id = v_parent_two
   where id = v_child_via_legacy
  returning reply_to_id, reply_to_message_id into v_legacy_reply, v_new_reply;

  if v_legacy_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (ج): UPDATE لم يثبّت reply_to_id على القيمة المطلوبة.';
  end if;

  if v_new_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (ج): UPDATE بـ reply_to_id فقط لم يحدّث reply_to_message_id.';
  end if;

  -- الحالة د: UPDATE يغيّر reply_to_message_id فقط (دون ذكر reply_to_id إطلاقاً).
  update public.messages
     set reply_to_message_id = v_parent_two
   where id = v_child_via_new
  returning reply_to_id, reply_to_message_id into v_legacy_reply, v_new_reply;

  if v_new_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (د): UPDATE لم يثبّت reply_to_message_id على القيمة المطلوبة.';
  end if;

  if v_legacy_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (د): UPDATE بـ reply_to_message_id فقط لم يحدّث reply_to_id.';
  end if;

  -- الحالة و: INSERT يكتب العمودين بقيمتين صريحتين مختلفتين.
  -- الأولوية للعمود الجديد كما في trigger المزامنة.
  insert into public.messages (sender_id, recipient_id, content, reply_to_id, reply_to_message_id)
  values (v_sender, v_recipient, '[test] child with both', v_parent_one, v_parent_two)
  returning id, reply_to_id, reply_to_message_id into v_child_with_both, v_legacy_reply, v_new_reply;

  if v_legacy_reply is distinct from v_parent_two or v_new_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (و): العمودان لم يتزامنا إلى قيمة reply_to_message_id عند تعارض صريح.';
  end if;

  -- الحالة ز: رد صحيح بعمود واحد من كل اتجاه ما زال مقبولاً.
  insert into public.messages (sender_id, recipient_id, content, reply_to_id, reply_to_message_id)
  values (v_sender, v_recipient, '[test] child with both equal', v_parent_one, v_parent_one)
  returning id, reply_to_id, reply_to_message_id into v_child_with_both, v_legacy_reply, v_new_reply;

  if v_legacy_reply is distinct from v_parent_one or v_new_reply is distinct from v_parent_one then
    raise exception 'اختبار الردود (ز): الرد الصحيح لم يُقبل أو لم يتزامن العمودان عليه.';
  end if;

  -- رسالة أصل من محادثة أخرى لاختبار الرفض. تُؤخذ من البيانات الحالية.
  select id into v_foreign_parent
  from public.messages
  where id <> v_parent_one
    and id <> v_parent_two
    and id <> v_child_with_both
    and not (
      (sender_id = v_sender and recipient_id = v_recipient)
      or (sender_id = v_recipient and recipient_id = v_sender)
    )
  limit 1;

  if v_foreign_parent is null then
    raise notice 'اختبار الردود: لا توجد محادثة ثانية لاختبار رفض الرد عبر المحادثات؛ تم تخطي الحالتين (هـ) و(ي).';
    raise notice 'اختبار الردود: نجح فحص التعارض واليتيم ومزامنة INSERT/UPDATE في الاتجاهين.';
    return;
  end if;

  -- الحالة هـ: UPDATE يغيّر reply_to_id وحده إلى رسالة من محادثة أخرى.
  -- يجب أن يرفضه trigger التحقق (23503)، لا أن يمرّ لأنه يقرأ reply_to_message_id.
  begin
    update public.messages
       set reply_to_id = v_foreign_parent
     where id = v_child_via_legacy;

    raise exception 'اختبار الردود (هـ): قُبل ربط الرد برسالة من محادثة أخرى عبر reply_to_id وحده.';
  exception
    when sqlstate '23503' then
      null; -- المتوقع: رفض من trigger التحقق
  end;

  -- لا يُطبَّق أي جزء من التحديث المرفوض.
  select reply_to_id, reply_to_message_id into v_legacy_reply, v_new_reply
  from public.messages where id = v_child_via_legacy;

  if v_legacy_reply is distinct from v_parent_two or v_new_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (هـ): الرد المرفوض غيّر القيم رغم الرفض.';
  end if;

  -- الحالة ي: UPDATE يغيّر reply_to_message_id وحده إلى رسالة من محادثة أخرى.
  begin
    update public.messages
       set reply_to_message_id = v_foreign_parent
     where id = v_child_via_new;

    raise exception 'اختبار الردود (ي): قُبل ربط الرد برسالة من محادثة أخرى عبر reply_to_message_id وحده.';
  exception
    when sqlstate '23503' then
      null; -- المتوقع: رفض من trigger التحقق
  end;

  select reply_to_id, reply_to_message_id into v_legacy_reply, v_new_reply
  from public.messages where id = v_child_via_new;

  if v_legacy_reply is distinct from v_parent_two or v_new_reply is distinct from v_parent_two then
    raise exception 'اختبار الردود (ي): الرد المرفوض غيّر القيم رغم الرفض.';
  end if;

  raise notice 'اختبار الردود: نجح التعارض واليتيم والمزامنة والتحقق في الاتجاهين ورفض الردود عبر المحادثات.';
end $$;

rollback;
