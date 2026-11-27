-- اختبارات تأسيس نظام الإشعارات على قاعدة CI مؤقتة فقط.
-- يُشغَّل بعد harness/notifications_foundation_schema.sql ثم الترحيلات الثلاثة،
-- ويُعاد بعد إعادة تطبيق الترحيلات (الاختبار ينظّف بياناته في بدايته).
--
-- يغطي: ملكية رموز الأجهزة على مستوى جميع المستخدمين (نقل الحساب، التدوير،
-- الإلغاء، العزل)، ملكية قفل outbox (الإنهاء من العامل صاحب القفل فقط)،
-- احترام تفضيلات notifications الحقيقية (messages/followers/interactions/
-- stories)، وفصل الرسائل والمكالمات عن قائمة الإشعارات العامة.

\set ON_ERROR_STOP on

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
  -- لا حذف لسجلات الأجهزة: لا منح DELETE ولا سياسة DELETE.
  if has_table_privilege('authenticated', 'public.device_tokens', 'delete') then
    raise exception 'authenticated must not hold DELETE on device_tokens';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.device_tokens'::regclass and polcmd = 'd'
  ) then
    raise exception 'device_tokens must have no DELETE policy';
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.notification_outbox'::regclass and relrowsecurity) then
    raise exception 'RLS must be enabled on notification_outbox';
  end if;

  select count(*) into v_policies from pg_catalog.pg_policy
  where polrelid = 'public.notification_outbox'::regclass;
  if v_policies <> 0 then
    raise exception 'notification_outbox must have no RLS policy, found %', v_policies;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and tablename = 'device_tokens'
      and indexname = 'device_tokens_active_token_key'
  ) then
    raise exception 'device_tokens needs a global active-token unique index';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and tablename = 'device_tokens'
      and indexname = 'device_tokens_active_installation_key'
  ) then
    raise exception 'device_tokens needs a global active-installation unique index';
  end if;
  if exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and tablename = 'device_tokens'
      and indexname in ('device_tokens_user_provider_token_key', 'device_tokens_user_provider_installation_key')
  ) then
    raise exception 'the old per-user unique indexes must be removed';
  end if;

  -- الحارس ضد كتابة الرسائل/المكالمات في الإشعارات العامة موجود مرة واحدة.
  if (select count(*) from pg_catalog.pg_trigger
      where tgrelid = 'public.notifications'::regclass
        and tgname = 'aani_block_message_call_notifications') <> 1 then
    raise exception 'the message/call guard trigger must exist exactly once';
  end if;
  -- Trigger الرسائل القديم (المحصي من الإنتاج) أُسقط بالترحيل، ولا نسخة ثانية منه.
  if exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.messages'::regclass and tgname = 'aani_message_notification_after_insert'
  ) then
    raise exception 'the legacy message notification trigger must be removed by the migration';
  end if;
  -- الدالة القديمة تُترك دون حذف (قد يكون لها اعتماد آخر).
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'aani_notify_on_message_insert'
  ) then
    raise exception 'the legacy notification function must not be dropped';
  end if;
  -- trigger الـoutbox على الرسائل موجود مرة واحدة بعد إعادة التطبيق أيضاً.
  if (select count(*) from pg_catalog.pg_trigger
      where tgrelid = 'public.messages'::regclass and tgname = 'aani_enqueue_push_outbox') <> 1 then
    raise exception 'the push outbox trigger must exist exactly once on messages';
  end if;
  if (select count(*) from pg_catalog.pg_trigger
      where tgrelid = 'public.notifications'::regclass and tgname = 'aani_enqueue_notification_push') <> 1 then
    raise exception 'the notification push trigger must exist exactly once';
  end if;
end
$$;

-- 1) رمز جهاز لمستخدم + جهاز ثانٍ + تدوير + إلغاء ------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', false);

do $$
declare
  v_count integer;
