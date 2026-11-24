-- =====================================================================
-- اختبار SQL لملف الهدايا (الشعبية/الهدايا) — يُشغَّل على PostgreSQL حقيقي.
--
-- التشغيل (بعد تطبيق الترحيلات على قاعدة اختبارية):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gifts_send_rls.test.sql
--
-- يغطي:
--   1) منع الإرسال للنفس (22023).
--   2) الرصيد غير الكافي (42001) وعدم الخصم.
--   3) منع الإرسال لمستخدم محظور (42501).
--   4) idempotency: نفس المفتاح مرتين → معاملة واحدة وخصم واحد.
--   5) قراءة RLS: خاص/غير متابع = 0، متابع = يرى، محظور = 0.
--
-- يعمل داخل معاملة ويُعيد التراجع (rollback)؛ لا يغيّر بيانات دائمة.
-- اختبار التزامن الحقيقي (جلستان) في gifts_concurrency.sh.
-- =====================================================================
begin;

-- fixtures
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_sender@test.local', '', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_recipient@test.local', '', now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g_visitor@test.local', '', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, username, is_private) values
  ('11111111-1111-1111-1111-111111111111', 'g_sender', false),
  ('22222222-2222-2222-2222-222222222222', 'g_recipient', false),
  ('33333333-3333-3333-3333-333333333333', 'g_visitor', false)
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
  raise notice 'PASS: self-send blocked (22023)';
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
  raise notice 'PASS: insufficient balance (42001) with no debit';
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
  raise notice 'PASS: blocked send prevented (42501)';
end $$;

-- ---------------------------------------------------------------------
-- 4) idempotency: نفس المفتاح مرتين → معاملة واحدة وخصم واحد
-- ---------------------------------------------------------------------
do $$
declare v_bal integer; v_count integer; v_dup boolean; v_result jsonb;
begin
  update public.user_wallets set balance = 100 where user_id = '11111111-1111-1111-1111-111111111111';
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

  v_result := public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'idem-key-1'
  );
  if (v_result->>'ok')::boolean is not true then raise exception 'FAIL: first send not ok: %', v_result; end if;

  v_result := public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'idem-key-1'
  );
  v_dup := (v_result->>'duplicate')::boolean;

  select balance into v_bal from public.user_wallets where user_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into v_count from public.gift_transactions
    where sender_id = '11111111-1111-1111-1111-111111111111' and idempotency_key = 'idem-key-1';

  if v_bal <> 90 then raise exception 'FAIL: balance not single-debited (got %)', v_bal; end if;
  if v_count <> 1 then raise exception 'FAIL: expected 1 transaction (got %)', v_count; end if;
  if v_dup is not true then raise exception 'FAIL: second call not marked duplicate (% )', v_result; end if;
  raise notice 'PASS: idempotency single debit/single tx (balance=%, count=%)', v_bal, v_count;
end $$;

-- ---------------------------------------------------------------------
-- 5) قراءة RLS: خاص/غير متابع = 0، متابع = يرى، محظور = 0
-- ---------------------------------------------------------------------
do $$
declare v_count integer;
begin
  -- هدية إضافية للمتلقي لضمان وجود صفوف.
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
  perform public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'rls-seed-1'
  );

  update public.profiles set is_private = true where id = '22222222-2222-2222-2222-222222222222';

  -- زائر غير متابع → 0.
  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  execute 'reset role';
  if v_count <> 0 then raise exception 'FAIL: non-follower saw private gifts (%)', v_count; end if;
  raise notice 'PASS: private + non-follower sees 0';

  -- متابعة معتمدة → يرى.
  insert into public.follows (follower_id, following_id)
  values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222')
  on conflict do nothing;

  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  execute 'reset role';
  if v_count < 1 then raise exception 'FAIL: follower could not see gifts (%)', v_count; end if;
  raise notice 'PASS: accepted follower sees gifts (%)', v_count;

  -- حظر (المتلقي يحظر الزائر) → 0.
  insert into public.user_blocks (blocker_id, blocked_user_id)
  values ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')
  on conflict do nothing;

  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
  execute 'set local role authenticated';
  select count(*) into v_count from public.gift_transactions
    where recipient_id = '22222222-2222-2222-2222-222222222222';
  execute 'reset role';
  if v_count <> 0 then raise exception 'FAIL: blocked viewer saw gifts (%)', v_count; end if;
  raise notice 'PASS: blocked viewer sees 0';
end $$;

-- ---------------------------------------------------------------------
-- 6) إعادة المحاولة بنفس المفتاح بعد حظر المستلم → duplicate بلا خصم إضافي،
--    مع بقاء منع الإرسال الجديد للمحظور.
-- ---------------------------------------------------------------------
do $$
declare v_bal integer; v_count integer; v_result jsonb; v_dup boolean; v_code text;
begin
  update public.user_wallets set balance = 100 where user_id = '11111111-1111-1111-1111-111111111111';
  delete from public.gift_transactions where idempotency_key = 'retry-after-block-1';
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

  -- إرسال أول ناجح.
  v_result := public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'retry-after-block-1'
  );
  if (v_result->>'ok')::boolean is not true then raise exception 'FAIL: initial send not ok: %', v_result; end if;

  -- المستلم يحظر المرسل.
  insert into public.user_blocks (blocker_id, blocked_user_id)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')
  on conflict do nothing;

  -- إعادة المحاولة بنفس المفتاح → duplicate (لا تُحجب)، وبلا خصم إضافي.
  v_result := public.aani_send_gift(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
    'retry-after-block-1'
  );
  v_dup := (v_result->>'duplicate')::boolean;
  select balance into v_bal from public.user_wallets where user_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into v_count from public.gift_transactions
    where sender_id = '11111111-1111-1111-1111-111111111111' and idempotency_key = 'retry-after-block-1';
  if v_dup is not true then raise exception 'FAIL: retry after block not duplicate: %', v_result; end if;
  if v_bal <> 90 then raise exception 'FAIL: retry after block debited again (balance=%)', v_bal; end if;
  if v_count <> 1 then raise exception 'FAIL: retry after block created extra tx (%)', v_count; end if;
  raise notice 'PASS: retry same key after block -> duplicate, balance=%, count=%', v_bal, v_count;

  -- إرسال جديد (مفتاح مختلف) إلى نفس المستلم المحظور → 42501.
  begin
    perform public.aani_send_gift(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '55555555-5555-5555-5555-555555555555',
      'new-after-block-1'
    );
    raise exception 'FAIL: new send to blocked did not raise';
  exception when sqlstate '42501' then v_code := '42501';
  end;
  if v_code is distinct from '42501' then raise exception 'FAIL: new blocked code %', v_code; end if;
  raise notice 'PASS: new send to blocked still prevented (42501)';

  delete from public.user_blocks
  where blocker_id = '22222222-2222-2222-2222-222222222222'
    and blocked_user_id = '11111111-1111-1111-1111-111111111111';
end $$;

rollback;