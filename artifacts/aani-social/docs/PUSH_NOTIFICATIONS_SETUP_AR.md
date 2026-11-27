# إعداد إشعارات الويب — **متقادم ومؤرشف**

> **لا تتبع هذا الملف.** يصف هذا المستند مسار Push سابقاً: Firebase Web
> Messaging مباشرة، ودالة `send-push-notification` مع Database Webhook،
> ورمز جهاز واحد في `profiles.fcm_token`، ومشروع Firebase القديم `ani1-20bed`.
> أُزيلت تعليماته التشغيلية (الأوامر وخطوات اللوحة وأسماء الأسرار القديمة)
> ولم تعد صالحة.
>
> **الدليل الحالي الوحيد:** [`PUSH_OUTBOX_DEPLOYMENT_AR.md`](./PUSH_OUTBOX_DEPLOYMENT_AR.md)

## ما استُبدل بماذا

| المسار القديم (متقادم) | المسار الحالي |
|---|---|
| `profiles.fcm_token` — جهاز واحد لكل حساب | `public.device_tokens` بعدة أجهزة عبر `aani_register_device_token` |
| Database Webhook على `public.notifications` | `public.notification_outbox` + عامل `push-outbox` |
| دالة `send-push-notification` بسر Webhook | دالة `push-outbox` بترويسة `x-push-worker-secret` |
| مشروع Firebase `ani1-20bed` | مشروع **Ani Social** فقط؛ `ani1-20bed` مرفوض في الكود |

## ما بقي في المستودع دون تغيير

- `supabase/functions/send-push-notification/` — دالة قديمة، **غير منشورة وغير
  مفعّلة**، وإعدادها في `supabase/config.toml` لم يُغيَّر.
- مسار الـWebhook القديم على خادم Render: `api-server/src/routes/pushNotifications.ts`
  (`/api/send-push-notification`) و`api-server/src/lib/notificationContent.ts`.
  لم يُلمس، ولا يُعتمد عليه لأي إشعار جديد.
- `public/firebase-messaging-sw.js` ما زال عامل الخدمة، لكنه يقرأ الآن
  `data.title` و`data.body` و`data.url` من حمولة عامل `push-outbox`،
  مع `payload.notification` كاحتياطي.

## لماذا لا تُستخدم التعليمات القديمة

- كانت تحفظ رمز جهاز واحد لكل حساب، فلا يمكن تفعيل الإشعارات على أكثر من جهاز،
  ولا يُلغى الرمز عند تسجيل الخروج.
- كان الإرسال يعتمد على Webhook من قاعدة البيانات إلى دالة واحدة: بلا طابور،
  بلا إعادة محاولة، وبلا منع تكرار الإرسال إلى الجهاز نفسه.
- كانت توجّه إلى مشروع Firebase القديم `ani1-20bed`.

كل ما يلزم للإعداد والتشغيل — أسماء الأسرار، النشر، الجدولة، الوجهات، وما لم
يُختبر — في [`PUSH_OUTBOX_DEPLOYMENT_AR.md`](./PUSH_OUTBOX_DEPLOYMENT_AR.md).
