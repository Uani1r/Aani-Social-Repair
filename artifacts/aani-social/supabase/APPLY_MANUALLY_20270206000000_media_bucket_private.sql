-- =====================================================================
-- تحويل bucket الوسائط إلى private — خطوة يدوية، لا تُنفَّذ تلقائياً.
--
-- لماذا يدوياً: bucket aani-media عام (schema.sql سطر 510-514). في bucket عام
-- تُخدم الملفات من مسار /storage/v1/object/public/... بلا RLS، فأي شخص يملك
-- الرابط المباشر يفتح الملف ولو لم يكن يحق له قراءة المنشور. سياسة
-- aani_media_objects_read_guard (20270206000000) تحمي مسار Storage API فقط،
-- ولا تنفذ على المسار العام.
--
-- تنفيذ هذا الملف يقفل الرابط المباشر نهائياً، لكنه يُبطل كل الروابط
-- المخزّنة في قاعدة البيانات (media_url, media_urls, audio_url, avatar_url,
-- cover_url, stories.media_url, profile_highlights.media_url, ...) لأنها
-- مكتوبة بصيغة /object/public/. فلا تُنفّذه قبل أن يكون العميل المنشور
-- قادراً على تحويل المسارات إلى روابط موقّعة.
--
-- الترتيب الآمن:
--   1. طبّق 20270206000000 (الدالة والسياسة).
--   2. تأكد أن العميل الجديد (createSignedUrl عبر resolveMediaUrl) منشور
--      للمستخدمين، وأنه يُعيد الروابط الموقّعة لكل عرض وسائط.
--   3. بعدها نفّذ هذا الملف.
--   4. اختبر: صورة منشور عادي تُعرض، ووسائط منشور حساب خاص لا تُفتح لغير
--      المتابع المعتمد ولو بالرابط القديم.
--   5. إن احتجت التراجع: set public = true في الخطوة 1 بالعكس.
-- =====================================================================

begin;

-- 1) اجعل الـbucket خاصاً
update storage.buckets
set public = false
where id = 'aani-media';

-- 2) سياسة القراءة: تبقى aani_media_objects_read_guard restrictive من
--    20270206000000، وتُضاف سياسة متساهلة صريحة حتى لا تعتمد القراءة على
--    سياسات أخرى قد تُحذف. (سياسة restrictive وحدها لا تمنح شيئاً.)
drop policy if exists "Aani media is readable by signed-in users" on storage.objects;
create policy "Aani media is readable by signed-in users"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'aani-media'
    and public.aani_can_read_media_object(name)
  );

commit;

-- =====================================================================
-- تحقق بعد التنفيذ
-- =====================================================================
-- 1) الـbucket خاص
--    select id, public from storage.buckets where id = 'aani-media';
--
-- 2) رابط قديم بصيغة /object/public/ لم يعد يفتح الملف (يُعيد 400/404)
--    curl -I "https://<project>.supabase.co/storage/v1/object/public/aani-media/<path>"
--
-- 3) رابط موقّع يعمل لحساب يملك حق القراءة
--    select storage.create_signed_url('aani-media', '<path>', 60);
