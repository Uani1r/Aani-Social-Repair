-- اختبارات تأسيس نظام الإشعارات على قاعدة CI مؤقتة فقط:
--   device_tokens (عزل المستخدم/تعدد الأجهزة/التكرار/التدوير/الإلغاء)،
--   notification_outbox (منع الوصول للمستخدمين، dedupe، حجز عاملين، إعادة
--   المحاولة، استعادة القفل المنتهي)، وفصل الرسائل والمكالمات عن الإشعارات
--   العامة مع تسجيل حدث Push في outbox، وبقاء الإشعارات الاجتماعية.
-- يُشغَّل بعد harness/notifications_foundation_schema.sql ثم الترحيلات الثلاثة.

\set ON_ERROR_STOP on

-- تنظيف باعث على إعادة التشغيل: الاختبار لا يعتمد على بقايا تشغيل سابق.
delete from public.notification_outbox;
delete from public.device_tokens;
delete from public.notifications;
delete from public.messages;
delete from public.user_blocks;
delete from public.message_conversation_settings;
update public.profiles set notification_settings = '{}'::jsonb;

-- 0) الشكل والصلاحيات العامة ------------------------------------------------
do $$
declare
  v_policies integer;
begin
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.device_tokens'::regclass and relrowsecurity) then
    raise exception 'RLS must be enabled on device_tokens';
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.notification_outbox'::regclass and relrowsecurity) then
    raise exception 'RLS must be enabled on notification_outbox';
  end if;

  select count(*) into v_policies from pg_catalog.pg_policy
  where polrelid = 'public.notification_outbox'::regclass;
  if v_policies <> 0 then
    raise exception 'notification_outbox must have no RLS policy, found %', v_policies;
  end if;

  if exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = 'aani_message_notification_after_insert'
  ) then
    raise exception 'the old message notification trigger must stay removed';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.notifications'::regclass and tgname = 'aani_block_message_call_notifications'
  ) then
    raise exception 'the message/call guard trigger must stay in place';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = 'aani_enqueue_push_outbox'
  ) then
    raise exception 'the push outbox trigger must exist on messages';
  end if;
end
$$;

-- 1) device_tokens: تسجيل، تعدد أجهزة، تكرار، تدوير، إلغاء --------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', false);

do $$
declare
  v_count integer;
begin
  perform public.aani_register_device_token('web', 'tok-a-web-1', 'fcm', 'inst-a-web', 'Chrome');
  select count(*) into v_count from public.device_tokens where user_id = auth.uid();
  if v_count <> 1 then
    raise exception 'a first device token must be stored, found %', v_count;
  end if;

  perform public.aani_register_device_token('android', 'tok-a-and-1', 'fcm', 'inst-a-and', 'Pixel');
  select count(*) into v_count from public.device_tokens where user_id = auth.uid();
  if v_count <> 2 then
    raise exception 'a second device must be added, found %', v_count;
  end if;

  -- لا تكرار لنفس الرمز لنفس المستخدم
  perform public.aani_register_device_token('web', 'tok-a-web-1', 'fcm', 'inst-a-web', 'Chrome');
  select count(*) into v_count from public.device_tokens where user_id = auth.uid();
  if v_count <> 2 then
    raise exception 'a duplicate token must not add a row, found %', v_count;
  end if;

  -- تدوير الرمز: رمز التثبيت نفسه القديم يُلغى
  perform public.aani_register_device_token('web', 'tok-a-web-2', 'fcm', 'inst-a-web', 'Chrome');
  select count(*) into v_count from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-web-2' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'the rotated token must be active once, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-web-1' and revoked_at is not null;
  if v_count <> 1 then
    raise exception 'the old token must be revoked after rotation, found %', v_count;
  end if;

  -- إلغاء جهاز عند تسجيل الخروج
  select public.aani_revoke_device_token('tok-a-and-1', null, null) into v_count;
  if v_count <> 1 then
    raise exception 'revoking a device token must affect one row, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens where user_id = auth.uid() and revoked_at is null;
  if v_count <> 1 then
    raise exception 'one active token must remain, found %', v_count;
  end if;
end
$$;

-- 2) عزل device_tokens بين المستخدمين ----------------------------------------
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.device_tokens;
  if v_count <> 0 then
    raise exception 'another user must not read these device tokens, found %', v_count;
  end if;

  update public.device_tokens set device_name = 'hacked'
  where user_id = 'a0000000-0000-0000-0000-00000000000a';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'another user must not update these device tokens, affected %', v_count;
  end if;

  delete from public.device_tokens where user_id = 'a0000000-0000-0000-0000-00000000000a';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'another user must not delete these device tokens, affected %', v_count;
  end if;

  begin
    insert into public.device_tokens (user_id, platform, provider, token)
    values ('a0000000-0000-0000-0000-00000000000a', 'web', 'fcm', 'tok-forged');
    raise exception 'a user must not insert a token for another user';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

