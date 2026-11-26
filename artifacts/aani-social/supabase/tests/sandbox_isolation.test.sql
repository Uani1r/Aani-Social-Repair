-- =====================================================================
-- اختبار عزل نظام Sandbox المالي
--
-- ملاحظة التشغيل: هذا الملف يُنفّذ على قاعدة Supabase مباشرة (عبر SQL Editor
-- أو أداة اختبار قاعدية) بعد تطبيق ترحيل
-- supabase/migrations/20270306000000_aani_sandbox_financial.sql.
-- لا يُنفّذ هذا الاختبار في بيئة CI ولا في حاوية التطوير المؤقتة، لأن لا يوجد
-- اتصال بـ Supabase live. الأوامر أدناه تعليمات ومتطلبات موثقة وليست نتائج
-- تنفيذ فعلي. لا يُوصف أي اختبار بأنه "منفذ" أو "ناجح" دون تشغيله على قاعدة حية.
--
-- المتغيرات التي يجب تعيّينها قبل التشغيل (أمثلة):
--   \set userA '00000000-0000-0000-0000-000000000001'
--   \set userB '00000000-0000-0000-0000-000000000002'
--   \set founderUser '00000000-0000-0000-0000-000000000003'
--   \set giftId '<uuid من public.gifts>'
--   \set packageId '<uuid من sandbox.top_up_packages>'
--   \set subPackageId '<uuid من sandbox.subscription_packages>'
--   \set promoPackageId '<uuid من sandbox.promotion_packages>'
--   \set postId '<uuid من public.posts owned by userA>'
-- =====================================================================

-- ------------------------------------------------------------------
-- 0. التأكد من وجود مؤسس في sandbox.founders (يُضاف عبر SQL 측서-side فقط)
-- ------------------------------------------------------------------
-- insert into sandbox.founders (user_id) values (:'founderUser') on conflict do nothing;

-- ------------------------------------------------------------------
-- 1. الرصيد التجريبي يُحسب من سجل sandbox.ledger المستقل، لا من public.user_wallets
-- ------------------------------------------------------------------
-- قبل أي عملية: رصيد sandbox لـ userA = 0.
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_before;

-- منح عملات تجريبية للمستخدم A (المستفيد)، يتم عبر المؤسس فقط.
SELECT public.aani_sandbox_grant_coins(:'userA', 1000, 'grant-test-1', 'اختبار عزل الرصيد'::text);

-- التحقق من أن رصيد sandbox لـ userA أصبح 1000.
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_after_grant;

-- ------------------------------------------------------------------
-- 2. عدم قدرة المستخدم على قراءة رصيد مستخدم آخر (باستثناء المؤسس)
-- ------------------------------------------------------------------
-- userA يحاول قراءة رصيد userB → يُتوقع استثناء 42501 (forbidden).
-- SELECT public.aani_sandbox_balance(:'userB') -- يُنفّذ كجلسة userA → خطأ.

-- المؤسس يستطيع قراءة رصيد أي مستخدم.
-- SELECT public.aani_sandbox_balance(:'userB') -- يُنفّذ كجلسة founderUser → 0 (before grant).

-- ------------------------------------------------------------------
-- 3. عدم قدرة غير المؤسس على المنح والاسترداد (42501)
-- ------------------------------------------------------------------
-- userA يحاول منح عملات → يُتوقع استثناء 42501 (founder required).
-- SELECT public.aani_sandbox_grant_coins(:'userA', 100, 'unauth-grant', 'محاولة غير مصرّح'::text);

-- userA يحاول استرداد شحن غير خاص به → يُتوقع استثناء 42501 أو 42704.
-- SELECT public.aani_sandbox_refund_top_up('<top-up-id-of-userB>', 'محاولة غير مصرّح'::text);

-- ------------------------------------------------------------------
-- 4. إرسال هدية تجريبية: يُخصم من رصيد Sandbox فقط، لا يُسجل في public.gift_transactions
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1');

-- الهدية التجريبية موجودة في sandbox.gift_transactions.
SELECT count(*) AS sandbox_gift_count
FROM sandbox.gift_transactions
WHERE idempotency_key = 'send-test-1';

-- الهدية التجريبية غير موجودة في جدول الإنتاج public.gift_transactions.
SELECT count(*) AS production_gift_count
FROM public.gift_transactions
WHERE idempotency_key = 'send-test-1'; -- يُتوقع 0

