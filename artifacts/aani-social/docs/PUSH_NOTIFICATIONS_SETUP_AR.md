# إعداد إشعارات الويب عبر Firebase Cloud Messaging

يتطلب هذا التكامل إعداداً لمتصفح الويب، ودالة Supabase Edge، وWebhook على جدول الإشعارات. لا تُضمّن مفتاح Service Account في ملفات الواجهة أو Git.

## 1. تدوير مفتاح الخدمة المكشوف

مفتاح Service Account الذي أُرسل في المحادثة أصبح مكشوفاً. أبطله في Google Cloud Console وأنشئ مفتاحاً جديداً قبل تفعيل الإرسال. لا ترسل المفتاح الجديد في المحادثة ولا تضعه في المستودع.

## 2. إعداد Firebase للويب

في Firebase Console للمشروع `ani1-20bed`:

1. أضف تطبيق Web أو افتح إعداداته وانسخ إعدادات الويب العامة: `apiKey` و`authDomain` و`projectId` و`messagingSenderId` و`appId`.
2. من إعدادات Cloud Messaging أنشئ/انسخ Web Push certificate key (VAPID).
3. أضف القيم كمتغيرات بناء `VITE_FIREBASE_*` الموضحة في `artifacts/aani-social/.env.example` أو أسرار منصة النشر. القيم العامة للويب ليست مفتاح Service Account.
4. أعد بناء ونشر التطبيق بعد تعديل متغيرات `VITE_`.

يحمّل التطبيق وحدات Firebase Web SDK 13.0.0 من CDN الرسمي، ويسجل `public/firebase-messaging-sw.js` مع إعدادات تطبيق الويب العامة كي يعالج Firebase رسائل الخلفية. يجب فتح الموقع عبر HTTPS. على iPhone/iPad يتطلب Web Push عادةً إضافة الموقع إلى الشاشة الرئيسية ودعمه بإصدار iOS حديث.

## 3. ترحيل قاعدة البيانات

طبّق يدوياً على مشروع Supabase:

- `supabase/migrations/20261227000000_fcm_push_notifications.sql` لإضافة `profiles.fcm_token`.
- طبّق أيضاً `supabase/migrations/20261226000000_message_notifications.sql` لتوليد إشعارات الرسائل اللازمة لدفعها إلى FCM.

بعد تسجيل الدخول، افتح الإشعارات واضغط «تفعيل» للسماح للمتصفح، وإنشاء FCM Token، وحفظه في ملف المستخدم.

## 4. أسرار Supabase Edge Function

انشر الدالة من مجلد التطبيق باستخدام Supabase CLI (مع معرّف المشروع الصحيح)، ثم خزّن في Edge Function Secrets:

`supabase functions deploy send-push-notification --project-ref <project-ref>`

- `FIREBASE_SERVICE_ACCOUNT`: محتوى JSON لمفتاح Service Account الجديد بعد تدويره. تقبل الدالة أيضاً الاسم القديم `FCM_SERVICE_ACCOUNT_JSON`.
- `PUSH_WEBHOOK_SECRET`: سلسلة عشوائية طويلة تُنشأ خارج المستودع؛ يجب وضعها في أسرار الدالة وفي ترويسة الـ Webhook نفسها.

تستخدم الدالة `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` من أسرار Supabase الافتراضية. لا تخزّن هذه القيم في الواجهة أو ملفات Git.

## 5. إعداد Database Webhook

من Supabase Dashboard > Database > Webhooks أنشئ Webhook:

- الجدول: `public.notifications`
- الحدث: `INSERT`
- الطريقة: `POST`
- الرابط: `https://<project-ref>.supabase.co/functions/v1/send-push-notification`
- الترويسة: `x-push-webhook-secret: <نفس قيمة PUSH_WEBHOOK_SECRET>`
- نوع المحتوى: `application/json`

إعداد الدالة يعطّل تحقق JWT عند بوابة Supabase لأن استدعاء قاعدة البيانات ليس جلسة مستخدم؛ وتتحقق الدالة بدلاً من ذلك من الترويسة السرية. لا تجعل قيمة الترويسة عامة.

## توجيه النقر

تفتح الإعجابات المنشور، والتعليقات المنشور مع لوحة التعليقات، والمتابعة المباشرة ملف المتابع، وطلبات المتابعة قائمة الطلبات المعلقة، والرسائل محادثة المرسل. إشعار المكالمة يعيد إظهار المكالمة الواردة فقط إذا كانت لا تزال نشطة في جلسة الاتصال؛ لا تحفظ الإشعارات بيانات WebRTC لإحياء مكالمة انتهت.

لم يُطبّق الترحيل أو تُنشر الدالة أو يُنشأ Webhook تلقائياً من هذا المستودع؛ يلزم تنفيذ خطوات لوحة التحكم أعلاه. لا يمكن اختبار الإرسال قبل توفير إعداد الويب ومفتاح الخدمة الجديد وتطبيق الترحيل.