begin
  perform public.aani_register_device_token('web', 'tok-a-web-1', 'fcm', 'inst-a', 'Chrome');
  perform public.aani_register_device_token('android', 'tok-a-and-1', 'fcm', 'inst-a-and', 'Pixel');

  select count(*) into v_count from public.device_tokens where user_id = auth.uid() and revoked_at is null;
  if v_count <> 2 then
    raise exception 'a user must have two active devices, found %', v_count;
  end if;

  -- إعادة تسجيل الرمز نفسه لا تُنشئ ملكية نشطة ثانية.
  perform public.aani_register_device_token('web', 'tok-a-web-1', 'fcm', 'inst-a', 'Chrome');
  select count(*) into v_count from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-web-1' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'a re-registered token must stay active once, found %', v_count;
  end if;

  -- تدوير رمز التثبيت نفسه: القديم يُلغى والجديد نشط.
  perform public.aani_register_device_token('web', 'tok-a-web-2', 'fcm', 'inst-a', 'Chrome');
  select count(*) into v_count from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-web-1' and revoked_at is null;
  if v_count <> 0 then
    raise exception 'the rotated token must not stay active, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-web-2' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'the new token must be active once, found %', v_count;
  end if;

  -- تسجيل الخروج: إلغاء رمز الجهاز، والسجل يبقى.
  select public.aani_revoke_device_token('tok-a-and-1', null, null) into v_count;
  if v_count <> 1 then
    raise exception 'revoking a device token must affect one active row, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens where user_id = auth.uid() and revoked_at is null;
  if v_count <> 1 then
    raise exception 'one active device must remain after sign-out, found %', v_count;
  end if;
end
$$;

-- 1ب) لا حذف مباشر لسجلات الأجهزة، والإلغاء عبر الدالة يحتفظ بالسجل --------
do $$
declare
  v_before integer;
  v_after integer;
  v_count integer;
begin
  select count(*) into v_before from public.device_tokens where user_id = auth.uid();
  if v_before = 0 then
    raise exception 'the owner must have device rows for this test';
  end if;

  begin
    delete from public.device_tokens where user_id = auth.uid();
    raise exception 'authenticated must not delete its own device tokens';
  exception
    when insufficient_privilege then null;
  end;

  select count(*) into v_after from public.device_tokens where user_id = auth.uid();
  if v_after <> v_before then
    raise exception 'a direct delete must not affect device rows, % -> %', v_before, v_after;
  end if;

  -- الإلغاء عبر الدالة: يضبط revoked_at ويبقي السجل.
  perform public.aani_register_device_token('ios', 'tok-a-keep', 'fcm', 'inst-a-keep', 'iPhone');
  select count(*) into v_before from public.device_tokens where user_id = auth.uid() and token = 'tok-a-keep';
  if v_before <> 1 then
    raise exception 'the token to revoke must be registered once, found %', v_before;
  end if;

  select public.aani_revoke_device_token('tok-a-keep', null, null) into v_count;
  if v_count <> 1 then
    raise exception 'the revoke call must affect the active token, found %', v_count;
  end if;

  select count(*) into v_after from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-keep' and revoked_at is not null;
  if v_after <> 1 then
    raise exception 'the revoked device row must be kept with revoked_at, found %', v_after;
  end if;
  select count(*) into v_after from public.device_tokens
  where user_id = auth.uid() and token = 'tok-a-keep' and revoked_at is null;
  if v_after <> 0 then
    raise exception 'the revoked device must not stay active, found %', v_after;
  end if;
end
$$;

-- 2) الانتقال إلى حساب B على التثبيت نفسه --------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);
select public.aani_register_device_token('web', 'tok-a-web-2', 'fcm', 'inst-a', 'Chrome');
reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  v_count integer;
begin
  -- الحساب السابق A فقد الملكية النشطة، وسجله القديم باقٍ بـrevoked_at.
  select count(*) into v_count from public.device_tokens
  where user_id = 'a0000000-0000-0000-0000-00000000000a' and revoked_at is null;
  if v_count <> 0 then
    raise exception 'the previous account must not keep an active token, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens
  where user_id = 'a0000000-0000-0000-0000-00000000000a' and revoked_at is not null;
  if v_count = 0 then
    raise exception 'the previous account row must be kept revoked, not deleted';
  end if;

  -- الحساب الجديد B يملك ملكية نشطة واحدة.
  select count(*) into v_count from public.device_tokens
  where user_id = 'b0000000-0000-0000-0000-00000000000b'
    and token = 'tok-a-web-2' and revoked_at is null and installation_id = 'inst-a';
  if v_count <> 1 then
    raise exception 'the new account must hold exactly one active token, found %', v_count;
  end if;

  -- لا ملكيتين نشطتين للرمز أو للتثبيت على مستوى جميع المستخدمين.
  select count(*) into v_count from public.device_tokens
  where provider = 'fcm' and token = 'tok-a-web-2' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'a token must have one active owner globally, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens
  where provider = 'fcm' and installation_id = 'inst-a' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'an installation must have one active owner globally, found %', v_count;
  end if;
end
$$;

