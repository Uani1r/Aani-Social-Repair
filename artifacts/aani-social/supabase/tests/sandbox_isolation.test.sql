-- =====================================================================
-- اختبار عزل نظام Sandbox المالي - اختبارات SQL قابلة للتنفيذ
--
-- التشغيل (جلسة واحدة فقط — لا تعتمد على جلسة منفصلة):
--   1. تطبيق الترحيل على قاعدة الاختبار (ليست الإنتاج):
--      supabase db push --linked
--   2. تشغيل ملف الاختبار في نفس الجلسة عبر psql (لا db push --file):
--      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f artifacts/aani-social/supabase/tests/sandbox_isolation.test.sql
--
-- ملاحظة: لا تستخدم --single-transaction. كل عبارة DO هنا تُنفّذ كمعاملة
-- مستقلة (autocommit)، لذا تعود إعدادات set_config(..., is_local=true) إلى
-- وضعها بعد كل عبارة، ويبقى ضبط نطاق المعاملة لكل اختبار معزولاً صحيحاً.
--
-- متطلب الاتصال (مهم للاختبارين 18 و19): يجب أن يكون الاتصال الأصلي (الدور
-- الذي يفتتح الجلسة) مالكاً لجداول sandbox أو يملك صلاحية إدارتها (UPDATE)،
-- لأن هذين الاختبارين ينفّذان RESET ROLE لأداء تحديث الكتالوج
-- (sandbox.top_up_packages) ثم يعيدان SET ROLE authenticated. لا يُفترض أن
-- RESET ROLE يعني تلقائياً أن الاتصال مالك للجداول؛ إن لم يكن الاتصال مالكاً
-- أو إدارياً لجدول top_up_packages، فتخطَّ الاختبارين 18 و19 أو شغّلهما باتصال
-- إداري. الاتصال الافتراضي عبر DATABASE_URL في بيئة Supabase المحلية (postgres)
-- مالك للجداول عادةً، لكن تحقق من ذلك قبل التشغيل.
--
-- ملاحظة: supabase db push يُطبّق الترحيلات المسجلة في مجلد الميريجشنز.
-- المتغيرات myapp.* أدناه مضبوطة عبر SET داخل هذا الملف نفسه، فتكون متاحة
-- لجميع عبارات DO في نفس جلسة التنفيذ. لا حاجة لضبطها في جلسة أخرى.
-- لا يُطبّق أي ترحيل على قاعدة الإنتاج.
-- =====================================================================
--
-- المتغيرات المطلوبة (تُضبط عبر SET في نفس جلسة تنفيذ الملف):
-- القيم أدناه هي UUID ثابتة مطابقة لـ sandbox_seed.sql (تعمل مباشرة في CI):
--   SET myapp.test_user_a = '00000000-0000-0000-0000-0000000000a1';
--   SET myapp.test_user_b = '00000000-0000-0000-0000-0000000000a2';
--   SET myapp.test_user_c = '00000000-0000-0000-0000-0000000000a3';
--   SET myapp.test_founder = '00000000-0000-0000-0000-0000000000a4';
--   SET myapp.test_gift_id = '00000000-0000-0000-0000-0000000000b1';
--   SET myapp.test_package_id = '00000000-0000-0000-0000-0000000000c1';
--   SET myapp.test_sub_package_id = '00000000-0000-0000-0000-0000000000d1';
--   SET myapp.test_promo_package_id = '00000000-0000-0000-0000-0000000000e1';
--   SET myapp.test_post_id = '00000000-0000-0000-0000-0000000000f1';
--   SET myapp.test_post_id_other = '00000000-0000-0000-0000-0000000000f2';
--
-- ملاحظة: جميع الاختبارات تُنفّذ بدور authenticated لتفعيل سياسات RLS.
-- (دور postgres يتجاوز RLS ولا يُمَكّن من اختبار العزل بشكل صحيح.)
-- هوية JWT الافتراضية: userA (نطاق الجلسة). تُزاح per-test داخل كل عبارة DO
-- بنطاق المعاملة (is_local=true) عند الحاجة لمستخدم آخر أو مؤسس.
-- =====================================================================

-- ضبط متغيرات افتراضية مطابقة لبيانات sandbox_seed.sql (UUID حقيقية ثابتة).
-- في CI تُطبَّق هذه القيم مباشرة؛ محلياً يمكنك استبدالها بأي UUID من قاعدة اختبارك.
SET myapp.test_user_a = '00000000-0000-0000-0000-0000000000a1';
SET myapp.test_user_b = '00000000-0000-0000-0000-0000000000a2';
SET myapp.test_user_c = '00000000-0000-0000-0000-0000000000a3';
SET myapp.test_founder = '00000000-0000-0000-0000-0000000000a4';
SET myapp.test_gift_id = '00000000-0000-0000-0000-0000000000b1';
SET myapp.test_package_id = '00000000-0000-0000-0000-0000000000c1';
SET myapp.test_sub_package_id = '00000000-0000-0000-0000-0000000000d1';
SET myapp.test_promo_package_id = '00000000-0000-0000-0000-0000000000e1';
SET myapp.test_post_id = '00000000-0000-0000-0000-0000000000f1';
SET myapp.test_post_id_other = '00000000-0000-0000-0000-0000000000f2';

