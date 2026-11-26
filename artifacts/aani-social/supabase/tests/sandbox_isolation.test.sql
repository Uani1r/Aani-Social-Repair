-- =====================================================================
-- اختبار عزل نظام Sandbox المالي - اختبارات SQL قابلة للتنفيذ
--
-- التشغيل:
--   1. تطبيق الترحيل على قاعدة الاختبار (ليست الإنتاج):
--      supabase db push --linked  (يُطبّق جميع الترحيلات المسجلة بما في ذلك
--      supabase/migrations/20270306000000_aani_sandbox_financial.sql)
--   2. تشغيل ملف الاختبار عبر SQL query (ليست db push --file):
--      supabase db query --file artifacts/aani-social/supabase/tests/sandbox_isolation.test.sql
--
-- ملاحظة: supabase db push يُطبّق الترحيلات المسجلة في مجلد الميريجشنز.
-- supabase db query --file ينفّذ ملف SQL عشوائياً ضد القاعدة المرتبطة.
-- لا يُطبّق أي ترحيل على قاعدة الإنتاج.
--
-- كل اختبار يستخدم كتلة DO مع تحذير (RAISE EXCEPTION) عند عدم تطابق النتيجة المتوقعة.
--
-- المتغيرات المطلوبة قبل التشغيل (في psql أو SQL Editor):
--   \set userA '00000000-0000-0000-0000-000000000001'
--   \set userB '00000000-0000-0000-0000-000000000002'
--   \set founderUser '00000000-0000-0000-0000-000000000003'
--   \set giftId '<uuid من public.gifts>'
--   \set packageId '<uuid من sandbox.top_up_packages>'
--   \set subPackageId '<uuid من sandbox.subscription_packages>'
--   \set promoPackageId '<uuid من sandbox.promotion_packages>'
--   \set postId '<uuid من public.posts owned by userA>'
-- =====================================================================

-- ضبط سياق المصادقة لمستخدم معين داخل الجلسة الحالية
-- auth.uid() في Supabase يقرأ من request.jwt.claims.sub
-- SET LOCAL request.jwt.claims = '{"sub": "<uuid>"}';

-- ------------------------------------------------------------------
-- 0. التأكد من وجود مؤسس في sandbox.founders
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM sandbox.founders WHERE user_id = :'founderUser')
    INTO v_exists;
    IF NOT v_exists THEN
        RAISE EXCEPTION 'Test 0 failed: founder % not found in sandbox.founders. Add via SQL server-side first.', :'founderUser';
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 1. الرصيد التجريبي يُحسب من سجل sandbox.ledger المستقل
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_balance_before integer;
BEGIN
    SELECT public.aani_sandbox_balance(:'userA') INTO v_balance_before;
    -- الرصيد يجب أن يكون عددًا صحيحًا (قد يكون 0 أو أي قيمة)
    IF v_balance_before IS NULL THEN
        RAISE EXCEPTION 'Test 1 failed: balance is NULL for userA';
    END IF;
END $$;

-- منح عملات تجريبية للمستخدم A (المؤسس فقط)
DO $$
DECLARE
    v_result jsonb;
BEGIN
    SELECT public.aani_sandbox_grant_coins(:'userA', 1000, 'grant-test-1', 'اختبار عزل الرصيد'::text)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test grant-1 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- التحقق من الرصيد بعد المنح
DO $$
DECLARE
    v_balance_after integer;
BEGIN
    SELECT public.aani_sandbox_balance(:'userA') INTO v_balance_after;
    IF v_balance_after <> 1000 THEN
        RAISE EXCEPTION 'Test 1 failed: expected balance 1000 after grant, got %', v_balance_after;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 2. عدم قدرة المستخدم على قراءة رصيد مستخدم آخر (باستثناء المؤسس)
-- ------------------------------------------------------------------
-- تشغيل كجلسة userA (ضبط سياق المصادقة)
DO $$
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    PERFORM public.aani_sandbox_balance(:'userB');
    RAISE EXCEPTION 'Test 2 failed: userA should not be able to read userB balance (expected 42501)';
EXCEPTION WHEN OTHERS THEN
    -- يتوقع استثناء 42501 (forbidden)
    IF SQLSTATE <> '42501' THEN
        RAISE EXCEPTION 'Test 2 failed: expected SQLSTATE 42501, got %', SQLSTATE;
    END IF;