-- 3) توازي التسجيل: القيد الفريد يمنع ملكيتين نشطتين ----------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
begin
  -- صف نشط لحساب C بنفس الرمز والتثبيت (كما لو سبق تسجيله).
  insert into public.device_tokens (user_id, platform, provider, token, installation_id)
  values ('c0000000-0000-0000-0000-00000000000c', 'web', 'fcm', 'tok-race', 'inst-race');

  begin
    insert into public.device_tokens (user_id, platform, provider, token, installation_id)
    values ('a0000000-0000-0000-0000-00000000000a', 'web', 'fcm', 'tok-race', 'inst-other');
    raise exception 'the unique index must reject a second active owner for a token';
  exception
    when unique_violation then null;
  end;

  begin
    insert into public.device_tokens (user_id, platform, provider, token, installation_id)
    values ('a0000000-0000-0000-0000-00000000000a', 'web', 'fcm', 'tok-race-other', 'inst-race');
    raise exception 'the unique index must reject a second active owner for an installation';
  exception
    when unique_violation then null;
  end;
end
$$;

-- تسجيل A عبر الدالة ينقل الملكية: C يفقدها ويبقى سجله.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', false);
select public.aani_register_device_token('web', 'tok-race', 'fcm', 'inst-race', 'Chrome');
reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.device_tokens
  where token = 'tok-race' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'only one active owner may remain after the transfer, found %', v_count;
  end if;
  select count(*) into v_count from public.device_tokens
  where user_id = 'c0000000-0000-0000-0000-00000000000c' and revoked_at is null;
  if v_count <> 0 then
    raise exception 'the previous owner must lose the token, found %', v_count;
  end if;
end
$$;

-- 4) عزل رموز الأجهزة بين المستخدمين ----------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.device_tokens
  where user_id = 'a0000000-0000-0000-0000-00000000000a';
  if v_count <> 0 then
    raise exception 'another user must not read these device tokens, found %', v_count;
  end if;

  update public.device_tokens set device_name = 'hacked'
  where user_id = 'a0000000-0000-0000-0000-00000000000a';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'another user must not update these device tokens, affected %', v_count;
  end if;

  begin
    delete from public.device_tokens where user_id = 'a0000000-0000-0000-0000-00000000000a';
    raise exception 'a user must not delete another user device tokens';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.device_tokens (user_id, platform, provider, token)
    values ('a0000000-0000-0000-0000-00000000000a', 'web', 'fcm', 'tok-forged');
    raise exception 'a user must not insert a token for another user';
  exception
    when insufficient_privilege then null;
  end;

  -- ولا يملك إلغاء رمز مستخدم آخر عبر الدالة.
  select public.aani_revoke_device_token('tok-race', null, null) into v_count;
  if v_count <> 0 then
    raise exception 'a user must not revoke another user token, affected %', v_count;
  end if;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.device_tokens
  where user_id = 'a0000000-0000-0000-0000-00000000000a' and revoked_at is null;
  if v_count <> 1 then
    raise exception 'the other user active token must stay untouched, found %', v_count;
  end if;
end
$$;

-- 5) منع المستخدم العادي من outbox ------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);
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

-- 6) outbox: dedupe، حجز عاملين، ملكية الإنهاء، إعادة المحاولة، القفل المنتهي ---
set role service_role;

