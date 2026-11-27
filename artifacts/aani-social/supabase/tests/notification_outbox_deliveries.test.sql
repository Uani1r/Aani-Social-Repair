-- اختبارات تسليم outbox لكل جهاز (public.notification_outbox_deliveries) على
-- قاعدة CI مؤقتة فقط.
-- يُشغَّل بعد harness/notifications_foundation_schema.sql ثم الترحيلات الأربعة:
--   20270312000000_device_tokens.sql
--   20270312000001_notification_outbox.sql
--   20270312000002_notification_push_outbox_triggers.sql
--   20270313000000_notification_outbox_deliveries.sql
-- ويُعاد بعد إعادة تطبيقها (الاختبار ينظّف بياناته في بدايته).
--
-- يغطي: صف تسليم واحد لكل (مهمة، جهاز) بمفتاح فريد، عدم إضافة صفوف عند
-- إعادة الضمان، عدم إرسال شيء إلى جهاز نجح، إعادة المحاولة للفشل المؤقت،
-- الجهاز الملغى، والرمز غير الصالح (skipped + revoked_at بلا حذف)، ومنع
-- المستخدم العادي من الجدول والدالتين.
--
-- لا يُشغَّل على أي مشروع Supabase، ولا يحذف أي صف إنتاجي.

\set ON_ERROR_STOP on

delete from public.notification_outbox_deliveries;
delete from public.notification_outbox;
delete from public.device_tokens;
delete from public.notifications;
delete from public.messages;
delete from public.user_blocks;
delete from public.message_conversation_settings;
update public.profiles set notification_settings = '{}'::jsonb;

-- 0) الشكل والصلاحيات ---------------------------------------------------------
do $$
declare
  v_policies integer;
begin
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.notification_outbox_deliveries'::regclass and relrowsecurity
  ) then
    raise exception 'RLS must be enabled on notification_outbox_deliveries';
  end if;

  -- لا سياسات إطلاقاً: الوصول التشغيلي لـservice_role وحده.
  select count(*) into v_policies from pg_catalog.pg_policy
  where polrelid = 'public.notification_outbox_deliveries'::regclass;
  if v_policies <> 0 then
    raise exception 'notification_outbox_deliveries must have no RLS policy, found %', v_policies;
  end if;

  if has_table_privilege('authenticated', 'public.notification_outbox_deliveries', 'select')
    or has_table_privilege('authenticated', 'public.notification_outbox_deliveries', 'insert')
    or has_table_privilege('authenticated', 'public.notification_outbox_deliveries', 'update')
    or has_table_privilege('authenticated', 'public.notification_outbox_deliveries', 'delete') then
    raise exception 'authenticated must hold no privilege on notification_outbox_deliveries';
  end if;
  if has_table_privilege('anon', 'public.notification_outbox_deliveries', 'select') then
    raise exception 'anon must hold no privilege on notification_outbox_deliveries';
  end if;
  if not has_table_privilege('service_role', 'public.notification_outbox_deliveries', 'select')
    or not has_table_privilege('service_role', 'public.notification_outbox_deliveries', 'insert')
    or not has_table_privilege('service_role', 'public.notification_outbox_deliveries', 'update') then
    raise exception 'service_role must hold select, insert and update on the deliveries';
  end if;

  -- الدالتان للعامل وحده.
  if has_function_privilege('authenticated', 'public.aani_ensure_notification_deliveries(uuid)', 'execute')
    or has_function_privilege('anon', 'public.aani_ensure_notification_deliveries(uuid)', 'execute') then
    raise exception 'the ensure RPC must not be executable by a user';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.aani_complete_notification_delivery(uuid, text, text, text, boolean)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.aani_complete_notification_delivery(uuid, text, text, text, boolean)',
    'execute'
  ) then
    raise exception 'the complete RPC must not be executable by a user';
  end if;

  -- المفتاح الفريد (outbox_id, device_token_id) هو ضمان عدم التكرار.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_outbox_deliveries'::regclass
      and conname = 'notification_outbox_deliveries_pair_key'
      and contype = 'u'
  ) then
    raise exception 'the (outbox_id, device_token_id) unique key must exist';
  end if;
end
$$;

-- 1) صف واحد لكل جهاز نشط، ولا صف لجهاز ملغى، وإعادة الضمان لا تُكرّر ---------
set role service_role;