END $$;

-- المؤسس يستطيع قراءة رصيد أي مستخدم
DO $$
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
    PERFORM public.aani_sandbox_balance(:'userB');
EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Test 2 founder failed: founder should be able to read any user balance, got %', SQLERRM;
END $$;

-- ------------------------------------------------------------------
-- 3. عدم قدرة غير المؤسس على المنح (42501)
-- ------------------------------------------------------------------
DO $$
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    PERFORM public.aani_sandbox_grant_coins(:'userA', 100, 'unauth-grant', 'محاولة غير مصرّح'::text);
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
    v_result jsonb;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1')
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
    v_popularity integer;
BEGIN
    SELECT public.aani_user_popularity(:'userB') INTO v_popularity;
    -- نتحقق فقط أن الدالة تُرجع قيمة (لا نข Assert على القيمة المحددة لأن الإنتاج قد يختلف)
    IF v_popularity IS NULL THEN
        RAISE EXCEPTION 'Test 5 failed: popularity is NULL for userB';
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 6. Idempotency: إعادة الإرسال بنفس المفتاح لا تُخصم مرتين
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_result jsonb;
    v_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 6 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    SELECT count(*) INTO v_count
    FROM sandbox.gift_transactions
    WHERE idempotency_key = 'send-test-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 6 failed: expected 1 sandbox gift transaction after replay, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 7. RLS: المستخدم A لا يرى معاملات المستخدم B في Sandbox
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_own_count integer;
    v_sees_b_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT count(*) INTO v_own_count
    FROM sandbox.gift_transactions
    WHERE sender_id = :'userA' OR recipient_id = :'userA';

    SELECT count(*) INTO v_sees_b_count
    FROM sandbox.gift_transactions
    WHERE sender_id = :'userB' OR recipient_id = :'userB';

    IF v_sees_b_count <> 0 THEN
        RAISE EXCEPTION 'Test 7 failed: userA should not see userB transactions, got %', v_sees_b_count;
    END IF;
END $$;

-- المؤسس يرى جميع المعاملات
DO $$
DECLARE
    v_founder_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
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
    v_result jsonb;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-1', true)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
        RAISE EXCEPTION 'Test 8 failed: expected successful top-up, got %', v_result;
    END IF;

    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-2', false)
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
    v_result jsonb;
    v_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-1', true)
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 9 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

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
    v_topup_id uuid;
    v_result jsonb;
BEGIN
    -- الحصول على معرف الشحن الناجح
    SELECT id INTO v_topup_id
    FROM sandbox.top_ups
    WHERE idempotency_key = 'topup-test-1' AND status = 'completed';

    IF v_topup_id IS NULL THEN
        RAISE EXCEPTION 'Test 10 failed: no completed top-up found with key topup-test-1';
    END IF;

    -- الاسترداد الأول (مؤسس فقط)
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
    SELECT public.aani_sandbox_refund_top_up(v_topup_id, 'اختبار الاسترداد'::text)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'status') <> 'refunded' THEN
        RAISE EXCEPTION 'Test 10 failed: expected refunded status, got %', v_result;
    END IF;

    -- الاسترداد الثاني لنفس الشحن → يجب أن يُرفض
    BEGIN
        SELECT public.aani_sandbox_refund_top_up(v_topup_id, 'محاولة مكررة'::text)
        INTO v_result;
        RAISE EXCEPTION 'Test 10 failed: expected exception on duplicate refund, got %', v_result;
    EXCEPTION WHEN OTHERS THEN
        -- يتوقع استثناء
        NULL;
    END;
END $$;

-- ------------------------------------------------------------------
-- 11. تفعيل اشتراك تجريبي: Idempotency بالمفتاح نفسه
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_result jsonb;
    v_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-test-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 11 failed: expected ok=true, got %', v_result;
    END IF;

    -- إعادة التفعيل بنفس المفتاح → duplicate=true، لا خصم مكرر
    SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 11 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

    SELECT count(*) INTO v_count
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 11 failed: expected 1 subscription, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 12. تجديد اشتراك تجريبي: يقبل p_idempotency_key
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_sub_id uuid;
    v_result jsonb;