-- ------------------------------------------------------------------
-- 5. الشعبية الحقيقية لا تتأثر بالهدية التجريبية (نقاط شعبية Sandbox دائمًا 0)
-- ------------------------------------------------------------------
SELECT public.aani_user_popularity(:'userB') AS production_popularity_of_recipient;
-- يُتوقع أن تكون popularity من الإنتاج فقط (الهدية التجريبية أضافت 0).

-- ------------------------------------------------------------------
-- 6. Idempotency: إعادة الإرسال بنفس المفتاح لا تُخصم مرتين ولا تُنشئ معاملة مكررة
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_send_gift(:'userA', :'userB', :'giftId', 'send-test-1');
SELECT count(*) AS duplicate_sandbox_gifts
FROM sandbox.gift_transactions
WHERE idempotency_key = 'send-test-1'; -- يُتوقع 1

-- ------------------------------------------------------------------
-- 7. RLS: المستخدم A لا يرى معاملات المستخدم B في Sandbox (مقارنة مع رؤيته لمعاملاته الخاصة)
-- ------------------------------------------------------------------
-- (يُنفّذ كجلسة userA)
-- معاملات userA الخاصة تظهر:
SELECT count(*) AS user_a_own_sandbox_gifts
FROM sandbox.gift_transactions
WHERE sender_id = :'userA' OR recipient_id = :'userA';

-- معاملات userB لا تظهر لـ userA (يُتوقع 0):
SELECT count(*) AS user_a_sees_b_sandbox_gifts
FROM sandbox.gift_transactions
WHERE sender_id = :'userB' OR recipient_id = :'userB';

-- ------------------------------------------------------------------
-- 8. الشحن التجريبي: الإ sucesso يضيف رصيد، الفشل لا يضيف
-- ------------------------------------------------------------------
-- شحن ناجح.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-1', true);
-- شحن فاشل (لا يضيف رصيد).
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-2', false);

-- ------------------------------------------------------------------
-- 9. Idempotency الشحن: نفس المفتاح يُعيد نفس النتيجة دون تكرار
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-test-1', true);
SELECT count(*) AS duplicate_top_ups
FROM sandbox.top_ups
WHERE idempotency_key = 'topup-test-1'; -- يُتوقع 1

-- ------------------------------------------------------------------
-- 10. الاسترداد ذري ومقاوم للتكرار: استرداد مرتين لنفس الشحن يُمنع
-- ------------------------------------------------------------------
-- استرداد أول مرة (مؤسس فقط).
SELECT public.aani_sandbox_refund_top_up('<top-up-id-of-topup-test-1>', 'اختبار الاسترداد'::text);
-- استرداد ثاني لنفس الشحن → يُتوقع استثناء (قيد فريد على top_up_id في refunds، أو فحص الحالة).
-- SELECT public.aani_sandbox_refund_top_up('<top-up-id-of-topup-test-1>', 'محاولة مكررة'::text);

-- ------------------------------------------------------------------
-- 11. تفعيل اشتراك تجريبي: Idempotency بالمفتاح نفسه (لا مفتاح عشوائي جديد)
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-test-1');
-- إعادة التفعيل بنفس المفتاح → duplicate=true، لا خصم مكرر.
SELECT public.aani_sandbox_activate_subscription(:'userA', :'subPackageId', 'sub-test-1');
SELECT count(*) AS duplicate_subs
FROM sandbox.subscriptions
WHERE user_id = :'userA' AND package_id = :'subPackageId'; -- يُتوقع 1

-- ------------------------------------------------------------------
-- 12. تجديد اشتراك تجريبي: يقبل p_idempotency_key
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_renew_subscription('<subscription-id>', 'sub-renew-1');
-- إعادة التجديد بنفس المفتاح → تُمنع عبر idempotency (أو تُمرر حسب المنطق).

-- ------------------------------------------------------------------
-- 13. إنشاء حملة ترويجية: التحقق من تطابق نوع الهدف مع الباقة وملكية الهدف
-- ------------------------------------------------------------------
-- ترويج منشور بواسطة مالك المنشور (userA يملك postId)، مع باقة من نوع post.
SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', :'postId', 'promo-test-1');

-- ترويج بمنشور لا يملكه userA (postId appartenant إلى userB) → يُتوقع استثناء 42501.
-- SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', '<post-id-owned-by-userB>', 'promo-test-2');

-- ترويج بنوع غير مطابق للباقة (باقة post، هدف reel) → يُتوقع استثناء 42001.
-- SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId-post', 'reel', :'postId', 'promo-test-3');

