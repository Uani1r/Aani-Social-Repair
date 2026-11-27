-- تسجيل أحداث Push للرسائل والمكالمات والإشعارات الاجتماعية في outbox
-- داخل المعاملة نفسها، دون إضافة أي سجل رسالة/مكالمة إلى public.notifications.
--
--   * الرسالة: بعد insert في public.messages (غير إشارة مكالمة) يُسجَّل حدث
--     'message' للمستلم، ويُتخطى عند: مستلم = مرسل، حظر بين الطرفين
--     (public.user_blocks بعموديه الفعليين blocker_id/blocked_id)، كتم المحادثة
--     عند المستلم (message_conversation_settings.is_muted)، أو تعطيل المستلم
--     إشعارات الرسائل (profiles.notification_settings).
--     الحمولة تحمل معرّفات فقط، بلا نص الرسالة ولا وسائطها.
--   * المكالمة: إشارة سجل المكالمة '[aani-call:v1]{...}' تُسجَّل حدث 'call'
--     لمعرّف المكالمة نفسه (call_id) مع النمط والنتيجة، بلا محتوى رسالة.
--     المكالمات تتبع إعداد 'messages' نفسه (لا مفتاح calls مستقل في التطبيق)،
--     والحظر يمنعها، ولا تُسجَّل في الإشعارات العامة.
--   * الإشعار الاجتماعي: بعد insert في public.notifications (إعجاب/تعليق/
--     متابعة/إعادة نشر/تفاعل قصة…) يُسجَّل حدث 'notification' لصاحبه في
--     outbox، فالإشعارات الاجتماعية الحالية تعمل كما هي بلا تعطيل.
--     ويُحترم إعداد فئته الحقيقية: followers / interactions / stories.
--
-- توافق مع المخطط الإنتاجي (auqqqwfjxrxizlmeweka، قراءة فقط):
--   * user_blocks العمود الفعلي blocked_id وليس blocked_user_id (وهو ما
--     تستخدمه الدالة أدناه). كانت النسخة السابقة تستخدم blocked_user_id
--     فتفشل عند وقت التشغيل قبل هذا التصحيح.
--   * public.messages فيها id, sender_id, recipient_id, content (هذا كل ما
--     تقرأه الدالة).
--   * يوجد في الإنتاج trigger قديم aani_message_notification_after_insert
--     يستدعي public.aani_notify_on_message_insert() وينشئ إشعار رسالة عاماً.
--     هذا الترحيل يُسقط الـtrigger (بعد حصره من المخطط الفعلي) ويُبقي الدالة
--     دون حذف (لا نعرف كل اعتمادها)، فلا يبقى أي trigger متعارض على الرسائل.
--   * حارس منع الرسائل/المكالمات من الإشعارات العامة قد لا يكون مطبَّقاً في
--     الإنتاج (لأن الترحيل القديم لم يُطبَّق)، فيُنشأ هنا مرة أخرى بصورة
--     idempotent (نفس تعريف 20261229)، فلا يدخل نوع message/call القائمة العامة.
--
-- dedupe_key يمنع تكرار الحدث نفسه: message:<id> أو call:<id> أو notification:<id>.
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

-- 0) تنظيف الـtriggers القديمة على الرسائل وحارس الإشعارات العامة ---------------
-- Trigger الرسائل القديم (محصور من مخطط الإنتاج): ينشئ سجلاً عاماً لكل رسالة.
drop trigger if exists aani_message_notification_after_insert on public.messages;

-- الحارس الفعلي ضد كتابة الرسائل/المكالمات في الإشعارات العامة (تعريف 20261229
-- نفسه) يُنشأ هنا مجدداً كي لا يعتمد الترحيل على ترحيل قديم غير مطبَّق.
create or replace function public.aani_block_message_call_notifications()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if lower(coalesce(new.type, '')) in (
    'message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call'
  ) then
    return null;
  end if;
  return new;
end
$$;

revoke all on function public.aani_block_message_call_notifications() from public, anon, authenticated;

drop trigger if exists aani_block_message_call_notifications on public.notifications;
create trigger aani_block_message_call_notifications
before insert on public.notifications
for each row execute function public.aani_block_message_call_notifications();

-- 1) أحداث الرسائل والمكالمات -------------------------------------------------
create or replace function public.aani_enqueue_push_outbox()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  is_call boolean := coalesce(new.content, '') like '[aani-call:v1]%';
  call_payload jsonb := '{}'::jsonb;
  call_id uuid := null;
  muted boolean := false;
  disabled boolean := false;
