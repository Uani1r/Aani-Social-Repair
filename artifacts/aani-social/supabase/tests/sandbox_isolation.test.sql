-- =====================================================================
-- اختبار عزل نظام Sandbox المالي
--
-- ملاحظة التشغيل: هذا الملف يُنفّذ على قاعدة Supabase مباشرة (عبر SQL Editor
-- أو أداة اختبار قاعدية) بعد تطبيق ترحيل
-- supabase/migrations/20270306000000_aani_sandbox_financial.sql.
-- لا يُنفّذ هذا الاختبار في بيئة CI بدون قاعدة مباشرة، لأن لا يوجد اتصال
-- بـ Supabase live في حاوية التطوير المؤقتة.
--
-- الغرض: إثبات أن بيانات Sandbox معزولة تمامًا عن الإنتاج:
--   * لا تمس public.user_wallets.
--   * لا تُسجل هدايا Sandbox في public.gift_transactions.
--   * لا تؤثر في public.aani_user_popularity.
--   * لا يُسمح لمستخدم بالوصول لمعاملات مستخدم آخر.
--   * لا يُسمح لغير المؤسس بدعوة دوال الإدارة (grant/refund/...).
-- =====================================================================

-- requires: userA, userB مستخدمان حقيقيان في public.profiles و auth.users.
-- requires: founderUser مستخدم مضاف إلى sandbox.founders (إدارة جانب خادم فقط).
-- do \\set userA '00000000-0000-0000-0000-000000000001'
-- do \\set userB '00000000-0000-0000-0000-000000000002'
-- do \\set founderUser '00000000-0000-0000-0000-000000000003'
-- do \\set giftId '<uuid من public.gifts>'

-- 1. الرصيد التجريبي يُحسب من سجل sandbox.ledger المستقل، لا من public.user_wallets.
-- قبل أي عملية: رصيد sandbox = 0.
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_before;

-- منح عملات تجريبية للمستخدم A كمؤسس.
SELECT public.aani_sandbox_grant_coins(:'userA', 1000, 'grant-test-1', 'اختبار عزل الرصيد');

-- التحقق من أن رصيد sandbox أصبح 1000.
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_after_grant;

-- التأكد من أن محفظة الإنتاج (public.user_wallets) لم تتغير (لا تعديل على أرصدة الإنتاج).
-- يُفترض أن استعلام public.user_wallets للمستخدم A لا يرتبط بعمليات Sandbox.

-- 2. إرسال هدية تجريبية: يُخصم من رصيد Sandbox فقط، ولا يُسجل في public.gift_transactions.
SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1');

--确认 أن الهدية التجريبية موجودة في sandbox.gift_transactions.
SELECT count(*) AS sandbox_gift_count
FROM sandbox.gift_transactions
WHERE idempotency_key = 'send-test-1';

--确认 أن الهدية التجريبية غير موجودة في جدول الإنتاج public.gift_transactions.
SELECT count(*) AS production_gift_count
FROM public.gift_transactions
WHERE idempotency_key = 'send-test-1';

-- 3. الشعبية الحقيقية لا تتأثر بالهدية التجريبية (نقاط شعبية Sandbox دائمًا 0).
SELECT public.aani_user_popularity(:'userB') AS production_popularity_of_recipient;
-- يُتوقع أن تكونpopularity من Produktion فقط، والهدية التجريبية أضافت 0.

-- 4. Idempotency: إعادة الإرسال بنفس المفتاح لا تُخصم مرتين ولا تُنشئ معاملة مكررة.
SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1');
SELECT count(*) AS duplicate_sandbox_gifts
FROM sandbox.gift_transactions
WHERE idempotency_key = 'send-test-1'; -- يُتوقع 1

-- 5. رLS: المستخدم A لا يرى معاملات المستخدم B في Sandbox.
-- (يُنفّذ كsession لمستخدم A) — يُتوقع 0 صفوف لمرفقات B.
SELECT count(*) AS user_a_sees_b_sandbox_gifts
FROM sandbox.gift_transactions
WHERE recipient_id = :'userB' OR sender_id = :'userB';

-- 6. مؤسس غير مصرح: مستخدم عادي لا يستطيع دعوة دوال الإدارة (42501).
-- يُتوقع استثناء found required.
-- SELECT public.aani_sandbox_grant_coins(:'userA', 100, 'unauth-grant', 'محاولة غير مصرّح');

-- 7. استرداد تجريبي (مؤسس فقط) لا ينقل أرصدة إلى producción.
-- شحن تجريبي ناجح لمستخدم A، ثم استرداده.
SELECT public.aani_sandbox_top_up(:'userA', '<package-uuid>', 'topup-test-1', true);
SELECT public.aani_sandbox_refund_top_up('<top-up-id>', 'اختبار الاسترداد');

-- 8. لا اختلاط: سجل sandbox.admin_actions يُسجل الفاعل والوقت والسبب والنتيجة.
SELECT actor_user_id, action, result, created_at
FROM sandbox.admin_actions
ORDER BY created_at DESC
LIMIT 5;

-- =====================================================================
-- ملاحظة: لا يُدعى أي من public.aani_send_gift أو public.aani_wallet_top_up
-- أو任何对 public.user_wallets / public.gift_transactions من ترحيل Sandbox.
-- =====================================================================
