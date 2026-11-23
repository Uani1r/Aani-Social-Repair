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
   `/api/*   https://<api-host>/api/:splat   200`
2. Netlify يمرّر الطلب كما هو إلى خدمة الـAPI، فيصل إلى `POST /api/media/voice`
   و`GET /api/media/imagekit-auth` مع الترويسات والجسم.
3. بقية المسارات تسقط على قاعدة SPA كما كانت.

## الإعداد

في Netlify: **Site settings → Build & deploy → Environment variables**

```
API_PROXY_TARGET=https://<your-api-host>
```

- عنوان **مثبت** من مالك النشر؛ لا توجد قيمة افتراضية في المستودع.
- `https` فقط، ويُقبل مسار بادئة إن كان الـAPI خلف وسيط.
- الشرطة المائلة الأخيرة والمسافات تُزال تلقائياً؛ أي قيمة غير صالحة تُتجاهل
  ويبقى ملف التوجيه على قاعدة SPA وحدها.

البناء (في `vite.config.ts`) يكتب `_redirects` بعد نسخ `public/`، و`src/lib/netlifyApiProxy.ts`
هو المنطق المختبَر. على Netlify بلا هذا المتغير يظهر تحذير صريح أثناء البناء.

## تحقق يدوي بعد النشر

```bash
# يجب أن يعيد JSON، لا HTML
curl -sS -D- https://<site>.netlify.app/api/media/imagekit-auth
curl -sS -D- https://<site>.netlify.app/api/media/voice
curl -sS -D- https://<site>.netlify.app/api/health

# صورة أو مقطع صوتي من التطبيق نفسه على Netlify
```

عند غياب التوجيه ستعيد المسارات `200 text/html` بصفحة التطبيق؛ وجود
`content-type: application/json` يعني أن التوجيه يعمل.

## ما تم اختباره فعلياً وما لم يُختبر

**مختبَر آلياً** (`src/lib/netlifyApiProxy.test.ts`):

- بلا عنوان: الملف الناتج قاعدة SPA فقط، وبلا أي أصل `https` مخترع.
- بعنوان: قاعدة `/api/*` أولاً ثم SPA، والعنوان يُطبَّع.
- عنوان غير صالح (`http://`، بلا مضيف، مسار نسبي) يُرفض.
- `/api/media/voice` و`/api/media/imagekit-auth` و`/api/media/upload` كلها
  تطابق القاعدة، و`/feed` لا تطابقها.
- الطلبان في المصدر مساران نسبيان على نفس الأصل، بلا مضيف مطلق.
- `public/_redirects` الملتزم لا يحمل أي مضيف API.
- `vite.config.ts` يكتب الملف من `API_PROXY_TARGET`، ورسالتا الخطأ في
  `storyUpload.ts` و`messagesVoiceServer.ts` تذكران المتغير عند عودة HTML.

**لم يُختبر:** طلب حقيقي عبر Netlify إلى Render (لا عنوان إنتاج ولا وصول لسجلات
Netlify)، ولا رفع فعلي من iPhone. الاختبار أعلاه يثبت منطق التوليد والمطابقة،
لا سلوك شبكة Netlify الحيّ.
