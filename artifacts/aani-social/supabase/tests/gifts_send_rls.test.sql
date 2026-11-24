-- =====================================================================
-- اختبار SQL لملف الهدايا (الشعبية/الهدايا) — يُشغَّل على قاعدة Supabase/Postgres
-- حقيقية، وليس في بيئة لا تتوفر فيها قاعدة بيانات.
--
-- التشغيل (مثال):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gifts_send_rls.test.sql
-- أو داخل SQL Editor بعد التأكد من وجود الدوال/الجداول (الترحيل
-- 20261124181406_aani_gifts_popularity_final).
--
-- يغطي:
--   1) منع الإرسال للنفس (22023).
--   2) الرصيد غير الكافي (42001) وعدم الخصم.
--   3) منع الإرسال لمستخدم محظور (42501).
--   4) idempotency: نفس المفتاح مرتين → معاملة واحدة وخصم واحد (لا خصم مزدوج).
--   5) قراءة RLS: حساب خاص/غير متابع = 0، متابع = يرى، محظور = 0.
--
-- ملاحظة: الاختبار يعمل داخل معاملة ويُعيد التراجع (rollback) في النهاية،
-- فلا يغيّر بيانات الإنتاج. اختبار التزامن الحقيقي (اتصالان متزامنان) يحتاج
-- جلستين فعليتين؛ هنا نتحقق من idempotency تسلسلياً وهو ما يضمنه قفل
-- advisory + الفهرس الفريد.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- fixtures (لا تتعارض مع بيانات موجودة)
-- ---------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_sender@test.local', '', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_recipient@test.local', '', now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_visitor@test.local', '', now(), now(), now()),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_blocker@test.local', '', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, username, is_private) values
  ('11111111-1111-1111-1111-111111111111', 'g_sender', false),
  ('22222222-2222-2222-2222-222222222222', 'g_recipient', false),
  ('33333333-3333-3333-3333-333333333333', 'g_visitor', false),
  ('44444444-4444-4444-4444-444444444444', 'g_blocker', false)
on conflict (id) do nothing;

insert into public.gifts (id, name, price, popularity_points, is_active)
values ('55555555-5555-5555-5555-555555555555', 'TEST_GIFT', 10, 2, true)
on conflict (id) do nothing;

insert into public.user_wallets (user_id, balance)
values ('11111111-1111-1111-1111-111111111111', 100)
on conflict (user_id) do update set balance = 100;

-- ---------------------------------------------------------------------
-- 1) منع الإرسال للنفس → 22023
-- ---------------------------------------------------------------------
do $$
declare v_code text;
begin
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
  begin
    perform public.aani_send_gift(
      '11111111-1111-1111-1111-111111111111',
      '11111111-1111-1111-1111-111111111111',
      '55555555-5555-5555-5555-555555555555',
      'self-key-1'
    );
    raise exception 'FAIL: self-send did not raise';
  exception when sqlstate '22023' then v_code := '22023';
  end;
  if v_code is distinct from '22023' then raise exception 'FAIL: self-send code %', v_code; end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) الرصيد غير الكافي → 42001 وعدم الخصم
-- ---------------------------------------------------------------------
do $$
declare v_balance integer; v_code text;
begin
  update public.user_wallets set balance = 5 where user_id = '11111111-1111-1111-1111-111111111111';
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
  begin
    perform public.aani_send_gift(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '55555555-5555-5555-5555-555555555555',
      'insufficient-key-1'
    );
    raise exception 'FAIL: insufficient balance did not raise';
  exception when sqlstate '42001' then v_code := '42001';
  end;
  select balance into v_balance from public.user_wallets where user_id = '11111111-1111-1111-1111-111111111111';
  if v_balance <> 5 then raise exception 'FAIL: balance changed on insufficient (got %)', v_balance; end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) منع الإرسال لمستخدم محظور → 42501
-- ---------------------------------------------------------------------
do $$
declare v_code text;
begin
  update public.user_wallets set balance = 100 where user_id = '11111111-1111-1111-1111-111111111111';
  insert into public.user_blocks (blocker_id, blocked_user_id)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')
  on conflict do nothing;
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
  begin
    perform public.aani_send_gift(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '55555555-5555-5555-5555-555555555555',
      'blocked-key-1'
    );
    raise exception 'FAIL: blocked send did not raise';
  exception when sqlstate '42501' then v_code := '42501';
  end;
  if v_code is distinct from '42501' then raise exception 'FAIL: blocked code %', v_code; end if;
  delete from public.user_blocks where blocker_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ---------------------------------------------------------------------
-- 4) idempotency: نفس المفتاح مرتين → معاملة واحدة وخصم واحد
-- ---------------------------------------------------------------------
do $$
declare v_bal integer; v_count integer; v_dup boolean;
begin
  update public.user_wallets set balance = 100 where user_id = '11111111-1111-1111-1111-111111111111';
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

  perform public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'idem-key-1'
  );

  select (result->>'duplicate')::boolean into v_dup
  from public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'idem-key-1'
  ) as result;

  select balance into v_bal from public.user_wallets where user_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into v_count from public.gift_transactions
    where sender_id = '11111111-1111-1111-1111-111111111111' and idempotency_key = 'idem-key-1';

  if v_bal <> 90 then raise exception 'FAIL: balance not single-debited (got %)', v_bal; end if;
  if v_count <> 1 then raise exception 'FAIL: expected 1 transaction (got %)', v_count; end if;
  if v_dup is not true then raise exception 'FAIL: second call not marked duplicate'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 5) قراءة RLS: خاص/غير متابع = 0، متابع = يرى، محظور = 0
-- ---------------------------------------------------------------------
do $$
declare v_count integer;
begin
  -- إرسال هدية للمتلقي (كممثل مناسب) لوجود صفوف للقراءة.
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
  perform public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'rls-seed-1'
  );

  -- حساب خاص.
  update public.profiles set is_private = true where id = '22222222-2222-2222-2222-222222222222';

  -- زائر غير متابع (authenticated) → 0.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  if v_count <> 0 then raise exception 'FAIL: non-follower saw private gifts (%)', v_count; end if;
  reset role;

  -- متابعة معتمدة → يرى.
  insert into public.follows (follower_id, following_id)
  values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222')
  on conflict do nothing;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  if v_count < 1 then raise exception 'FAIL: follower could not see gifts (%)', v_count; end if;
  reset role;

  -- حظر (المتلقي يحظر الزائر) → 0.
  insert into public.user_blocks (blocker_id, blocked_user_id)
  values ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')
  on conflict do nothing;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  if v_count <> 0 then raise exception 'FAIL: blocked viewer saw gifts (%)', v_count; end if;
  reset role;
end $$;

rollback;