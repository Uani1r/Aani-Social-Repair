# إرسال إشعارات الدفع إلى كل الأجهزة — عامل `push-outbox`

الفرع: `feat/fcm-multidevice-outbox-delivery` — الأساس: `main` عند `2493a1c`.

## الحالة: لا شيء منشور ولا مطبَّق

- **لم يُطبَّق** ترحيل `20270313000000_notification_outbox_deliveries.sql` على أي مشروع Supabase.
- **لم تُنشر** دالة `push-outbox`، ولا ضُبط أي سر في Supabase أو Firebase.
- لا تغيير في إعدادات مشروع **Ani Social** ولا في `supabase_migrations.schema_migrations`.
- الترحيلات التي يلزم تطبيقها بالترتيب قبل هذه الدالة (بعد المراجعة فقط):

```text
20270312000000_device_tokens.sql
20270312000001_notification_outbox.sql
20270312000002_notification_push_outbox_triggers.sql
20270313000000_notification_outbox_deliveries.sql
```

## ما تفعله الدالة

1. **حجز** دفعة مهام من `public.notification_outbox` عبر
   `aani_claim_notification_outbox` (`FOR UPDATE SKIP LOCKED`): عاملان لا
   يعالجان المهمة نفسها.
2. **ضمان** صف تسليم لكل جهاز نشط للمستلم عبر
   `aani_ensure_notification_deliveries`: صف واحد لكل (مهمة، جهاز) بمفتاح فريد
   `(outbox_id, device_token_id)`، فلا يتكرر الإرسال إلى الجهاز نفسه.
3. **إرسال** FCM HTTP v1 إلى كل صف ما زال `pending` فقط.
4. **إنهاء** كل صف عبر `aani_complete_notification_delivery`:
   - نجاح → `sent` (+ معرّف رسالة المزوّد).
   - فشل مؤقت (408/429/5xx/انقطاع) → يبقى `pending`، والمهمة `failed` مع
     تأخير Backoff.
   - رمز غير صالح (404 / INVALID_ARGUMENT) → `skipped` وإلغاء الرمز
     (`device_tokens.revoked_at`)، والسجل لا يُحذف.
   - رفض نهائي (403 وغيره) → `failed` بلا إعادة محاولة.
5. **إنهاء المهمة** بـ`aani_complete_notification_outbox` من العامل صاحب القفل.

إعادة المحاولة ترسل فقط إلى الأجهزة التي لم تنجح: الجهاز الذي وصله الإشعار
(`sent`) لا يدخل في قائمة `pending` أبداً.

## ما لا تحمله الحمولة ولا السجلات

- حمولة FCM: معرّفات ونوع فقط (`message_id`, `sender_id`, `call_id`, `type`,
  `notification_id`, `reference_id`) وعنوان/نص عامان ثابتان.
- لا نص رسالة، ولا وسائط، ولا محتوى منشور في أي حمولة أو سجل.
- السجلات تحمل `task_id` و`event_type` وأعداداً (`devices`, `sent`, `skipped`,
  `failed`) فقط: لا رموز أجهزة، ولا أسرار، ولا نص.

## أنواع الإشعارات

| النوع | Push | صف في `public.notifications` |
|---|---|---|
| إشعار اجتماعي (like/comment/follow/…) | نعم، بعنوان الفئة | نعم، عبر trigger الإشعارات القائم |
| رسالة خاصة | نعم، بعنوان عام «رسالة جديدة» | **لا** — لا يتغيّر أي منطق Realtime للمحادثة |
| مكالمة | نعم، بعنوان «مكالمة واردة» | **لا** |

رموز المباني القديمة (`message`, `new_message`, `chat_message`, `call`,
`incoming_call`, `missed_call`) تبقى ممنوعة من قائمة الإشعارات العامة.

## متغيرات البيئة المطلوبة (أسماء فقط — القيم لا تُوضع في المستودع)

| الاسم | ماذا يوضع فيه | من أين |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON كامل لحساب خدمة مشروع **Ani Social** | Firebase Console → Project settings → Service accounts → Generate new private key |
| `FIREBASE_PROJECT_ID` | معرّف مشروع **Ani Social** كما في Console | Firebase Console → Project settings → Project ID |
| `PUSH_WORKER_SECRET` | سر عشوائي طويل يتحقق منه العامل | يُنشأ عندك ويُخزَّن في الخزنة فقط |
| `PUSH_WORKER_NAME` | اسم العامل في `locked_by` (افتراضي `push-outbox-edge`) | اختياري |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Supabase → Project settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | مفتاح service_role (خادم فقط) | Supabase → Project settings → API |

**لا** يُستخدم المشروع القديم `ani1-20bed` ولا يُستنتج معرّف المشروع من رقم
المشروع `742633618169`: العامل يرفض معرّف المشروع القديم صراحةً.

## النشر (بعد المراجعة والموافقة فقط)

```bash
# الأسرار تُضبط من الخزنة، لا من ملف في المستودع
supabase secrets set PUSH_WORKER_SECRET=... FIREBASE_PROJECT_ID=... \
  FIREBASE_SERVICE_ACCOUNT=... PUSH_WORKER_NAME=push-outbox-edge

supabase functions deploy push-outbox --no-verify-jwt
```

`--no-verify-jwt` لأن العامل لا يعمل بجلسة مستخدم: الحماية هي ترويسة
`x-push-worker-secret` ومقارنتها بثبات زمني، وغياب السر يُرجع 503.

