# توجيه `/api` من Netlify إلى خدمة الـAPI

## المشكلة

الواجهة تطلب كل ما يخص الخادم من **نفس أصل الصفحة**:

| الطلب | الموضع في المصدر |
|---|---|
| `GET /api/media/imagekit-auth` | `src/lib/storyUpload.ts` — توقيع رفع الصور والفيديو والرسائل الصوتية |
| `POST /api/media/voice` | `src/lib/messagesVoiceServer.ts` — تحويل الرسالة الصوتية على الخادم |
| `POST /api/media/upload` | الرفع الاحتياطي للوسائط |
| `GET /api/media/imagekit-sign` | توقيع عرض الوسائط عند تفعيله |

`netlify.toml` (الجذر وهذه الحزمة) ينشر ملفات ثابتة فقط، و`public/_redirects`
يحتوي قاعدة واحدة:

```
/*   /index.html   200
```

## تتبّع المسار فعلياً

**على Netlify (بلا توجيه):**

1. المتصفح يطلب `https://<site>.netlify.app/api/media/imagekit-auth`.
2. لا يوجد ملف بهذا الاسم، فتلتقطه قاعدة `/​*` وتعيد `index.html` بحالة **200**.
3. `fetchImageKitAuth` يجرّب `response.json()` فيفشل (HTML)، ويُرفع خطأ عام.
4. النتيجة: **لا توقيع رفع**، فلا صور ولا فيديو ولا صوت — لا علاقة لذلك بـImageKit.

**على Render (الدوكر):**

1. `src/app.ts` يركّب `app.use('/api', router)`، وفيه `imagekitAuthRouter` و`mediaVoiceRouter`.
2. نفس الأصل، فتعمل المسارات بلا أي توجيه إضافي.

**مع قاعدة التوجيه:**

1. البناء يكتب `_redirects` في `dist/public` بقاعدة `/api/*` أولاً:
   `/api/*   https://aani-social-repair.onrender.com/api/:splat   200`
2. Netlify يمرّر الطلب كما هو إلى خدمة الـAPI، فيصل إلى `POST /api/media/voice`
   و`GET /api/media/imagekit-auth` مع الترويسات والجسم.
3. بقية المسارات تسقط على قاعدة SPA كما كانت.

## الإعداد

**لا حاجة لأي إعداد في Netlify.** العنوان الافتراضي المُلتزم في
`src/lib/netlifyApiProxy.ts` (`DEFAULT_API_PROXY_TARGET`) هو عنوان الخدمة
المؤكَّد من مالك النشر:

```
https://aani-social-repair.onrender.com
```

- لتجاوز العنوان (بيئة أخرى مثلاً) اضبط في
  **Site settings → Build & deploy → Environment variables**:
  `API_PROXY_TARGET=https://<other-api-host>`
- `https` فقط، ويُقبل مسار بادئة إن كان الـAPI خلف وسيط.
- الشرطة المائلة الأخيرة والمسافات تُزال تلقائياً؛ أي قيمة غير صالحة تُتجاهل
  ويُستخدم العنوان الافتراضي (مع تحذير أثناء البناء).

البناء (في `vite.config.ts`) يكتب `_redirects` في `dist/public` بعد نسخ `public/`،
و`src/lib/netlifyApiProxy.ts` هو المنطق المختبَر. يُكتب الملف في `writeBundle`
و`closeBundle` معاً حتى لا تطمسه نسخة `public/` أياً كان ترتيب Vite.

## تحقق يدوي بعد النشر

```bash
# يجب أن يعيد JSON، لا HTML
curl -sS -D- https://<netlify-site>/api/health
curl -sS -D- https://<netlify-site>/api/media/imagekit-auth   # 401 JSON بلا جلسة
curl -sS -D- https://<netlify-site>/api/media/voice          # JSON من GET
```

عند غياب التوجيه ستعيد المسارات `200 text/html` بصفحة التطبيق؛ وجود
`content-type: application/json` يعني أن التوجيه يعمل.

## ما تم اختباره فعلياً وما لم يُختبر

**مختبَر آلياً** (`src/lib/netlifyApiProxy.test.ts`، 11 اختباراً):

- العنوان الافتراضي هو العنوان المؤكَّد بالضبط.
- القاعدة المولَّدة: `/api/*` أولاً ثم SPA، ولا أصل آخر في الملف.
- تجاوز العنوان بالمتغير، ووقوع القيمة غير الصالحة على الافتراضي.
- تطبيع العنوان، ورفض `http://` وما ليس بعنوان.
- `/api/media/voice` و`/api/media/imagekit-auth` و`/api/media/upload` و`/api/health`
  تطابق القاعدة، و`/feed` و`/apiary` لا تطابقها.
- الطلبان في المصدر مساران نسبيان على نفس الأصل، بلا مضيف مطلق.
- `public/_redirects` الملتزم لا يحمل أي مضيف.
- `vite.config.ts` يحلّ الهدف ويكتب الملف، ورسالتا الخطأ في `storyUpload.ts`
  و`messagesVoiceServer.ts` تذكران المتغير عند عودة HTML.

**مختبَر حياً على خدمة الـAPI مباشرة** (2026، بعد تلقي العنوان من المالك):

- `GET https://aani-social-repair.onrender.com/api/health` →
  `application/json` مع `{"success":true,"status":"ok","serverBuildVersion":"2027-01-24-hmac-signature-v6"}`.
- `GET https://aani-social-repair.onrender.com/api/media/imagekit-auth` →
  **401** مع `application/json` و`{"success":false,"error":"Authentication is required."}`
  (المسار موجود ويعيد JSON لا HTML).

**لم يُختبر:** رفع فعلي من iPhone، ولا طلب حقيقي عبر مضيف Netlify في هذه
الجلسة (معاينة Netlify محمية بـ401)، ولا سجلات Netlify. التحقق الحي عبر
Netlify يحتاج فتح الموقع ونفيذ أوامر `curl` أعلاه بعد النشر.