-- دور المصادقة لتفعيل RLS (postgres يتجاوز RLS)
SET ROLE authenticated;

-- هوية JWT افتراضية: userA (نطاق الجلسة؛ is_local=false). تُOverride داخل كل
-- اختبار يحتاج مستخدماً آخر بنطاق المعاملة (is_local=true) عبر set_config.
SELECT set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', false);

-- ------------------------------------------------------------------
-- 0. التأكد من وجود مؤسس في sandbox.founders
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_exists boolean;
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT EXISTS (SELECT 1 FROM sandbox.founders WHERE user_id = v_founder)
    INTO v_exists;
    IF NOT v_exists THEN
        RAISE EXCEPTION 'Test 0 failed: founder % not found in sandbox.founders. Add via SQL server-side first.', v_founder;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 1. الرصيد التجريبي يُحسب من سجل sandbox.ledger المستقل
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_balance_before integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_balance(v_user_a) INTO v_balance_before;
    IF v_balance_before IS NULL THEN
        RAISE EXCEPTION 'Test 1 failed: balance is NULL for userA';
    END IF;
END $$;

-- منح عملات تجريبية للمستخدم A (المؤسس فقط)
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT public.aani_sandbox_grant_coins(v_user_a, 1000, 'grant-test-1', 'اختبار عزل الرصيد'::text)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test grant-1 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- التحقق من الرصيد بعد المنح
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_balance_after integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_balance(v_user_a) INTO v_balance_after;
    IF v_balance_after <> 1000 THEN
        RAISE EXCEPTION 'Test 1 failed: expected balance 1000 after grant, got %', v_balance_after;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 2. عدم قدرة المستخدم على قراءة رصيد مستخدم آخر (باستثناء المؤسس)
-- ------------------------------------------------------------------
-- اختبار كجلسة userA مع JWT claim للمستخدم A (يجب أن يفشل بـ 42501)
DO $$
DECLARE
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    PERFORM public.aani_sandbox_balance(v_user_b);
    RAISE EXCEPTION 'Test 2 failed: userA should not be able to read userB balance (expected 42501)';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
        RAISE EXCEPTION 'Test 2 failed: expected SQLSTATE 42501, got %', SQLSTATE;
    END IF;
END $$;

-- المؤسس يستطيع قراءة رصيد أي مستخدم (يجب أن ينجح)
DO $$
DECLARE
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    PERFORM public.aani_sandbox_balance(v_user_b);
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Test 2 founder failed: founder should be able to read any user balance, got %', SQLERRM;
END $$;