begin
  if new.sender_id is null or new.recipient_id is null or new.sender_id = new.recipient_id then
    return new;
  end if;

  -- الحظر في أي اتجاه يمنع أي حدث Push بين الطرفين.
  -- أسماء الأعمدة الفعلية في الإنتاج: blocker_id و blocked_id.
  if exists (
    select 1
    from public.user_blocks as b
    where (b.blocker_id = new.recipient_id and b.blocked_id = new.sender_id)
       or (b.blocker_id = new.sender_id and b.blocked_id = new.recipient_id)
  ) then
    return new;
  end if;

  if is_call then
    begin
      call_payload := coalesce(substring(new.content from 15)::jsonb, '{}'::jsonb);
    exception
      when others then
        call_payload := '{}'::jsonb;
    end;

    -- معرّف المكالمة يُقرأ بأمان: حمولة مشوّهة لا تُفشل حفظ سجل المكالمة.
    begin
      call_id := nullif(call_payload ->> 'callId', '')::uuid;
    exception
      when others then
        call_id := null;
    end;

    -- المكالمات تتبع إعداد الرسائل نفسه (لا يوجد مفتاح calls منفصل في
    -- التطبيق)، والحظر يمنع الحدث في كلا الاتجاهين.
    select coalesce(p.notification_settings -> 'messages' = 'false'::jsonb, false)
      into disabled
    from public.profiles as p
    where p.id = new.recipient_id;

    if disabled then
      return new;
    end if;

    insert into public.notification_outbox (
      recipient_user_id, event_type, aggregate_type, aggregate_id, reference_id, dedupe_key, payload
    ) values (
      new.recipient_id,
      'call',
      'message',
      new.id,
      call_id,
      'call:' || new.id::text,
      jsonb_build_object(
        'message_id', new.id,
        'call_id', call_id,
        'mode', nullif(call_payload ->> 'mode', ''),
        'outcome', nullif(call_payload ->> 'outcome', ''),
        'sender_id', new.sender_id
      )
    )
    on conflict (dedupe_key) do nothing;

    return new;
  end if;

  -- الرسائل: كتم المحادثة عند المستلم يمنع Push الرسالة.
  select coalesce((
    select s.is_muted
    from public.message_conversation_settings as s
    where s.user_id = new.recipient_id
      and s.other_user_id = new.sender_id
    limit 1
  ), false) into muted;

  if muted then
    return new;
  end if;

  select coalesce(p.notification_settings -> 'messages' = 'false'::jsonb, false)
    into disabled
  from public.profiles as p
  where p.id = new.recipient_id;

  if disabled then
    return new;
  end if;

  insert into public.notification_outbox (
    recipient_user_id, event_type, aggregate_type, aggregate_id, reference_id, dedupe_key, payload
  ) values (
    new.recipient_id,
    'message',
    'message',
    new.id,
    null,
    'message:' || new.id::text,
    jsonb_build_object(
      'message_id', new.id,
      'sender_id', new.sender_id,
      'recipient_id', new.recipient_id
    )
  )
  on conflict (dedupe_key) do nothing;

  return new;
end
$$;

revoke all on function public.aani_enqueue_push_outbox() from public, anon, authenticated;

drop trigger if exists aani_enqueue_push_outbox on public.messages;
create trigger aani_enqueue_push_outbox
after insert on public.messages
for each row execute function public.aani_enqueue_push_outbox();

-- 2) تصنيف الإشعار الاجتماعي حسب مفاتيح التطبيق الحقيقية في
--    profiles.notification_settings: messages / followers / interactions / stories.
--    أي نوع غير معروف لا يُحجب (السلوك الحالي يبقى كما هو).
create or replace function public.aani_notification_preference_category(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(coalesce(p_type, ''))
    when 'follow' then 'followers'
    when 'new_follower' then 'followers'
    when 'follow_request' then 'followers'
    when 'follow_accepted' then 'followers'
    when 'like' then 'interactions'
    when 'post_like' then 'interactions'
    when 'comment' then 'interactions'
    when 'reply' then 'interactions'
    when 'mention' then 'interactions'
    when 'repost' then 'interactions'
    when 'story_like' then 'stories'
    when 'story_reply' then 'stories'
    when 'story_mention' then 'stories'
    when 'story_view' then 'stories'
    else null
  end
$$;

revoke all on function public.aani_notification_preference_category(text) from public, anon, authenticated;

-- 3) أحداث الإشعارات الاجتماعية ------------------------------------------------
create or replace function public.aani_enqueue_notification_push()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  category text;
  disabled boolean := false;
  reference_value uuid := null;
begin
  if new.user_id is null then
    return new;
  end if;
  -- حارس الإشعارات العامة (أعلاه) يمنع الرسائل والمكالمات من هذا الجدول،
  -- وهذا فحص إضافي إن غاب الـtrigger لأي سبب.
  if lower(coalesce(new.type, '')) in (
    'message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call'
  ) then
    return new;
  end if;
  -- لا Push لفعل المستخدم على نفسه.
  if to_jsonb(new) ->> 'actor_id' = new.user_id::text then
    return new;
  end if;

  -- reference_id يُقرأ من الصف بأمان، فلا تُفشل الحمولة غير المتوقعة الإدراج.
  begin
    reference_value := nullif(to_jsonb(new) ->> 'reference_id', '')::uuid;
  exception
    when others then
      reference_value := null;
  end;

  category := public.aani_notification_preference_category(new.type);
  if category is not null then
    select coalesce(p.notification_settings -> category = 'false'::jsonb, false)
      into disabled
    from public.profiles as p
    where p.id = new.user_id;
    if disabled then
      return new;
    end if;
  end if;

  insert into public.notification_outbox (
    recipient_user_id, event_type, aggregate_type, aggregate_id, reference_id, dedupe_key, payload
  ) values (
    new.user_id,
    'notification',
    'notification',
    new.id,
    reference_value,
    'notification:' || new.id::text,
    jsonb_build_object(
      'notification_id', new.id,
      'type', new.type,
      'preference_category', category,
      'actor_id', to_jsonb(new) ->> 'actor_id',
      'reference_id', reference_value
    )
  )
  on conflict (dedupe_key) do nothing;

  return new;
end
$$;

revoke all on function public.aani_enqueue_notification_push() from public, anon, authenticated;

drop trigger if exists aani_enqueue_notification_push on public.notifications;
create trigger aani_enqueue_notification_push
after insert on public.notifications
for each row execute function public.aani_enqueue_notification_push();

notify pgrst, 'reload schema';

commit;