## الجدولة

- Cron كل دقيقة (أو كل 30 ثانية):

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/push-outbox" \
  -H "x-push-worker-secret: <PUSH_WORKER_SECRET>"
```

- الاستجابة: `{"ok":true,"claimed":…,"sent":…,"skipped":…,"failed":…,"completed":…}`
  — بلا رموز ولا أسرار.
- عامل بدأ ولم يُنهِ (انقطاع) لا يعلّق المهمة: قفل الحجز ينتهي بعد دقيقتين
  وتعود المهمة لعامل آخر، وصفوف التسليم `sent` تمنع تكرار الإرسال.

## المنصات

- **الويب** (Chrome/Edge/Safari 16+): Firebase Web Messaging + عامل الخدمة
  `public/firebase-messaging-sw.js` (يُسجَّل بعد تسجيل الدخول فقط).
- **Android Chrome/PWA**: عبر Web Push نفسه (FCM HTTP v1 إلى رمز الويب).
  **لا يوجد مشروع Android أصلي في المستودع**، فلا يُدَّعى دعم FCM الأصلي.
- **iOS**: مؤجّل (APNs/PushKit/CallKit) — لا رمز ولا إذن ولا تغيير في
  `Info.plist` هنا.

التسجيل من العميل في `src/lib/pushNotifications.ts` عبر
`aani_register_device_token` فقط (لا `profiles.fcm_token`)، والإلغاء عند تسجيل
الخروج عبر `aani_revoke_device_token` (`revoked_at`، بلا حذف).

## ما لم يُختبر

- إرسال FCM حقيقي (لا مفاتيح ولا حساب خدمة في هذه البيئة).
- وصول إشعار إلى جهاز فعلي (ويب أو Android PWA).
- iOS: غير منفَّذ.
- التسجيل متعدد الأجهزة على أجهزة حقيقية: يُغطّى باختبارات SQL وDeno فقط.


## إغلاق ثغرة إلغاء الجهاز عند تسجيل الخروج

كان تسجيل الخروج ينهي جلسة Supabase وحدها، فيبقى صف الجهاز نشطاً في
`public.device_tokens` (`revoked_at is null`) ويستمر عامل الإرسال في دفع
إشعارات الحساب السابق إلى هذا الجهاز.

**المسار الآن** (`src/lib/pushSignOut.ts`، ويُستدعى من `useAppSession.signOut`):

1. قراءة معرّف المستخدم من الجلسة ومعرّف تثبيت هذا المتصفح.
2. `aani_revoke_device_token` بمعرّف التثبيت وحده → `revoked_at = now()`.
3. إنهاء الجلسة (محلي أو عام) — لا يُستدعى قبل نجاح الإلغاء.

- لا جلسة أو لا جهاز مسجّل محلياً → لا نداء للإلغاء، وإنهاء الجلسة وحده.
- فشل الإلغاء → لا يُعرض كنجاح، والجلسة تبقى قائمة، والحالة المحلية
  (معرّف التثبيت) تبقى كما هي، وتظهر رسالة تُطلب فيها إعادة المحاولة.
- فشل إنهاء الجلسة بعد إلغاء ناجح → يُبلَّغ عنه بوضوح (الرمز أُلغي فعلاً).

**بقية المسارات:**

| المسار | السلوك |
|---|---|
| `Shell` (زر الخروج في الإعدادات) | يفوّض إلى `useAppSession.signOut`؛ أُزيلت كتابة `profiles.fcm_token` القديمة |
| `ProfilePage.endCurrentSession` | إلغاء رمز هذا الجهاز ثم الجلسة المحلية |
| تعطيل الحساب (`ProfilePage` و`AccountSettingsPanel`) | تعطيل على الخادم، ثم إلغاء رمز هذا الجهاز، ثم الجلسة المحلية؛ فشل الإلغاء يُعرض كخطأ |
| حذف الحساب نهائياً | لا إلغاء: صفوف الأجهزة تُحذف بالتسلسل مع صف الحساب (`on delete cascade`)، ثم إنهاء الجلسة المحلية |
| «تسجيل الخروج من جميع الأجهزة الأخرى» | **لا يلمس** `device_tokens` إطلاقاً: لا تُلغى رموز أجهزة أخرى |
| تبديل الحسابات | `aani_register_device_token` نفسها تُلغي ربط الحساب السابق للرمز/التثبيت نفسه داخل معاملة واحدة قبل تسجيل الحساب الجديد (مُثبت في `notifications_tests`/`notifications_foundation.test.sql` §2) |

**نقاط لم تُعالج وأثرها معلن:**

- «الخروج من جميع الأجهزة الأخرى» ينهي جلساتها ولا يُلغي رموزها: لا رابط بين
  `auth.sessions` و`device_tokens` اليوم، فتبقى تلك الأجهزة مستهدفة بالإرسال
  حتى تسجّل خروجها أو يُلغى رمزها. المعالجة تحتاج عمود ربط جلسة أو دالة
  إلغاء جماعية — تغيير تصميمي يحتاج موافقة.
- لا استدعاء لـ`deleteToken` من Firebase Web Messaging عند الخروج: الإيقاف
  الفعلي للإرسال يأتي من `revoked_at` على الخادم، لأن `ensure` لا يقرأ إلا
  الأجهزة غير الملغاة.
- تسجيل جهاز جديد بعد الخروج يحتاج تفاعل المستخدم (زر التفعيل)، فلا يُطلب
  الإذن تلقائياً.
