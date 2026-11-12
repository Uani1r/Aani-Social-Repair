# دليل الانتقال إلى Cloudflare R2 + قاعدة بيانات Supabase جديدة

هذا الدليل يشرح كيفية استخدام الملف المُجهّز:
[supabase/fresh_schema_cloudflare_r2.sql](../supabase/fresh_schema_cloudflare_r2.sql)

## ما الذي يفعله السكربت؟

ملف SQL واحد نظيف لمشروع Supabase **جديد فارغ** ينشئ:

- `profiles` بكل أعمدة الملف الشخصي والخصوصية.
- `posts` بكل الأعمدة التي يطلبها استعلام الواجهة فعلياً
  (`media_url`, `media_urls`, `media_asset_id`, `type`, `destination`,
  `likes_count`, `comments_count`, `reposts_count`, `shares_count`,
  `comments_disabled`, `audio_url`, `audio_title`, `sound_id`,
  `sound_trim_start/end`, `trim_start/end`, `hide_likes`, `hide_comments`,
  `comment_privacy`, `tagged_user_ids` …) — بحيث لا يعيد PostgREST أي خطأ
  `42703` أو `PGRST204`.
- `media_assets` (سجل معالجة الفيديو) وترابطه مع `posts`.
- `likes`, `comments`, `comment_likes`, `comment_dislikes`, `follows`,
  `bookmarks`, `reposts`, `post_shares`, `post_feedback`, `reports`, `sounds`.
- `messages`, `message_reactions`, `message_conversation_settings`.
- `notifications`, `stories`, `story_likes`, `story_views`, `story_mentions`.
- Triggers العدّادات التلقائية، دالة إنشاء الملف الشخصي عند التسجيل،
  RLS كاملة لكل الجداول، وGRANT لكل عمود يقرؤه التطبيق.

**لا يوجد أي قسم Supabase Storage** عن قصد: كل روابط الوسائط تُخزَّن كعناوين
R2 عامة كاملة في `posts.media_url` / `media_assets.video_url`.

## خطوات التشغيل

1. أنشئ مشروع Supabase جديداً.
2. افتح **SQL Editor** → الصق محتوى `fresh_schema_cloudflare_r2.sql` كاملاً → Run.
3. تحقق سريع:
   ```sql
   select table_name, count(*) from information_schema.columns
   where table_schema = 'public' group by table_name order by table_name;
   ```
4. في Replit Secrets أضف مفاتيح المشروع الجديد (انظر `.env.example`).

## متغيرات البيئة المطلوبة

### الواجهة (Vite — قيم عامة فقط)

- `VITE_SUPABASE_URL` — رابط المشروع الجديد.
- `VITE_SUPABASE_ANON_KEY` أو `VITE_SUPABASE_PUBLISHABLE_KEY`.
- `VITE_R2_PUBLIC_URL` — الرابط العام لـ bucket الـ R2
  (مثل `https://pub-xxxx.r2.dev` أو دومين مخصص).

### السيرفر الخلفي (api-server — سرّية)

- `SUPABASE_URL` — المشروع الجديد.
- `SUPABASE_SERVICE_ROLE_KEY` — مفتاح service_role للمشروع الجديد.
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL`

## ملاحظة عن ربط الواجهة

لا يحتاج السكربت أي تعديل في شاشات أو أزرار التطبيق: معالج روابط الوسائط
(`src/lib/postMedia.ts`) يمرر أي رابط يبدأ بـ `https://` كما هو، لذا روابط
R2 الكاملة تُعرض مباشرة بدون تحويل. التعديلات المطلوبة لاحقاً في الكود
(رفع عبر Presigned URL من `api-server` بدل `supabase.storage`) موثقة في
خطة المراحل داخل محادثة الفريق، وتُنفذ بعد تشغيل السكربت بنجاح.
