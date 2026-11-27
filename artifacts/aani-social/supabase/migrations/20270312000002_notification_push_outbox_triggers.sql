-- تسجيل أحداث Push للرسائل والمكالمات والإشعارات الاجتماعية في outbox
-- داخل المعاملة نفسها، دون إضافة أي سجل رسالة/مكالمة إلى public.notifications.
--
--   * الرسالة: بعد insert في public.messages (غير إشارة مكالمة) يُسجَّل حدث
--     'message' للمستلم، ويُتخطى عند: مستلم = مرسل، حظر بين الطرفين،
--     كتم المحادثة عند المستلم (message_conversation_settings.is_muted)،
--     أو تعطيل المستلم إشعارات الرسائل (profiles.notification_settings).
--     الحمولة تحمل معرّفات فقط، بلا نص الرسالة ولا وسائطها.
--   * المكالمة: إشارة سجل المكالمة '[aani-call:v1]{...}' تُسجَّل حدث 'call'
--     لمعرّف المكالمة نفسه (call_id) مع النمط والنتيجة، بلا محتوى رسالة.
--     تُحترم تفضيلات المكالمات والحظر، ولا تُسجَّل في الإشعارات العامة.
--   * الإشعار الاجتماعي: بعد insert في public.notifications (إعجاب/تعليق/
--     متابعة/إعادة نشر/تفاعل قصة…) يُسجَّل حدث 'notification' لصاحبه في
--     outbox، فالإشعارات الاجتماعية الحالية تعمل كما هي بلا تعطيل.
--
-- dedupe_key يمنع تكرار الحدث نفسه: message:<id> أو call:<id> أو notification:<id>.
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

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
  if exists (
    select 1
    from public.user_blocks as b
    where (b.blocker_id = new.recipient_id and b.blocked_user_id = new.sender_id)
       or (b.blocker_id = new.sender_id and b.blocked_user_id = new.recipient_id)
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

    select coalesce(p.notification_settings -> 'calls' = 'false'::jsonb, false)
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

-- 2) أحداث الإشعارات الاجتماعية ------------------------------------------------
create or replace function public.aani_enqueue_notification_push()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.user_id is null then
    return new;
  end if;
  -- الرسائل والمكالمات ممنوعة أصلاً من هذا الجدول (20261229)، وهذا حارس إضافي.
  if lower(coalesce(new.type, '')) in (
    'message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call'
  ) then
    return new;
  end if;

  insert into public.notification_outbox (
    recipient_user_id, event_type, aggregate_type, aggregate_id, reference_id, dedupe_key, payload
  ) values (
    new.user_id,
    'notification',
    'notification',
    new.id,
    new.reference_id,
    'notification:' || new.id::text,
    jsonb_build_object(
      'notification_id', new.id,
      'type', new.type,
      'actor_id', new.actor_id,
      'reference_id', new.reference_id
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