do $$
declare
  v_outbox uuid;
  v_web uuid;
  v_android uuid;
  v_revoked uuid;
  v_delivery_web uuid;
  v_delivery_android uuid;
  v_count integer;
  v_row public.notification_outbox_deliveries;
begin
  insert into public.device_tokens (user_id, platform, provider, token, installation_id, device_name)
  values ('b0000000-0000-0000-0000-00000000000b', 'web', 'fcm', 'tok-b-web', 'inst-b-web', 'Chrome')
  returning id into v_web;
  insert into public.device_tokens (user_id, platform, provider, token, installation_id, device_name)
  values ('b0000000-0000-0000-0000-00000000000b', 'android', 'fcm', 'tok-b-android', 'inst-b-android', 'Pixel')
  returning id into v_android;
  -- جهاز أُلغي قبل إنشاء التسليم: لا صف تسليم له.
  insert into public.device_tokens (user_id, platform, provider, token, installation_id, device_name, revoked_at)
  values ('b0000000-0000-0000-0000-00000000000b', 'web', 'fcm', 'tok-b-old', 'inst-b-old', 'Chrome', now())
  returning id into v_revoked;

  insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
  values (
    'b0000000-0000-0000-0000-00000000000b',
    'message',
    'deliveries:multi-device',
    jsonb_build_object(
      'message_id', gen_random_uuid(),
      'sender_id', 'a0000000-0000-0000-0000-00000000000a'
    )
  )
  returning id into v_outbox;

  select count(*) into v_count from public.aani_ensure_notification_deliveries(v_outbox);
  if v_count <> 2 then
    raise exception 'every active device must get one delivery row, found %', v_count;
  end if;

  select count(*) into v_count
  from public.notification_outbox_deliveries
  where outbox_id = v_outbox and device_token_id = v_revoked;
  if v_count <> 0 then
    raise exception 'a revoked device must not get a delivery row, found %', v_count;
  end if;

  select * into v_row
  from public.aani_ensure_notification_deliveries(v_outbox)
  where device_token_id = v_web;
  if v_row.id is null
    or v_row.status <> 'pending'
    or v_row.attempts <> 0
    or v_row.sent_at is not null
    or v_row.recipient_user_id <> 'b0000000-0000-0000-0000-00000000000b' then
    raise exception 'a new delivery must be pending for the recipient';
  end if;
  v_delivery_web := v_row.id;

  -- الاستدعاء الثاني لا يضيف صفاً (ON CONFLICT DO NOTHING + المفتاح الفريد).
  select count(*) into v_count from public.aani_ensure_notification_deliveries(v_outbox);
  if v_count <> 2 then
    raise exception 'a second ensure must not add rows, found %', v_count;
  end if;

  -- الإدراج المباشر لزوج مكرر يرفضه المفتاح الفريد.
  begin
    insert into public.notification_outbox_deliveries (outbox_id, device_token_id, recipient_user_id)
    values (v_outbox, v_web, 'b0000000-0000-0000-0000-00000000000b');
    raise exception 'the pair key must reject a duplicate delivery';
  exception
    when unique_violation then null;
  end;

  -- مهمة غير موجودة: لا صفوف.
  select count(*) into v_count from public.aani_ensure_notification_deliveries(gen_random_uuid());
  if v_count <> 0 then
    raise exception 'an unknown task must have no deliveries, found %', v_count;
  end if;

  -- 2) نجاح جهاز: لا إعادة إرسال ولا صف جديد -------------------------------
  if not public.aani_complete_notification_delivery(
    v_delivery_web, 'sent', null, 'projects/aani-social/messages/1', false
  ) then
    raise exception 'the worker must complete the web delivery';
  end if;

  -- الإنهاء الثاني للصف نفسه مرفوض: لا يُعاد إرسال ما نجح.
  if public.aani_complete_notification_delivery(v_delivery_web, 'sent', null, null, false) then
    raise exception 'a completed delivery must not be completed twice';
  end if;

  select count(*) into v_count
  from public.notification_outbox_deliveries
  where id = v_delivery_web
    and status = 'sent'
    and attempts = 1
    and sent_at is not null
    and provider_message_id = 'projects/aani-social/messages/1'
    and last_error is null;
  if v_count <> 1 then
    raise exception 'a sent delivery must keep its provider id and attempts';
  end if;

  select count(*) into v_count from public.aani_ensure_notification_deliveries(v_outbox);
  if v_count <> 2 then
    raise exception 'ensure after a send must not duplicate rows, found %', v_count;
  end if;
  select count(*) into v_count
  from public.notification_outbox_deliveries
  where id = v_delivery_web and status = 'sent';
  if v_count <> 1 then
    raise exception 'a sent delivery must stay sent after ensure';
  end if;

  -- 3) فشل مؤقت: يبقى pending، والصف الناجح لا يعود إليه --------------------
  select id into v_delivery_android
  from public.notification_outbox_deliveries
  where outbox_id = v_outbox and device_token_id = v_android;
  if v_delivery_android is null then
    raise exception 'the android device must have a delivery row';
  end if;

  if not public.aani_complete_notification_delivery(v_delivery_android, 'pending', 'transient', null, false) then
    raise exception 'a transient failure must end the device attempt';
  end if;

  select count(*) into v_count
  from public.notification_outbox_deliveries
  where id = v_delivery_android
    and status = 'pending'
    and attempts = 1
    and last_error = 'transient'
    and sent_at is null;
  if v_count <> 1 then
    raise exception 'a transient failure must stay pending with its error';
  end if;

  -- المحاولة القادمة ترى صفاً واحداً فقط: الجهاز الذي لم ينجح بعد.
  select count(*) into v_count
  from public.notification_outbox_deliveries
  where outbox_id = v_outbox and status = 'pending';
  if v_count <> 1 then
    raise exception 'only the failed device must stay pending, found %', v_count;
  end if;

  -- 4) رمز غير صالح: skipped + إلغاء الرمز بلا حذف السجل --------------------
  if not public.aani_complete_notification_delivery(v_delivery_android, 'skipped', 'invalid_token', null, true) then
    raise exception 'an invalid token must end its delivery';
  end if;

  select count(*) into v_count
  from public.notification_outbox_deliveries
  where id = v_delivery_android and status = 'skipped' and attempts = 2;
  if v_count <> 1 then
    raise exception 'a skipped delivery must be terminal with its attempts';
  end if;

  select count(*) into v_count from public.device_tokens where id = v_android;
  if v_count <> 1 then
    raise exception 'revoking an invalid token must keep the device row';
  end if;
  select count(*) into v_count
  from public.device_tokens
  where id = v_android and revoked_at is not null;
  if v_count <> 1 then
    raise exception 'an invalid token must be revoked with revoked_at';
  end if;

  -- الصف المنتهي لا يعود إلى pending.
  if public.aani_complete_notification_delivery(v_delivery_android, 'pending', null, null, false) then
    raise exception 'a skipped delivery must not become retryable';
  end if;

  -- مهمة لمستلم بلا أي جهاز نشط: لا صفوف تسليم أصلاً.
  insert into public.notification_outbox (recipient_user_id, event_type, dedupe_key, payload)
  values ('c0000000-0000-0000-0000-00000000000c', 'call', 'deliveries:no-devices', '{}'::jsonb)
  returning id into v_outbox;
  select count(*) into v_count from public.aani_ensure_notification_deliveries(v_outbox);
  if v_count <> 0 then
    raise exception 'a recipient without active devices must have no deliveries, found %', v_count;
  end if;
end
$$;

reset role;

-- 5) المستخدم العادي ممنوع من الجدول ومن الدالتين -----------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);

do $$
declare
  v_delivery uuid;
  v_outbox uuid;
begin
  begin
    perform 1 from public.notification_outbox_deliveries limit 1;
    raise exception 'authenticated must not read notification_outbox_deliveries';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.notification_outbox_deliveries (outbox_id, device_token_id, recipient_user_id)
    values (gen_random_uuid(), gen_random_uuid(), auth.uid());
    raise exception 'authenticated must not insert deliveries';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.notification_outbox_deliveries set status = 'sent' where true;
    raise exception 'authenticated must not update deliveries';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.notification_outbox_deliveries where true;
    raise exception 'authenticated must not delete deliveries';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.aani_ensure_notification_deliveries(gen_random_uuid());
    raise exception 'authenticated must not call the ensure RPC';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.aani_complete_notification_delivery(gen_random_uuid(), 'sent');
    raise exception 'authenticated must not call the complete RPC';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

\echo 'notification outbox deliveries: all assertions passed'