-- ------------------------------------------------------------------
-- 14. Idempotency الترويج: نفس المفتاح لا يُنشئ حملة مكررة
-- ------------------------------------------------------------------
SELECT public.aani_sandbox_create_promotion(:'userA', :'promoPackageId', 'post', :'postId', 'promo-test-1');
SELECT count(*) AS duplicate_promos
FROM sandbox.promotions
WHERE idempotency_key = 'promo-test-1'; -- يُتوقع 1

-- ------------------------------------------------------------------
-- 15. عدم تسجيل أي معاملة تجريبية في جداول الإنتاج أو التأثير في الشعبية الحقيقية
-- ------------------------------------------------------------------
-- कोई صف في public.gift_transactions أو public.user_wallets لا يُنشأ من عمليات Sandbox.
-- (التحقق اليدوي عبر استعلامات count أعلاه)

-- ------------------------------------------------------------------
-- 16. إعادة الشحن الفاشل بالمفتاح نفسه: تكرار النتيجة دون إضافة عملات
-- ------------------------------------------------------------------
-- تنفيذ الشحن الفاشل أولاً بمفتاح جديد.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-retry-1', false);
-- تسجيل الرصيد بعد الفشل (يجب ألا يتغير).
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_after_failed_topup;
-- إعادة الطلب بالمفتاح والباقة والمستخدم نفسهما.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-retry-1', false);
-- يُتوقع أن تكون النتيجة الثانية: ok=false, duplicate=true, status=failed.
-- يُتوقع أن يكون عدد سجلات top_ups لهذا المفتاح يساوي واحداً:
SELECT count(*) AS duplicate_failed_top_ups
FROM sandbox.top_ups
WHERE idempotency_key = 'topup-fail-retry-1'; -- يُتوقع 1
-- يُتوقع عدم وجود قيد credit لهذا المفتاح:
SELECT count(*) AS credit_ledger_for_failed_topup
FROM sandbox.ledger
WHERE idempotency_key = 'topup-fail-retry-1:credit'; -- يُتوقع 0
-- يُتوقع أن الرصيد لم يتغير عن قيمته بعد الفشل الأول:
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_after_retry_failed;

-- ------------------------------------------------------------------
-- 17. إعادة استخدام مفتاح شحن فاشل مع طلب ناجح: تعارض 40901
-- ------------------------------------------------------------------
-- تسجيل شحن فاشل أولاً بمفتاح معين.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-then-success', false);
-- إعادة استخدام نفس المفتاح مع p_simulate_success=true → يُتوقع استثناء 40901.
-- SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-fail-then-success', true); -- يُتوقع خطأ 40901

-- ------------------------------------------------------------------
-- 18. إعادة الطلب بمفتاح موجود بعد تعطيل الباقة: تُعاد النتيجة الأصلية
-- ------------------------------------------------------------------
-- شحن ناجح بمفتاح جديد، ثم تعطيل الباقة.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-1', true);
SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_before_deactivation;
-- تعطيل الباقة (يُنفّذ من جهة المسؤول عبر SQL مباشر):
-- update sandbox.top_up_packages set is_active = false where id = :'packageId';
-- إعادة الطلب بالمفتاح نفسه رغم تعطيل الباقة → يُتوقع completed وduplicate=true.
-- SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-1', true);
-- يُتوقع أن الرصيد لم يتغير (لا إضافة عملات مكررة):
-- SELECT public.aani_sandbox_balance(:'userA') AS sandbox_balance_after_deactivated_replay;

-- شحن فاشل بمفتاح جديد، ثم تعطيل الباقة.
SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-2', false);
-- إعادة الطلب بالمفتاح نفسه رغم تعطيل الباقة → يُتوقع failed وduplicate=true.
-- SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-deactivated-pkg-2', false);
-- يُتوقع أن الرصيد لم يتغير ولا يوجد قيد credit مكرر:
-- SELECT count(*) AS credit_ledger_for_deactivated_failed
-- FROM sandbox.ledger
-- WHERE idempotency_key = 'topup-deactivated-pkg-2:credit'; -- يُتوقع 0

-- ------------------------------------------------------------------
-- 19. محاولة شحن جديد بباقة معطّلة: تُرفض
-- ------------------------------------------------------------------
-- شحن جديد بمفتاح جديد وباقة معطّلة → يُتوقع استثناء 'package unavailable' (42704).
-- SELECT public.aani_sandbox_top_up(:'userA', :'packageId', 'topup-new-on-deactivated-1', true); -- يُتوقع خطأ 42704

-- =====================================================================
-- ملاحظة: هذا الاختبار SQL يُDocumente المتطلبات ويُمكّن تشغيله على قاعدة
-- Supabase مباشرة. لا يُدّعى نجاحه دون تنفيذ فعلي على قاعدة حية.
-- =====================================================================