-- 3) منع المستخدم العادي من outbox ------------------------------------------
do $$
begin
  begin
    perform 1 from public.notification_outbox limit 1;
    raise exception 'authenticated must not read notification_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key)
    values ('b0000000-0000-0000-0000-00000000000b', 'message', 'forged');
    raise exception 'authenticated must not insert into notification_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.aani_claim_notification_outbox('forged-worker');
    raise exception 'authenticated must not claim outbox tasks';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 4) outbox: منع التكرار، حجز عاملين، إعادة المحاولة، القفل المنتهي -----------
set role service_role;

do $$
declare
  v_first uuid;
  v_second uuid;
  v_worker_one public.notification_outbox;
  v_worker_two public.notification_outbox[];
  v_count integer;
begin
  insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
  values ('b0000000-0000-0000-0000-00000000000b', 'message', 'dedupe:1', '{}'::jsonb)
  returning id into v_first;

  begin
    insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
    values ('b0000000-0000-0000-0000-00000000000b', 'message', 'dedupe:1', '{}'::jsonb);
    raise exception 'dedupe_key must prevent a duplicate event';
  exception
    when unique_violation then null;
  end;

  insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
  values ('b0000000-0000-0000-0000-00000000000b', 'notification', 'dedupe:2', '{}'::jsonb)
  returning id into v_second;

  select * into v_worker_one from public.aani_claim_notification_outbox('worker-1', 1);
  if v_worker_one.id is null or v_worker_one.status <> 'processing' or v_worker_one.locked_by <> 'worker-1' then
    raise exception 'the first worker must claim exactly one task';
  end if;
  if v_worker_one.attempts <> 1 then
    raise exception 'claiming must increment attempts, found %', v_worker_one.attempts;
  end if;

  -- عامل ثانٍ لا يأخذ المهمة نفسها (القفل حديث)
  select array_agg(t) into v_worker_two from public.aani_claim_notification_outbox('worker-2', 5) as t;
  if coalesce(array_length(v_worker_two, 1), 0) <> 1 then
    raise exception 'the second worker must claim only the unclaimed task, found %',
      coalesce(array_length(v_worker_two, 1), 0);
  end if;

  select count(*) into v_count from public.aani_claim_notification_outbox('worker-3', 5);
  if v_count <> 0 then
    raise exception 'a third worker must not claim an in-flight task, found %', v_count;
  end if;

  -- إعادة محاولة: فشل مع تأخير يعيد المهمة إلى pending وليس الآن
  if not public.aani_complete_notification_outbox(v_first, 'failed', 'worker-1', 'network down', null, 60) then
    raise exception 'completing a failed task must succeed';
  end if;
  select count(*) into v_count from public.notification_outbox
  where id = v_first and status = 'pending' and available_at > now() and last_error = 'network down';
  if v_count <> 1 then
    raise exception 'a failed task must be retried after a delay with the error kept';
  end if;

  select count(*) into v_count from public.aani_claim_notification_outbox('worker-4', 5);
  if v_count <> 0 then
    raise exception 'a task delayed for retry must not be claimed yet, found %', v_count;
  end if;

  -- قفل منتهٍ: عامل جديد يستعيد المهمة المتروكة
  update public.notification_outbox
  set locked_at = now() - interval '10 minutes'
  where id = v_second;
  select count(*) into v_count from public.aani_claim_notification_outbox('worker-4', 5) as t where t.id = v_second;
  if v_count <> 1 then
    raise exception 'an expired lock must be reclaimed by another worker, found %', v_count;
  end if;

  if not public.aani_complete_notification_outbox(v_second, 'sent', 'worker-4', null, 'provider-123', null) then
    raise exception 'completing a sent task must succeed';
  end if;
  select count(*) into v_count from public.notification_outbox
  where id = v_second and status = 'sent' and sent_at is not null
    and provider_message_id = 'provider-123' and locked_at is null and last_error is null;
  if v_count <> 1 then
    raise exception 'a sent task must clear its lock and keep the provider id';
  end if;
end
$$;

reset role;

-- 5) الرسائل: outbox فقط بلا إشعار عام، واحترام الحظر والكتم والتفضيلات ---------
do $$
declare
  v_message uuid := gen_random_uuid();
  v_muted_message uuid := gen_random_uuid();
  v_blocked_message uuid := gen_random_uuid();
  v_disabled_message uuid := gen_random_uuid();
  v_count integer;
  v_payload jsonb;
