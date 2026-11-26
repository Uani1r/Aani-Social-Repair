# Aani Sandbox Financial — نطاق التكامل (PR #116)

هذا المستند يحدّد نطاق PR #116 بدقّة، ويوثّق ما هو منجز وما هو خارج النطاق،
والدوال التي لا تملك واجهة مستخدم مرتبطة، ومتطلبات كشف المخطط السحابي.

## 1) النطاق المعتمد

- **المشروع:** بيئة Sandbox مالية تجريبية معزولة تمامًا عن الإنتاج
  (مخطط `sandbox` منفصل، سجل أرصدة مستقل، لا مساس بـ `public.user_wallets`
  أو `public.gift_transactions` أو `public.aani_user_popularity`).
- **المنجز في هذا الـ PR:** لوحة مؤسس تجريبية فقط
  (`/admin/sandbox` → `AdminSandbox`) للتحقق من الصلاحية، ومنح العملات،
  ومراجعة الشحن/الاسترداد، والاشتراكات، والترويج، والسجلات/التدقيق.
- **خارج نطاق هذا الـ PR:** تجربة Sandbox المخصّصة للمستخدم النهائي
  (شاشة شحن، إرسال هدية، عرض رصيد/اشتراك/حملات المستخدم).
  لم تُنشأ أي واجهات مستخدم إضافية من تلقاء النفس.

## 2) كشف مخطط `sandbox` محليًا (Data API)

- `supabase/config.toml` يضيف `[api].schemas = ["public", "graphql_public", "sandbox"]`
  لإتاحة المخطط محليًا عبر PostgREST، مع الإبقاء على RLS والمنح الحالية
  (لا صلاحيات إضافية لـ anon، لا `GRANT ALL`).
- **تنبيه سحابي مهم:** تعديل `config.toml` وحده **لا** يغيّر إعدادات مشروع
  Supabase مستضاف ولا يُثبت تطبيقها. يجب إضافة `sandbox` يدويًا إلى
  **Dashboard > Project Settings > API > Exposed schemas**.
  لم يُنفَّذ أي اتصال سحابي فعلي في هذا التغيير، ولا يُدّعى ذلك.

## 3) دوال المكتبة/RPC بلا واجهة مستخدم مرتبطة

هذه الدوال موجودة في `src/lib/sandbox.ts` (والـ RPC المقابلة في الترحيل)،
لكن **لا توجد لها صفحة/واجهة مستخدم** في هذا الـ PR — بعضها يُستخدم
داخل لوحة المؤسس فقط، وبعضها مخصّص لتجربة مستخدم غير منجزة بعد:

| الدالة | RPC | لها واجهة؟ |
| --- | --- | --- |
| `topUpSandbox` | `aani_sandbox_top_up` | لا (مستخدم) |
| `sendSandboxGift` | `aani_sandbox_send_gift` | لا (مستخدم) |
| `fetchSandboxGifts` | — (جدول `sandbox.gift_transactions`) | لا (مستخدم) |
| `fetchSandboxBalance` | `aani_sandbox_balance` | لا (مستخدم) |
| `fetchSandboxLedger` (غير `all`) | — | لا (مستخدم؛ تُستخدم `all:true` داخل اللوحة) |
| `fetchSandboxSubscriptions` (غير `all`) | — | لا (مستخدم) |
| `fetchSandboxPromotions` (غير `all`) | — | لا (مستخدم) |
| `fetchSandboxRefunds` (غير `all`) | — | لا (مستخدم) |
| `grantSandboxCoins` | `aani_sandbox_grant_coins` | نعم (لوحة المؤسس) |
| `refundSandboxTopUp` | `aani_sandbox_refund_top_up` | نعم (لوحة المؤسس) |
| `activateSandboxSubscription` | `aani_sandbox_activate_subscription` | نعم (لوحة المؤسس) |
| `cancelSandboxSubscription` | `aani_sandbox_cancel_subscription` | نعم (لوحة المؤسس) |
| `renewSandboxSubscription` | `aani_sandbox_renew_subscription` | نعم (لوحة المؤسس) |
| `createSandboxPromotion` | `aani_sandbox_create_promotion` | نعم (لوحة المؤسس) |
| `endSandboxPromotion` | `aani_sandbox_end_promotion` | نعم (لوحة المؤسس) |
| `fetchSandboxTotals` | `aani_sandbox_totals` | نعم (لوحة المؤسس — إجماليات) |

## 4) الأمان (لا يُعتمد على الواجهة)

- التحقق من هوية المؤسس يتم **خادمجيًا فقط** عبر `aani_sandbox_is_founder()`
  وRLS؛ إخفاء/إظهار عناصر الواجهة ليس ضابط أمان.
- تبديل الحساب: يُعاد تركيب `AdminSandbox` عبر `key={user.id}` حتى لا تبقى
  بيانات مؤسس سابق معروضة بعد تبديل المستخدم.
- الإجماليات المالية تُحسب عبر دالة PostgreSQL تجميعية `aani_sandbox_totals`
  (استعلام SUM واحد، تحقق مؤسس خادمجي، search_path فارغ، EXECUTE لـ authenticated
  فقط) — لا تحميل صفحات ولا اعتماد على ترتيب created_at.

## 5) الاختبارات

- SQL/RLS/التزامن: `supabase/tests/*` عبر `sandbox-financial.yml` (28 اختبار +
  اختبار التزامن مع إثبات انتظار القفل).
- وحدة (TypeScript): `src/lib/sandbox.test.ts` (الإجماليات، تبديل الهوية،
  تخطيط التبويبات، العزل المالي).
- Typecheck/Build: يُشغّلان في `sandbox-financial.yml`.
- التمييز بين المنفّذ وغير المنفّذ موضّح في ملخص التشغيل.