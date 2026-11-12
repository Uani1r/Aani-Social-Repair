# دليل انتقال الوسائط إلى ImageKit.io

نظام رفع وعرض الصور والفيديوهات والريلز يعمل الآن بالكامل عبر
ImageKit.io بدل Supabase Storage. قاعدة البيانات (Supabase) بقيت
كما هي لحفظ روابط المنشورات: `posts.media_url` يحمل رابط ImageKit
النهائي كاملاً.

## المفاتيح المطلوبة (Secrets في Replit)

- `IMAGEKIT_URL_ENDPOINT` — مثل `https://ik.imagekit.io/anisocial`
- `IMAGEKIT_PUBLIC_KEY`
- `IMAGEKIT_PRIVATE_KEY` (سرّي — لا يغادر الخادم أبداً)

## كيف يعمل الرفع؟

1. الواجهة تطلب `GET /api/media/imagekit-auth` (بعد تسجيل الدخول).
2. الخادم الخلفي (`api-server/src/routes/imagekitAuth.ts`) يتحقق من
   جلسة المستخدم ثم يولّد `token` + `expire` + `signature`
   (HMAC-SHA1 بالمفتاح الخاص) ويُرجعها مع `urlEndpoint` و`publicKey`.
3. المتصفح يرفع الملف مباشرة إلى `https://upload.imagekit.io/api/v1/files/upload`
   مع التوقيع (بلا مرور بالخادم) مع نسبة تقدم حقيقية.
4. الرابط الناتج (`url` من استجابة ImageKit) يُخزَّن في `posts.media_url`
   و`media_assets.video_url` كما هو — بدون أي تحويل.

## نقاط التكامل في الكود

- `src/lib/imagekitUpload` منطق الرفع يعيش داخل `src/lib/storyUpload.ts`
  (`uploadMedia` / `uploadStoryMedia`) — الأداة الموحدة التي تستخدمها
  المنشورات والريلز والستوريز والمحادثات والصور الشخصية.
- `src/lib/supabase.ts` يدير سجل «مسار الرفع → رابط ImageKit»، فيعيد
  أي استدعاء لـ `getPublicUrl(path)` رابط ImageKit الحقيقي للملفات
  المرفوعة حديثاً، مع بقاء الصفوف القديمة (مسارات Supabase) تعمل.
- `postMedia.ts` يمرر روابط `https://` كما هي، فروابط ImageKit تُعرض
  في المشغلات (ReelSlide / ProfileReelsPlayer / PostVideoPreview)
  دون أي تعديل أو قيود.
- المعالجة الخلفية بـ FFmpeg (`/api/media/process`) لم تعد تُستدعى
  للروابط الجديدة: ImageKit يدير التحسين والتشغيل بنفسه. المسار يبقى
  للروابط القديمة على Supabase Storage فقط.