do $$
declare
  v_first uuid;
  v_second uuid;
  v_third uuid;
  v_task public.notification_outbox;
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

  insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
  values ('b0000000-0000-0000-0000-00000000000b', 'notification', 'dedupe:3', '{}'::jsonb)
  returning id into v_third;

  -- عامل 1 يحجز مهمة واحدة.
  select * into v_task from public.aani_claim_notification_outbox('worker-1', 1);
  if v_task.id is null or v_task.status <> 'processing' or v_task.locked_by <> 'worker-1' then
    raise exception 'the first worker must claim exactly one task with its lock';
  end if;

  -- مهمة بلا قفل لا يمكن إنهاؤها.
  if public.aani_complete_notification_outbox(v_third, 'sent', 'worker-1', null, null, null) then
    raise exception 'a task without a lock must not be completed';
  end if;

  -- عامل آخر لا ينهي مهمة ليست له.
  if public.aani_complete_notification_outbox(v_task.id, 'sent', 'worker-2', null, null, null) then
    raise exception 'another worker must not complete a task it does not own';
  end if;

  -- اسم عامل فارغ يُرفض.
  begin
    perform public.aani_complete_notification_outbox(v_task.id, 'sent', '', null, null, null);
    raise exception 'an empty worker name must be refused';
  exception
    when insufficient_privilege then null;
  end;

  -- العامل صاحب القفل ينهي المهمة بنجاح.
  if not public.aani_complete_notification_outbox(v_task.id, 'sent', 'worker-1', null, 'provider-123', null) then
    raise exception 'the owning worker must complete the task';
  end if;

  -- لا إنهاء ثانٍ للمهمة نفسها.
  if public.aani_complete_notification_outbox(v_task.id, 'sent', 'worker-1', null, null, null) then
    raise exception 'a completed task must not be completed twice';
  end if;

  select count(*) into v_count from public.notification_outbox
  where id = v_task.id and status = 'sent' and sent_at is not null
    and provider_message_id = 'provider-123' and locked_at is null and last_error is null;
  if v_count <> 1 then
    raise exception 'a sent task must clear its lock and keep the provider id';
  end if;

  -- عامل 2 يحجز المهمتين الباقيتين.
  select count(*) into v_count from public.aani_claim_notification_outbox('worker-2', 5);
  if v_count <> 2 then
    raise exception 'the second worker must claim the two unclaimed tasks, found %', v_count;
  end if;

  -- إعادة المحاولة: فشل مع تأخير يعيد المهمة إلى pending مع الخطأ.
  if not public.aani_complete_notification_outbox(v_second, 'failed', 'worker-2', 'network down', null, 60) then
    raise exception 'the owning worker must be able to schedule a retry';
  end if;
  select count(*) into v_count from public.notification_outbox
  where id = v_second and status = 'pending' and available_at > now() and last_error = 'network down';
  if v_count <> 1 then
    raise exception 'a failed task must be retried after a delay with the error kept';
  end if;
  select count(*) into v_count from public.aani_claim_notification_outbox('worker-3', 5);
  if v_count <> 0 then
    raise exception 'a task delayed for retry must not be claimed yet, found %', v_count;
  end if;

  -- قفل منتهٍ: عامل جديد يستعيد المهمة، والعامل القديم لا ينهيها بعدها.
  update public.notification_outbox
  set locked_at = now() - interval '10 minutes'
  where id = v_third;
  select * into v_task from public.aani_claim_notification_outbox('worker-4', 5);
  if v_task.id is null or v_task.id <> v_third or v_task.locked_by <> 'worker-4' then
    raise exception 'an expired lock must be reclaimed by another worker';
  end if;
  if public.aani_complete_notification_outbox(v_third, 'sent', 'worker-2', null, null, null) then
    raise exception 'the previous worker must not complete a reclaimed task';
  end if;
  if not public.aani_complete_notification_outbox(v_third, 'sent', 'worker-4', null, 'provider-456', null) then
    raise exception 'the new owner of the lock must complete the task';
  end if;
end
$$;

reset role;

-- 7) الرسائل: outbox فقط بلا إشعار عام، واحترام الحظر والكتم والتفضيلات ---------
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

  -- المستلم (B) حظر المرسل (A): لا حدث Push.
  insert into public.user_blocks (blocker_id, blocked_id)
  values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a');
  insert into public.messages (id, sender_id, recipient_id, content)
  values (v_blocked_message, 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'رسالة بعد حظر المستلم للمرسل');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'message:' || v_blocked_message::text;
  if v_count <> 0 then
    raise exception 'a recipient block must not enqueue a push event, found %', v_count;
  end if;
  select count(*) into v_count from public.notifications
  where user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_count <> 0 then
    raise exception 'a blocked private message must not create a public notification, found %', v_count;
  end if;
  delete from public.user_blocks where blocker_id = 'b0000000-0000-0000-0000-00000000000b';

  -- المرسل (A) حظر المستلم (B): لا حدث Push في الاتجاه المعاكس.
  insert into public.user_blocks (blocker_id, blocked_id)
  values ('a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000b');
  insert into public.messages (id, sender_id, recipient_id, content)
  values (gen_random_uuid(), 'a0000000-0000-0000-0000-00000000000a',
          'b0000000-0000-0000-0000-00000000000b', 'رسالة بعد حظر المرسل للمستلم');
  select count(*) into v_count from public.notification_outbox
  where recipient_user_id = 'b0000000-0000-0000-0000-00000000000b'
    and event_type = 'message'
    and payload ->> 'sender_id' = 'a0000000-0000-0000-0000-00000000000a';
  if v_count <> 1 then
    raise exception 'only the earlier unblocked message event must remain, found %', v_count;
  end if;
  delete from public.user_blocks where blocker_id = 'a0000000-0000-0000-0000-00000000000a';

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