begin
  insert into public.messages (id, sender_id, recipient_id, content)
  values (v_message, 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'مرحباً، هذا نص خاص');

  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'message:' || v_message::text and event_type = 'message'
    and recipient_user_id = 'b0000000-0000-0000-0000-00000000000b'
    and aggregate_id = v_message and status = 'pending';
  if v_count <> 1 then
    raise exception 'a private message must enqueue exactly one push event, found %', v_count;
  end if;

  select payload into v_payload from public.notification_outbox
  where dedupe_key = 'message:' || v_message::text;
  if v_payload ? 'content' or v_payload::text like '%نص خاص%' then
    raise exception 'the outbox payload must not carry the message body';
  end if;

  select count(*) into v_count from public.notifications
  where user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_count <> 0 then
    raise exception 'a private message must not create a public notification, found %', v_count;
  end if;

  -- كتم المحادثة عند المستلم يمنع الحدث
  insert into public.message_conversation_settings (user_id, other_user_id, is_muted)
  values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', true);
  insert into public.messages (id, sender_id, recipient_id, content)
  values (v_muted_message, 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'رسالة في محادثة مكتومة');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'message:' || v_muted_message::text;
  if v_count <> 0 then
    raise exception 'a muted conversation must not enqueue a push event, found %', v_count;
  end if;

  delete from public.message_conversation_settings
  where user_id = 'b0000000-0000-0000-0000-00000000000b';

  -- حظر بين الطرفين يمنع الحدث
  insert into public.user_blocks (blocker_id, blocked_user_id)
  values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a');
  insert into public.messages (id, sender_id, recipient_id, content)
  values (v_blocked_message, 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'رسالة بعد الحظر');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'message:' || v_blocked_message::text;
  if v_count <> 0 then
    raise exception 'a block must not enqueue a push event, found %', v_count;
  end if;
  delete from public.user_blocks where blocker_id = 'b0000000-0000-0000-0000-00000000000b';

  -- تعطيل إشعارات الرسائل يمنع الحدث
  update public.profiles set notification_settings = '{"messages": false}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
  insert into public.messages (id, sender_id, recipient_id, content)
  values (v_disabled_message, 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'رسالة بعد تعطيل الإشعارات');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'message:' || v_disabled_message::text;
  if v_count <> 0 then
    raise exception 'disabled message notifications must not enqueue a push event, found %', v_count;
  end if;
  update public.profiles set notification_settings = '{}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
end
$$;

-- 6) المكالمات: outbox بمعرّف المكالمة، بلا إشعار عام ---------------------------
do $$
declare
  v_message uuid := gen_random_uuid();
  v_call_id uuid := gen_random_uuid();
  v_count integer;
begin
  insert into public.messages (id, sender_id, recipient_id, content)
  values (
    v_message,
    'a0000000-0000-0000-0000-00000000000a',
    'b0000000-0000-0000-0000-00000000000b',
    '[aani-call:v1]' || jsonb_build_object(
      'callId', v_call_id, 'mode', 'audio', 'outcome', 'missed', 'durationSeconds', 0
    )::text
  );

  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'call:' || v_message::text
    and event_type = 'call'
    and recipient_user_id = 'b0000000-0000-0000-0000-00000000000b'
    and payload ->> 'call_id' = v_call_id::text;
  if v_count <> 1 then
    raise exception 'a call event must enqueue one push event with its call id, found %', v_count;
  end if;

  select count(*) into v_count from public.notifications
  where user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_count <> 0 then
    raise exception 'a call must not create a public notification, found %', v_count;
  end if;
end
$$;

-- 7) الإشعارات الاجتماعية: تبقى في notifications وتُسجَّل في outbox --------------
do $$
declare
  v_id uuid := gen_random_uuid();
  v_count integer;
begin
  insert into public.notifications (id, user_id, actor_id, type, content, reference_id)
  values (v_id, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'like', 'أعجب بمنشورك', gen_random_uuid());

  select count(*) into v_count from public.notifications
  where id = v_id and user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_count <> 1 then
    raise exception 'a social notification must still be stored for its owner';
  end if;

  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_id::text
    and event_type = 'notification'
    and recipient_user_id = 'b0000000-0000-0000-0000-00000000000b'
    and aggregate_id = v_id;
  if v_count <> 1 then
    raise exception 'a social notification must enqueue one push event, found %', v_count;
  end if;
end
$$;

-- 8) منع كتابة الرسائل والمكالمات في الإشعارات العامة مباشرة --------------------
do $$
declare
  v_count integer;
begin
  insert into public.notifications (user_id, actor_id, type, content)
  values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'message', 'رسالة');
  insert into public.notifications (user_id, actor_id, type, content)
  values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'call', 'مكالمة');

  select count(*) into v_count from public.notifications
  where lower(type) in ('message', 'call');
  if v_count <> 0 then
    raise exception 'message/call rows must never reach public notifications, found %', v_count;
  end if;
end
$$;

\echo 'notifications foundation: all assertions passed'