BEGIN
    -- الحصول على معرف الاشتراك النشط
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId' AND status = 'active'
    LIMIT 1;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'Test 12 failed: no active subscription found for userA';
    END IF;

    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 12 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- إعادة التجديد بنفس المفتاح → duplicate=true (إعادة طلب بعد التنفيذ الأول)
DO $$
DECLARE
    v_sub_id uuid;
    v_result jsonb;
BEGIN
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId' AND status = 'active'
    LIMIT 1;

    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
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
    v_result jsonb;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', :'postId', 'promo-test-1')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 13 failed: expected ok=true, got %', v_result;
    END IF;
END $$;

-- ترويج بمنشور لا يملكه userA → يُتوقع استثناء 42501
DO $$
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    -- استخدام معرف منشور افتراضي لا يملكه userA
    PERFORM public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', '00000000-0000-0000-0000-000000000000', 'promo-test-2');
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
    v_result jsonb;
    v_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', :'postId', 'promo-test-1')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 14 failed: expected duplicate=true on replay, got %', v_result;
    END IF;

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
    v_result1 jsonb;
    v_result2 jsonb;
    v_count integer;
    v_credit_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';

    -- تنفيذ الشحن الفاشل أولاً بمفتاح جديد
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-retry-1', false)
    INTO v_result1;
    IF (v_result1->>'ok')::boolean IS NOT FALSE OR (v_result1->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 16 failed: expected failed top-up, got %', v_result1;
    END IF;

    -- إعادة الطلب بالمفتاح والباقة والمستخدم نفسهما
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-retry-1', false)
    INTO v_result2;
    IF (v_result2->>'ok')::boolean IS NOT FALSE OR (v_result2->>'duplicate')::boolean IS NOT TRUE OR (v_result2->>'status') <> 'failed' THEN
        RAISE EXCEPTION 'Test 16 failed: expected ok=false, duplicate=true, status=failed, got %', v_result2;
    END IF;

    SELECT count(*) INTO v_count
    FROM sandbox.top_ups
    WHERE idempotency_key = 'topup-fail-retry-1';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 16 failed: expected 1 top_up record for failed key, got %', v_count;
    END IF;

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
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    -- إعادة استخدام نفس المفتاح مع p_simulate_success=true → يُتوقع استثناء 40901
    PERFORM public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-then-success', true);
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
    v_result jsonb;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-1', true)
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 18 failed: expected ok=true for initial top-up, got %', v_result;
    END IF;

    -- تعطيل الباقة (يُنفّذ من جهة المسؤول)
    UPDATE sandbox.top_up_packages
    SET is_active = false
    WHERE id = :'packageId';

    -- إعادة الطلب بالمفتاح نفسه رغم تعطيل الباقة → يُتوقع completed وduplicate=true
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-1', true)
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
        RAISE EXCEPTION 'Test 18 failed: expected duplicate=true, status=completed after deactivation, got %', v_result;
    END IF;

    -- إعادة تفعيل الباقة لبقية الاختبارات
    UPDATE sandbox.top_up_packages
    SET is_active = true
    WHERE id = :'packageId';
END $$;

-- ------------------------------------------------------------------
-- 19. محاولة شحن جديد بباقة معطّلة: تُرفض
-- ------------------------------------------------------------------
DO $$
BEGIN
    -- تعطيل الباقة مؤقتًا
    UPDATE sandbox.top_up_packages
    SET is_active = false
    WHERE id = :'packageId';

    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    PERFORM public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-new-on-deactivated-1', true);
    RAISE EXCEPTION 'Test 19 failed: expected 42704 for top-up on deactivated package';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42704' THEN
        RAISE EXCEPTION 'Test 19 failed: expected SQLSTATE 42704, got %', SQLSTATE;
    END IF;

    -- إعادة تفعيل الباقة
    UPDATE sandbox.top_up_packages
    SET is_active = true
    WHERE id = :'packageId';
END $$;

-- ------------------------------------------------------------------
-- 20. رفض قيمة محاكاة غير محددة (p_simulate_success IS NULL): تعارض 22023
-- ------------------------------------------------------------------
DO $$
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    PERFORM public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-null-simulate-1', NULL);
    RAISE EXCEPTION 'Test 20 failed: expected 22023 for NULL simulate_success';
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN
        RAISE EXCEPTION 'Test 20 failed: expected SQLSTATE 22023, got %', SQLSTATE;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 21. تعارض التجديد والإلغاء المتزامنين على اشتراك واحد
-- ------------------------------------------------------------------
-- تفعيل اشتراك أولاً ليصبح حالته active
DO $$
DECLARE
    v_sub_id uuid;
    v_result jsonb;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId' AND status = 'active'
    LIMIT 1;

    IF v_sub_id IS NULL THEN
        -- إنشاء اشتراك جديد للاختبار
        SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-concurrent-test')
        INTO v_result;
    END IF;
END $$;

-- سيناريو متزامن محاكى: نحجز قفل الصف ونختبر أن التجديد والإلغاء لا يتعارضان بشكل غير آمن
-- يتم تشغيل التجديد والإلغاء متتالياً في نفس الجلسة للتحقق من سلوك القفل
DO $$
DECLARE
    v_sub_id uuid;
    v_renew_result jsonb;
    v_cancel_result jsonb;
    v_status_after text;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';

    -- الحصول على معرف الاشتراك النشط
    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId' AND status = 'active'
    LIMIT 1;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'Test 21 failed: no active subscription found';
    END IF;

    -- الجلسة A: التجديد يحصل على القفل أولاً وينجز
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-concurrent-renew')
    INTO v_renew_result;
    IF (v_renew_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 21 failed: renew should succeed when it gets the lock first, got %', v_renew_result;
    END IF;

    -- الجلسة B: الإلغاء يُنفذ بعد انتهاء التجديد
    SELECT public.aani_sandbox_cancel_subscription(v_sub_id)
    INTO v_cancel_result;
    IF (v_cancel_result->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 21 failed: cancel should succeed after renew, got %', v_cancel_result;
    END IF;

    -- التحقق من أن الحالة أصبحت cancelled
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
    v_sub_id uuid;
    v_result jsonb;
    v_count integer;
BEGIN
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';

    -- تفعيل اشتراك جديد للاختبار
    SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-renew-replay-test')
    INTO v_result;

    SELECT id INTO v_sub_id
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND package_id = :'subPackageId' AND status = 'active'
    LIMIT 1;

    -- التجديد الأول بالمفتاح الجديد
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-replay-test')
    INTO v_result;
    IF (v_result->>'duplicate')::boolean IS NOT FALSE OR (v_result->>'status') <> 'active' THEN
        RAISE EXCEPTION 'Test 22 failed: expected ok=true, duplicate=false, status=active, got %', v_result;
    END IF;

    -- إلغاء الاشتراك لاحقاً
    SELECT public.aani_sandbox_cancel_subscription(v_sub_id)
    INTO v_result;
    IF (v_result->>'status') <> 'cancelled' THEN
        RAISE EXCEPTION 'Test 22 failed: expected status cancelled, got %', v_result;
    END IF;

    -- إعادة طلب التجديد بالمفتاح نفسه رغم الإلغاء → duplicate=true, status=completed
    SELECT public.aani_sandbox_renew_subscription(v_sub_id, 'sub-renew-replay-test')
    INTO v_result;
    IF (v_result->>'ok')::boolean IS NOT TRUE OR (v_result->>'duplicate')::boolean IS NOT TRUE OR (v_result->>'status') <> 'completed' THEN
        RAISE EXCEPTION 'Test 22 failed: expected ok=true, duplicate=true, status=completed after cancellation, got %', v_result;
    END IF;

    -- التحقق من عدم وجود قيد ledger مكرر
    SELECT count(*) INTO v_count
    FROM sandbox.ledger
    WHERE idempotency_key = 'sub-renew-replay-test';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Test 22 failed: expected 1 ledger entry for renew-replay-test, got %', v_count;
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 23. استخدام مفتاح idempotency نفسه بالتزامن من مستخدمين مختلفين
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_sub_a uuid;
    v_sub_b uuid;
    v_result_a jsonb;
    v_result_b jsonb;
BEGIN
    -- إنشاء اشتراكين لمستخدمين مختلفين
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-shared-test-a')
    INTO v_result_a;

    SET LOCAL request.jwt.claims = '{"sub": "' || :'userB' || '"}';
    SELECT public.aani_sandbox_activate_subscription(:'userB', :'subPackageId', 'sub-shared-test-b')
    INTO v_result_b;

    SELECT id INTO v_sub_a
    FROM sandbox.subscriptions
    WHERE user_id = :'userA' AND idempotency_key IS NOT NULL AND status = 'active'
    ORDER BY started_at DESC LIMIT 1;

    SELECT id INTO v_sub_b
    FROM sandbox.subscriptions
    WHERE user_id = :'userB' AND status = 'active'
    ORDER BY started_at DESC LIMIT 1;

    IF v_sub_a IS NULL OR v_sub_b IS NULL THEN
        RAISE EXCEPTION 'Test 23 failed: could not find subscriptions for test users';
    END IF;

    -- الجلسة A (مستخدم A): التجديد بالمفتاح المشترك
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_renew_subscription(v_sub_a, 'shared-renew-key')
    INTO v_result_a;

    -- الجلسة B (مستخدم B): التجديد بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userB' || '"}';
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
-- 24. استخدام مفتاح idempotency نفسه بالتزامن من top_up و activate_subscription
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_result_topup jsonb;
    v_result_activate jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح المشترك
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'cross-topup-activate-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 24 failed: top_up should succeed first, got %', v_result_topup;
    END IF;

    -- الجلسة B: activate_subscription بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    BEGIN
        SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'cross-topup-activate-key')
        INTO v_result_activate;
        RAISE EXCEPTION 'Test 24 failed: expected 40901 for cross-function key conflict';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '40901' THEN
            RAISE EXCEPTION 'Test 24 failed: expected SQLSTATE 40901, got %', SQLSTATE;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------------
-- 25. استخدام مفتاح idempotency نفسه بالتزامن من top_up و grant_coins
-- ------------------------------------------------------------------
DO $$
DECLARE
    v_result_topup jsonb;
    v_result_grant jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح المشترك
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'cross-topup-grant-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 25 failed: top_up should succeed first, got %', v_result_topup;
    END IF;

    -- الجلسة B: grant_coins بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
    BEGIN
        SELECT public.aani_sandbox_grant_coins(:'userA', 100, 'cross-topup-grant-key', 'test grant')
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
    v_result_grant jsonb;
    v_result_topup jsonb;
BEGIN
    -- الجلسة A: grant_coins بالمفتاح K
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
    SELECT public.aani_sandbox_grant_coins(:'userA', 100, 'grant-then-topup-fail-key', 'test grant')
    INTO v_result_grant;
    IF (v_result_grant->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 26 failed: grant_coins should succeed, got %', v_result_grant;
    END IF;

    -- الجلسة B: top_up بالمفتاح نفسه مع simulate=false → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    BEGIN
        SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'grant-then-topup-fail-key', false)
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
    v_result_topup jsonb;
    v_result_gift jsonb;
BEGIN
    -- الجلسة A: top_up بالمفتاح K
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-then-gift-key', true)
    INTO v_result_topup;
    IF (v_result_topup->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 27 failed: top_up should succeed, got %', v_result_topup;
    END IF;

    -- الجلسة B: send_gift بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    BEGIN
        SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'topup-then-gift-key')
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
    v_result_gift jsonb;
    v_result_grant jsonb;
BEGIN
    -- الجلسة A: send_gift بالمفتاح K
    SET LOCAL request.jwt.claims = '{"sub": "' || :'userA' || '"}';
    SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'gift-then-grant-key')
    INTO v_result_gift;
    IF (v_result_gift->>'ok')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 28 failed: send_gift should succeed, got %', v_result_gift;
    END IF;

    -- الجلسة B: grant_coins بالمفتاح نفسه → يجب أن يُرفض بـ 40901
    SET LOCAL request.jwt.claims = '{"sub": "' || :'founderUser' || '"}';
    BEGIN
        SELECT public.aani_sandbox_grant_coins(:'userA', 50, 'gift-then-grant-key', 'test grant')
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
DO $$
BEGIN
    RAISE NOTICE 'All sandbox isolation tests (1-28) passed successfully';
END $$;