-- ------------------------------------------------------------------
-- 3. عدم قدرة غير المؤسس على المنح (42501)
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    PERFORM public.aani_sandbox_grant_coins(v_user_a, 100, 'unauth-grant', 'محاولة غير مصرّح'::text);
    RAISE EXCEPTION 'Test 3 failed: userA should not be able to grant coins (expected 42501)';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
        RAISE EXCEPTION 'Test 3 failed: expected SQLSTATE 42501, got %', SQLSTATE;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 4. إرسال هدية تجريبية: يُخصم من رصيد Sandbox فقط
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_gift_id uuid := current_setting('myapp.test_gift_id')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_send_gift(v_user_a, v_user_b, v_gift_id, 'send-test-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 4 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- التحقق من وجود الهدية في sandbox.gift_transactions
DO $$
DECLARE
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.gift_transactions
    WHERE idempotency_key = 'send-test-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 4 failed: expected 1 sandbox gift transaction, got %', v_count;
    END IF;
END $$;

-- التحقق من عدم وجود الهدية في جدول الإنتاج public.gift_transactions
DO $$
DECLARE
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM public.gift_transactions
    WHERE idempotency_key = 'send-test-1';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Test 4 failed: expected 0 production gift transactions for sandbox key, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 5. الشعبية الحقيقية لا تتأثر بالهدية التجريبية
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_popularity integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_user_popularity(v_user_b) INTO v_popularity;
    IF v_popularity IS NULL THEN
        RAISE EXCEPTION 'Test 5 failed: popularity is NULL for userB';
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 6. Idempotency: إعادة الإرسال بنفس المفتاح لا تُخصم مرتين
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_gift_id uuid := current_setting('myapp.test_gift_id')::uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_send_gift(v_user_a, v_user_b, v_gift_id, 'send-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 6 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.gift_transactions
    WHERE idempotency_key = 'send-test-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 6 failed: expected 1 sandbox gift transaction after replay, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 7. RLS: المستخدم A لا يرى معاملة لا علاقة له بها بين userB وuserC
-- ------------------------------------------------------------------
-- ملاحظة: لا تُستخدم معاملة userA↔userB هنا، لأن RLS يسمح للطرفين برؤيتها.
-- ننشئ معاملة بين userB وuserC (مستخدم ثالث لا علاقة له بـ userA) ونتحقق أن
-- userA لا يراها، وأنها موجودة فعلاً (عبر المؤسس) لتجنّب النجاح الزائف.
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_user_c uuid := current_setting('myapp.test_user_c')::uuid;
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_gift_id uuid := current_setting('myapp.test_gift_id')::uuid;
    v_grant jsonb;
    v_send jsonb;
    v_exists_as_founder integer;
    v_sees_bc_count integer;
BEGIN
    -- المؤسس يمنح userB رصيداً تجريبياً حتى يستطيع إرسال هدية
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_founder || '"}', true);
    SELECT public.aani_sandbox_grant_coins(v_user_b, 1000, 'grant-test7-userb', 'test7 userB funding')
    INTO v_grant;
    IF (v_grant->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 7 setup failed: could not fund userB, got %', v_grant;
    END IF;

    -- userB يرسل هدية إلى userC (معاملة لا تخص userA)
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_user_b || '"}', true);
    SELECT public.aani_sandbox_send_gift(v_user_b, v_user_c, v_gift_id, 'send-test7-b-c')
    INTO v_send;
    IF (v_send->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 7 setup failed: userB->userC gift not created, got %', v_send;
    END IF;

    -- التأكد (كالمؤسس) أن المعاملة موجودة فعلاً قبل اختبار العزل
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_founder || '"}', true);
    SELECT count(*) INTO v_exists_as_founder
    FROM sandbox.gift_transactions
    WHERE idempotency_key = 'send-test7-b-c';
    IF v_exists_as_founder <> 1 THEN
        RAISE EXCEPTION 'Test 7 setup failed: expected 1 userB->userC transaction, got %', v_exists_as_founder;
    END IF;

    -- userA (ليس طرفاً في المعاملة) يجب ألا يراها
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_user_a || '"}', true);
    SELECT count(*) INTO v_sees_bc_count
    FROM sandbox.gift_transactions
    WHERE idempotency_key = 'send-test7-b-c';
    IF v_sees_bc_count <> 0 THEN
        RAISE EXCEPTION 'Test 7 failed: userA should not see userB->userC transaction, got %', v_sees_bc_count;
    END IF;
END $$;