-- 8) المكالمات: outbox بمعرّف المكالمة، بلا إشعار عام، وتتبع إعداد messages -----
do $$
declare
  v_message uuid := gen_random_uuid();
  v_call_id uuid := gen_random_uuid();
  v_disabled_call uuid := gen_random_uuid();
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

  -- المكالمات تتبع إعداد messages نفسه (لا يوجد مفتاح calls في التطبيق).
  update public.profiles set notification_settings = '{"messages": false}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
  insert into public.messages (id, sender_id, recipient_id, content)
  values (
    v_disabled_call,
    'a0000000-0000-0000-0000-00000000000a',
    'b0000000-0000-0000-0000-00000000000b',
    '[aani-call:v1]' || jsonb_build_object('callId', gen_random_uuid(), 'mode', 'audio', 'outcome', 'missed')::text
  );
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'call:' || v_disabled_call::text;
  if v_count <> 0 then
    raise exception 'disabled message notifications must also stop call pushes, found %', v_count;
  end if;
  update public.profiles set notification_settings = '{}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
end
$$;

-- 9) الإشعارات الاجتماعية: تفضيلات followers / interactions / stories -----------
do $$
declare
  v_like uuid := gen_random_uuid();
  v_follow uuid := gen_random_uuid();
  v_story uuid := gen_random_uuid();
  v_disabled_follow uuid := gen_random_uuid();
  v_disabled_interaction uuid := gen_random_uuid();
  v_disabled_story uuid := gen_random_uuid();
  v_self uuid := gen_random_uuid();
  v_unknown uuid := gen_random_uuid();
  v_count integer;
begin
  -- القائمة العامة تُسجّل الإشعار دائماً، وoutbox يُسجَّل حين تكون الفئة مفعّلة.
  insert into public.notifications (id, user_id, actor_id, type, content, reference_id)
  values (v_like, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'like', 'أعجب بمنشورك', gen_random_uuid());
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_follow, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'follow', 'بدأ متابعتك');
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_story, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'story_like', 'أعجب بقصتك');

  select count(*) into v_count from public.notification_outbox
  where dedupe_key in ('notification:' || v_like::text, 'notification:' || v_follow::text, 'notification:' || v_story::text);
  if v_count <> 3 then
    raise exception 'social notifications must enqueue their push events when enabled, found %', v_count;
  end if;

  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_like::text
    and payload ->> 'preference_category' = 'interactions';
  if v_count <> 1 then
    raise exception 'a like event must carry the interactions category';
  end if;

  -- تعطيل followers يمنع Push المتابعة فقط، والإشعار بقي في القائمة.
  update public.profiles set notification_settings = '{"followers": false}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_disabled_follow, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'follow', 'بدأ متابعتك');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_disabled_follow::text;
  if v_count <> 0 then
    raise exception 'disabled followers must not enqueue a push event, found %', v_count;
  end if;
  select count(*) into v_count from public.notifications
  where id = v_disabled_follow;
  if v_count <> 1 then
    raise exception 'the public notification must stay even when its push is disabled';
  end if;

  -- تعطيل interactions يمنع Push التعليقات/الإعجابات.
  update public.profiles set notification_settings = '{"interactions": false}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
  insert into public.notifications (id, user_id, actor_id, type, content, reference_id)
  values (v_disabled_interaction, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'comment', 'علّق على منشورك', gen_random_uuid());
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_disabled_interaction::text;
  if v_count <> 0 then
    raise exception 'disabled interactions must not enqueue a push event, found %', v_count;
  end if;

  -- تعطيل stories يمنع Push تفاعلات القصص.
  update public.profiles set notification_settings = '{"stories": false}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_disabled_story, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'story_reply', 'ردّ على قصتك');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_disabled_story::text;
  if v_count <> 0 then
    raise exception 'disabled stories must not enqueue a push event, found %', v_count;
  end if;

  update public.profiles set notification_settings = '{}'::jsonb
  where id = 'b0000000-0000-0000-0000-00000000000b';

  -- فعل المستخدم على نفسه لا يُرسل Push.
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_self, 'b0000000-0000-0000-0000-00000000000b',
          'b0000000-0000-0000-0000-00000000000b', 'like', 'إعجاب ذاتي');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_self::text;
  if v_count <> 0 then
    raise exception 'a self action must not enqueue a push event, found %', v_count;
  end if;

  -- نوع غير معروف يبقى كما هو (لا حجب).
  insert into public.notifications (id, user_id, actor_id, type, content)
  values (v_unknown, 'b0000000-0000-0000-0000-00000000000b',
          'a0000000-0000-0000-0000-00000000000a', 'system', 'تحديث النظام');
  select count(*) into v_count from public.notification_outbox
  where dedupe_key = 'notification:' || v_unknown::text;
  if v_count <> 1 then
    raise exception 'an unknown notification type must keep enqueuing, found %', v_count;
  end if;
end
$$;

-- 10) منع كتابة الرسائل والمكالمات في الإشعارات العامة مباشرة -------------------
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