-- المؤسس يرى جميع المعاملات
DO $$
DECLARE
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_founder_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT count(*) INTO v_founder_count
    FROM sandbox.gift_transactions;
    IF v_founder_count < 1 THEN
        RAISE EXCEPTION 'Test 7 founder failed: founder should see at least 1 transaction, got %', v_founder_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 8. الشحن التجريبي: النجاح يضيف رصيد، الفشل لا يضيف
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-test-1', true)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
        RAISE EXCEPTION 'Test 8 failed: expected successful top-up, got %', v_result;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-test-2', false)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT FALSE OR (v_result->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 8 failed: expected failed top-up, got %', v_result;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 9. Idempotency الشحن: نفس المفتاح يُعيد نفس النتيجة دون تكرار
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-test-1', true)
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 9 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.top_ups
    WHERE idempotency_key = 'topup-test-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 9 failed: expected 1 top_up record, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 10. الاسترداد ذري ومقاوم للتكرار
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_topup_id uuid;
    v_result jsonb;
    v_duplicate_rejected boolean := false;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    -- الحصول على معرف الشحن الناجح
    SELECT id INTO v_topup_id
    FROM sandbox.top_ups
    WHERE idempotency_key = 'topup-test-1' AND status = 'completed';

    IF v_topup_id IS NULL THEN
        RAISE EXCEPTION 'Test 10 failed: no completed top-up found with key topup-test-1';
    END IF;

    -- الاسترداد الأول (مؤسس فقط) → يجب أن ينجح بحالة refunded
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT public.aani_sandbox_refund_top_up(v_topup_id, 'اختبار الاسترداد'::text)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'status') <> 'refunded' THEN
        RAISE EXCEPTION 'Test 10 failed: expected refunded status, got %', v_result;
    END IF;

    -- الاسترداد الثاني لنفس الشحن → يجب أن يُرفض بـ SQLSTATE 42001 (top-up already refunded)
    BEGIN
        PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
        SELECT public.aani_sandbox_refund_top_up(v_topup_id, 'محاولة مكررة'::text)
        INTO v_result;
        -- إذا وصلنا到这里، لم يُرَفَض الاسترداد الثاني → فشل الاختبار
        RAISE EXCEPTION 'Test 10 failed: expected exception on duplicate refund, got %', v_result;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '42001' THEN
            RAISE EXCEPTION 'Test 10 failed: expected SQLSTATE 42001 on duplicate refund, got %', SQLSTATE;
        END IF;
        v_duplicate_rejected := true;
    END;

    IF NOT v_duplicate_rejected THEN
        RAISE EXCEPTION 'Test 10 failed: expected exception on duplicate refund';
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 11. تفعيل اشتراك تجريبي: Idempotency بالمفتاح نفسه
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_activate_subscription(v_user_a, v_sub_package_id, 'sub-test-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 11 failed: expected ok=true, got %', v_result;
    END IF;

    -- إعادة التفعيل بنفس المفتاح → duplicate=true، لا خصم مكرر
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_activate_subscription(v_user_a, v_sub_package_id, 'sub-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 11 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND package_id = v_sub_package_id;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 11 failed: expected 1 subscription, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 12. تجديد اشتراك تجريبي: يقبل p_idempotency_key
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_sub_id uuid;
    v_result jsonb;
BEGIN
    -- الحصول على معرف الاشتراك النشط
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND package_id = v_sub_package_id AND status = 'active'
    LIMIT 1;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'Test 12 failed: no active subscription found for userA';
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 12 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- إعادة التجديد بنفس المفتاح → duplicate=true (إعادة طلب بعد التنفيذ الأول)
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_sub_id uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND package_id = v_sub_package_id AND status = 'active'
    LIMIT 1;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 12 replay failed: expected duplicate=true, got %', v_result;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 13. إنشاء حملة ترويجية: التحقق من تطابق نوع الهدف مع الباقة وملكية الهدف
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_promo_package_id uuid := current_setting('myapp.test_promo_package_id')::uuid;
    v_post_id uuid := current_setting('myapp.test_post_id')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_create_promotion(v_user_a, v_promo_package_id, 'post', v_post_id, 'promo-test-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 13 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- ترويج بمنشور لا يملكه userA → يُتوقع استثناء 42501
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_promo_package_id uuid := current_setting('myapp.test_promo_package_id')::uuid;
    v_post_id_other uuid := current_setting('myapp.test_post_id_other')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    -- استخدام معرف منشور حقيقي موجود لا يملكه userA (يُفترض أنه مملوك لمستخدم آخر)
    PERFORM public.aani_sandbox_create_promotion(v_user_a, v_promo_package_id, 'post', v_post_id_other, 'promo-test-2');
    RAISE EXCEPTION 'Test 13 failed: expected 42501 for promoting post not owned by userA';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN
        RAISE EXCEPTION 'Test 13 failed: expected SQLSTATE 42501, got %', SQLSTATE;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 14. Idempotency الترويج: نفس المفتاح لا يُنشئ حملة مكررة
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_promo_package_id uuid := current_setting('myapp.test_promo_package_id')::uuid;
    v_post_id uuid := current_setting('myapp.test_post_id')::uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_create_promotion(v_user_a, v_promo_package_id, 'post', v_post_id, 'promo-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 14 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.promotions
    WHERE idempotency_key = 'promo-test-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 14 failed: expected 1 promotion record, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 15. عدم تسجيل أي معاملة تجريبية في جداول الإنتاج
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_gift_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_gift_count
    FROM public.gift_transactions
    WHERE idempotency_key LIKE 'send-test-%' OR idempotency_key LIKE 'topup-test-%' OR idempotency_key LIKE 'sub-test-%' OR idempotency_key LIKE 'promo-test-%';
    IF v_gift_count <> 0 THEN
        RAISE EXCEPTION 'Test 15 failed: expected 0 production gift_transactions from sandbox operations, got %', v_gift_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 16. إعادة الشحن الفاشل بالمفتاح نفسه: تكرار النتيجة دون إضافة عملات
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result1 jsonb;
    v_result2 jsonb;
    v_count integer;
    v_credit_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);

    -- تنفيذ الشحن الفاشل أولاً بمفتاح جديد
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-fail-retry-1', false)
    INTO v_result1;
    IF (v_result1->>'ok')::boolean IS NOT FALSE OR (v_result1->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 16 failed: expected failed top-up, got %', v_result1;
    END IF;

    -- إعادة الطلب بالمفتاح والباقة والمستخدم نفسهما
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-fail-retry-1', false)
    INTO v_result2;
    IF (v_result2->>'ok')::boolean IS NOT FALSE OR (v_result2->>'duplicate')::boolean IS NOT TRUE OR (v_result2->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 16 failed: expected ok=false, duplicate=true, status=failed, got %', v_result2;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.top_ups
    WHERE idempotency_key = 'topup-fail-retry-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 16 failed: expected 1 top_up record for failed key, got %', v_count;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_credit_count
    FROM sandbox.ledger
    WHERE idempotency_key = 'topup-fail-retry-1:credit';
    IF v_credit_count <> 0 THEN
        RAISE EXCEPTION 'Test 16 failed: expected 0 credit ledger entries for failed top-up, got %', v_credit_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 17. إعادة استخدام مفتاح شحن فاشل مع طلب ناجح: تعارض 40901
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    -- أولاً: إنشاء شحن فاشل بالمفتاح (simulate=false) ليثبت المفتاح بحالة failed
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-fail-then-success', false)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT FALSE OR (v_result->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 17 failed: expected failed top-up on first call, got %', v_result;
    END IF;

    -- ثانياً: إعادة استخدام نفس المفتاح مع p_simulate_success=true → يُتوقع استثناء 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    PERFORM public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-fail-then-success', true);
    RAISE EXCEPTION 'Test 17 failed: expected 40901 for reusing failed key with success=true';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '40901' THEN
        RAISE EXCEPTION 'Test 17 failed: expected SQLSTATE 40901, got %', SQLSTATE;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 18. إعادة الطلب بمفتاح موجود بعد تعطيل الباقة: تُعاد النتيجة الأصلية
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-deactivated-pkg-1', true)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 18 failed: expected ok=true for initial top-up, got %', v_result;
    END IF;

    -- تعطيل الباقة (إجراء إداري): يتطلب اتصالاً مالكاً/إدارياً لجدول
    -- sandbox.top_up_packages لأن authenticated لا يملك إلا SELECT. نرفع الدور
    -- مؤقتاً ثم نعيده. تكرار التعطيل/الاختبار داخل كتلة داخلية يضمن إعادة
    -- التفعيل عند أي فشل (القفل/الاستثناء) عبر معالج الاستثناء أدناه.
    BEGIN
        EXECUTE 'RESET ROLE';
        UPDATE sandbox.top_up_packages
        SET is_active = false
        WHERE id = v_package_id;
        EXECUTE 'SET ROLE authenticated';

        -- إعادة الطلب بالمفتاح نفسه رغم تعطيل الباقة → يُتوقع completed وduplicate=true
        PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
        SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-deactivated-pkg-1', true)
        INTO v_result;
        IF (v_result->>'duplicate')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
            RAISE EXCEPTION 'Test 18 failed: expected duplicate=true, status=completed after deactivation, got %', v_result;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- ضمان إعادة تفعيل الباقة قبل إعادة نشر الاستثناء حتى لا تبقى معطلة.
        EXECUTE 'RESET ROLE';
        UPDATE sandbox.top_up_packages
        SET is_active = true
        WHERE id = v_package_id;
        EXECUTE 'SET ROLE authenticated';
        RAISE;
    END;

    -- إعادة تفعيل الباقة لبقية الاختبارات (مسار النجاح)
    EXECUTE 'RESET ROLE';
    UPDATE sandbox.top_up_packages
    SET is_active = true
    WHERE id = v_package_id;
    EXECUTE 'SET ROLE authenticated';
END $$;

-- ------------------------------------------------------------------
-- 19. محاولة شحن جديد بباقة معطّلة: تُرفض
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
BEGIN
    -- تعطيل الباقة مؤقتاً (إجراء إداري: رفع الدور ثم إعادته). يُنفّذ داخل
    -- كتلة داخلية لضمان إعادة التفعيل عند أي فشل.
    BEGIN
        EXECUTE 'RESET ROLE';
        UPDATE sandbox.top_up_packages
        SET is_active = false
        WHERE id = v_package_id;
        EXECUTE 'SET ROLE authenticated';

        PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
        PERFORM public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-new-on-deactivated-1', true);
        RAISE EXCEPTION 'Test 19 failed: expected 42704 for top-up on deactivated package';
    EXCEPTION WHEN OTHERS THEN
        -- إعادة تفعيل الباقة أولاً (مهما كان الاستثناء) حتى لا تبقى معطلة.
        EXECUTE 'RESET ROLE';
        UPDATE sandbox.top_up_packages
        SET is_active = true
        WHERE id = v_package_id;
        EXECUTE 'SET ROLE authenticated';

        IF SQLSTATE <> '42704' THEN
            RAISE EXCEPTION 'Test 19 failed: expected SQLSTATE 42704, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 20. رفض قيمة محاكاة غير محددة (p_simulate_success IS NULL): تعارض 22023
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    PERFORM public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-null-simulate-1', NULL);
    RAISE EXCEPTION 'Test 20 failed: expected 22023 for NULL simulate_success';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN
        RAISE EXCEPTION 'Test 20 failed: expected SQLSTATE 22023, got %', SQLSTATE;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 21. تسلسل القفل بين التجديد والإلغاء (تتابعي، جلسة واحدة)
-- ------------------------------------------------------------------
-- ملاحظة: هذا اختبار تتابعي في جلسة واحدة، ليس اختبار تزامن حقيقي.
-- للاختبار المتزامن الحقيقي، يُنفّذ التجديد والإلغاء في جلستين منفصلتين
-- في وقت واحد على قاعدة اختبار حيّة.
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_sub_id uuid;
    v_renew_result jsonb;
    v_cancel_result jsonb;
    v_status_after text;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);

    -- الحصول على معرف الاشتراك النشط
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND package_id = v_sub_package_id AND status = 'active'
    LIMIT 1;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'Test 21 failed: no active subscription found';
    END IF;

    -- التجديد يحصل على القفل أولاً وينجز
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-concurrent-renew')
    INTO v_renew_result;
    IF (v_renew_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 21 failed: renew should succeed when it gets the lock first, got %', v_renew_result;
    END IF;

    -- الإلغاء يُنفذ بعد انتهاء التجديد (تتابعي، ليس متزامناً)
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_cancel_subscription(v_sub_id)
    INTO v_cancel_result;
    IF (v_cancel_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 21 failed: cancel should succeed after renew, got %', v_cancel_result;
    END IF;

    -- التحقق من أن الحالة أصبحت cancelled
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT status INTO v_status_after
    FROM sandbox.subscriptions
    WHERE id = v_sub_id;
    IF v_status_after <> 'cancelled' THEN
        RAISE EXCEPTION 'Test 21 failed: expected status cancelled, got %', v_status_after;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 22. إعادة طلب تجديد ناجح بعد إلغاء الاشتراك لاحقاً
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_sub_id uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);

    -- تفعيل اشتراك جديد للاختبار (مفتاح التفعيل)
    SELECT public.aani_sandbox_activate_subscription(v_user_a, v_sub_package_id, 'sub-renew-replay-test')
    INTO v_result;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND package_id = v_sub_package_id AND status = 'active'
    ORDER BY started_at DESC LIMIT 1;

    -- التجديد الأول بمفتاح renew مستقل (حتى لا يتعارض مع مفتاح التفعيل)
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-replay-renew')
    INTO v_result;
    IF coalesce((v_result->>'duplicate')::boolean, false) IS NOT FALSE OR (v_result->>'status') <> 'active' THEN
        RAISE EXCEPTION 'Test 22 failed: expected ok=true, duplicate=false, status=active, got %', v_result;
    END IF;

    -- إلغاء الاشتراك لاحقاً
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_cancel_subscription(v_sub_id)
    INTO v_result;
    IF (v_result->>'status') <> 'cancelled' THEN
        RAISE EXCEPTION 'Test 22 failed: expected status cancelled, got %', v_result;
    END IF;

    -- إعادة طلب التجديد بالمفتاح نفسه رغم الإلغاء → duplicate=true, status=completed
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-replay-renew')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'duplicate')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
        RAISE EXCEPTION 'Test 22 failed: expected ok=true, duplicate=true, status=completed after cancellation, got %', v_result;
    END IF;

    -- التحقق من عدم وجود قيد ledger مكرر لمفتاح التجديد
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT count(*) INTO v_count
    FROM sandbox.ledger
    WHERE idempotency_key = 'sub-renew-replay-renew';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 22 failed: expected 1 ledger entry for renew-replay, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 23. استخدام مفتاح idempotency نفسه من مستخدمين مختلفين (تتابعي)
-- ------------------------------------------------------------------
-- ملاحظة: يتم التنفيذ تتابعياً في جلسة واحدة بمحاكاة السباق.
-- للاختبار المتزامن الحقيقي، يُنْفَّذ التجديد من جلستين مستقلتين في وقت واحد.
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_sub_a uuid;
    v_sub_b uuid;
    v_result_a jsonb;
    v_result_b jsonb;
BEGIN
    -- منح userB رصيداً تجريبياً أولاً (المؤسس فقط) حتى يستطيع تفعيل اشتراك.
    -- بدونه سيُرفض التفعيل بـ 42001 (رصيد غير كافٍ) ويفشل الاختبار.
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT public.aani_sandbox_grant_coins(v_user_b, 1000, 'grant-userb-test23', 'test23 userB funding')
    INTO v_result_b;

    -- إنشاء اشتراكين لمستخدمين مختلفين
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_activate_subscription(v_user_a, v_sub_package_id, 'sub-shared-test-a')
    INTO v_result_a;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_b') || '"}', true);
    SELECT public.aani_sandbox_activate_subscription(v_user_b, v_sub_package_id, 'sub-shared-test-b')
    INTO v_result_b;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT id INTO v_sub_a
    FROM sandbox.subscriptions
    WHERE user_id = v_user_a AND status = 'active'
    ORDER BY started_at DESC LIMIT 1;

    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_b') || '"}', true);
    SELECT id INTO v_sub_b
    FROM sandbox.subscriptions
    WHERE user_id = v_user_b AND status = 'active'
    ORDER BY started_at DESC LIMIT 1;

    IF v_sub_a IS NULL OR v_sub_b IS NULL THEN
        RAISE EXCEPTION 'Test 23 failed: could not find subscriptions for test users';
    END IF;

    -- الجلسة A (مستخدم A): التجديد بالمفتاح المشترك
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_renew_subscription(v_sub_a, 'shared-renew-key')
    INTO v_result_a;

    -- الجلسة B (مستخدم B): التجديد بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_b') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_renew_subscription(v_sub_b, 'shared-renew-key')
        INTO v_result_b;
        RAISE EXCEPTION 'Test 23 failed: expected 40901 for shared key between different users';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 23 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 24. استخدام مفتاح idempotency نفسه من top_up و activate_subscription (تتابعي)
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_sub_package_id uuid := current_setting('myapp.test_sub_package_id')::uuid;
    v_result_topup jsonb;
    v_result_activate jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح المشترك
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'cross-topup-activate-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 24 failed: top_up should succeed first, got %', v_result_topup;
    END IF;

    -- الجلسة B: activate_subscription بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_activate_subscription(v_user_a, v_sub_package_id, 'cross-topup-activate-key')
        INTO v_result_activate;
        RAISE EXCEPTION 'Test 24 failed: expected 40901 for cross-function key conflict';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 24 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 25. استخدام مفتاح idempotency نفسه من top_up و grant_coins (تتابعي)
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result_topup jsonb;
    v_result_grant jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح المشترك
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'cross-topup-grant-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 25 failed: top_up should succeed first, got %', v_result_topup;
    END IF;

    -- الجلسة B: grant_coins بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_grant_coins(v_user_a, 100, 'cross-topup-grant-key', 'test grant')
        INTO v_result_grant;
        RAISE EXCEPTION 'Test 25 failed: expected 40901 for cross-function key conflict';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 25 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 26. grant_coins بالمفتاح K ثم top_up بالمفتاح K مع p_simulate_success=false
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result_grant jsonb;
    v_result_topup jsonb;
BEGIN
    -- الجلسة A: grant_coins بالمفتاح K
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    SELECT public.aani_sandbox_grant_coins(v_user_a, 100, 'grant-then-topup-fail-key', 'test grant')
    INTO v_result_grant;
    IF (v_result_grant->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 26 failed: grant_coins should succeed, got %', v_result_grant;
    END IF;

    -- الجلسة B: top_up بالمفتاح نفسه مع simulate=false → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'grant-then-topup-fail-key', false)
        INTO v_result_topup;
        RAISE EXCEPTION 'Test 26 failed: expected 40901 when top_up reuses grant_coins key';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 26 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 27. top_up بالمفتاح K ثم send_gift بالمفتاح نفسه
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_gift_id uuid := current_setting('myapp.test_gift_id')::uuid;
    v_package_id uuid := current_setting('myapp.test_package_id')::uuid;
    v_result_topup jsonb;
    v_result_gift jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح K
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_top_up(v_user_a, v_package_id, 'topup-then-gift-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 27 failed: top_up should succeed, got %', v_result_topup;
    END IF;

    -- الجلسة B: send_gift بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_send_gift(v_user_a, v_user_b, v_gift_id, 'topup-then-gift-key')
        INTO v_result_gift;
        RAISE EXCEPTION 'Test 27 failed: expected 40901 when send_gift reuses top_up key';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 27 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 28. send_gift بالمفتاح K ثم grant_coins بالمفتاح نفسه
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_user_b uuid := current_setting('myapp.test_user_b')::uuid;
    v_gift_id uuid := current_setting('myapp.test_gift_id')::uuid;
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_result_gift jsonb;
    v_result_grant jsonb;
BEGIN
    -- الجلسة A: send_gift بالمفتاح K
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_user_a') || '"}', true);
    SELECT public.aani_sandbox_send_gift(v_user_a, v_user_b, v_gift_id, 'gift-then-grant-key')
    INTO v_result_gift;
    IF (v_result_gift->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 28 failed: send_gift should succeed, got %', v_result_gift;
    END IF;

    -- الجلسة B: grant_coins بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    PERFORM set_config('request.jwt.claims', '{"sub": "' || current_setting('myapp.test_founder') || '"}', true);
    BEGIN
        SELECT public.aani_sandbox_grant_coins(v_user_a, 50, 'gift-then-grant-key', 'test grant')
        INTO v_result_grant;
        RAISE EXCEPTION 'Test 28 failed: expected 40901 when grant_coins reuses send_gift key';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 28 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- =====================================================================
-- جميع الاختبارات اكتملت بنجاح إذا وصل التنفيذ到这里 دون استثناء
-- =====================================================================
-- ------------------------------------------------------------------
-- 29. دالة الإجماليات المالية: المؤسس يحصل على الإجماليات الصحيحة،
--     والمستخدم العادي يُرفض بـ 42501.
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_totals jsonb;
    v_credit bigint;
    v_debit bigint;
BEGIN
    -- المؤسس: الإجماليات يجب أن تطابق التجميع المباشر على sandbox.ledger.
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_founder || '"}', true);
    SELECT public.aani_sandbox_totals() INTO v_totals;

    SELECT
        coalesce(sum(case when type = 'credit' then amount else 0 end), 0)::bigint,
        coalesce(sum(case when type = 'debit'  then amount else 0 end), 0)::bigint
    INTO v_credit, v_debit
    FROM sandbox.ledger;

    IF (v_totals->>'credit')::bigint <> v_credit
       OR (v_totals->>'debit')::bigint <> v_debit
       OR (v_totals->>'net')::bigint <> (v_credit - v_debit) THEN
        RAISE EXCEPTION 'Test 29 failed: founder totals mismatch: got %, expected credit=%, debit=%',
            v_totals, v_credit, v_debit;
    END IF;

    -- المستخدم العادي: يجب أن يُرفض بـ 42501 (تحقق مؤسس خادمجي).
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_user_a || '"}', true);
    BEGIN
        PERFORM public.aani_sandbox_totals();
        RAISE EXCEPTION 'Test 29 failed: non-founder should not call aani_sandbox_totals (expected 42501)';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '42501' THEN
            RAISE EXCEPTION 'Test 29 failed: expected SQLSTATE 42501 for non-founder totals, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 30. صحة التجميع مع سجلات كثيرة متساوية التوقيت وعدم الاعتماد على ترتيب الصفحات.
-- ------------------------------------------------------------------
-- نُدرج 500 سجل (250 دائن/250 مدين) بنفس created_at (تعادل توقيت) عبر المالك،
-- ثم نتحقق أن دالة الإجماليات تطابق التجميع المباشر، وأنها حتمية عبر نداءين
-- (لا تتأثر بترتيب الصفحات ولا تكرار/تجاوز).
DO $$
DECLARE
    v_founder uuid := current_setting('myapp.test_founder')::uuid;
    v_user_a uuid := current_setting('myapp.test_user_a')::uuid;
    v_totals1 jsonb;
    v_totals2 jsonb;
    v_credit bigint;
    v_debit bigint;
BEGIN
    -- إدراج جماعي كمالك (RESET ROLE) — لا RLS لجلسة authenticated.
    EXECUTE 'RESET ROLE';
    INSERT INTO sandbox.ledger (user_id, type, amount, reference, idempotency_key, created_at)
    SELECT v_user_a,
           CASE WHEN g % 2 = 0 THEN 'credit' ELSE 'debit' END,
           1,
           'bulk totals test',
           'bulk-totals-' || g,
           now()
    FROM generate_series(1, 500) AS g;
    EXECUTE 'SET ROLE authenticated';

    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_founder || '"}', true);
    SELECT public.aani_sandbox_totals() INTO v_totals1;

    SELECT
        coalesce(sum(case when type = 'credit' then amount else 0 end), 0)::bigint,
        coalesce(sum(case when type = 'debit'  then amount else 0 end), 0)::bigint
    INTO v_credit, v_debit
    FROM sandbox.ledger;

    IF (v_totals1->>'credit')::bigint <> v_credit OR (v_totals1->>'debit')::bigint <> v_debit THEN
        RAISE EXCEPTION 'Test 30 failed: bulk totals mismatch: got %, expected credit=%, debit=%',
            v_totals1, v_credit, v_debit;
    END IF;

    -- حتمية النتيجة: نداء ثانٍ يعيد نفس الإجماليات (لا اعتماد على ترتيب الصفحات).
    PERFORM set_config('request.jwt.claims', '{"sub": "' || v_founder || '"}', true);
    SELECT public.aani_sandbox_totals() INTO v_totals2;
    IF v_totals1 IS DISTINCT FROM v_totals2 THEN
        RAISE EXCEPTION 'Test 30 failed: totals are not deterministic across calls (order/page dependence)';
    END IF;
END $$;

-- =====================================================================
-- جميع الاختبارات اكتملت بنجاح إذا وصل التنفيذ هنا دون استثناء
-- =====================================================================
DO $$
BEGIN
    RAISE NOTICE 'All sandbox isolation tests (1-30) completed successfully';
END $$;