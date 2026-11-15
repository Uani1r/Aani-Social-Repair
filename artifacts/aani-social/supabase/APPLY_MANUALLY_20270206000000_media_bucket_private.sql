-- =====================================================================
-- تحويل bucket الوسائط إلى private — خطوة يدوية، لا تُنفَّذ تلقائياً.
--
-- تنبيه مهم: القاعدة الحيّة لا تحتوي bucket باسم aani-media (كل الرفع الحالي
-- يذهب إلى ImageKit). تنفيذ هذا الملف على قاعدة بلا هذا الـbucket لا يفعل
-- شيئاً: UPDATE يطابق صفر صفوف، و CREATE POLICY على storage.objects ينجح لكنه
-- لا يحمي أي ملف. لذلك يبدأ الملف بفحص وجود الـbucket ويُعلن النتيجة بوضوح،
-- ولا يدّعي نجاح التحويل إن لم يوجد.
--
-- لماذا هذا الملف مطلوب أصلاً: bucket aani-media (إن وُجد، من schema.sql سطر
-- 510-514) عام، وفي bucket عام تُخدم الملفات من /storage/v1/object/public/...
-- بلا RLS. سياسة aani_media_objects_read_guard (20270206000000) تحمي مسار
-- Storage API فقط، ولا تنفّذ على المسار العام.
--
-- تنفيذ هذا الملف (على قاعدة فيها الـbucket) يقفل الرابط المباشر، لكنه يُبطل
-- كل الروابط المخزّنة بصيغة /object/public/ (media_url, media_urls, audio_url,
-- avatar_url, cover_url, stories.media_url, profile_highlights.media_url ...).
-- فلا تُنفّذه قبل أن يكون العميل الذي يوقّع المسارات (resolveMediaUrl في
-- src/lib/mediaAccess.ts) منشوراً للمستخدمين.
--
-- الترتيب الآمن:
--   1. طبّق 20270206000000 (الدوال والسياسات).
--   2. انشر العميل الذي يعرض روابط موقّعة.
--   3. نفّذ هذا الملف — ويخبرك صراحةً هل الـbucket موجود أم لا.
--   4. اختبر: صورة منشور عادي تُعرض، ووسائط منشور حساب خاص لا تُفتح لغير
--      المتابع المعتمد ولو بالرابط القديم.
--   5. للتراجع: update storage.buckets set public = true where id = 'aani-media';
-- =====================================================================

begin;

do $$
declare
  bucket_exists boolean;
begin
  select exists (select 1 from storage.buckets where id = 'aani-media') into bucket_exists;

  if not bucket_exists then
    raise warning
      'لا يوجد bucket باسم aani-media في هذه القاعدة: لم يُحوَّل أي شيء. الوسائط كلها على ImageKit — راجع docs/PRIVATE_MEDIA_AR.md (توقيع ImageKit) بدل هذا الملف.';
    return;
  end if;

  -- 1) اجعل الـbucket خاصاً
  update storage.buckets
  set public = false
  where id = 'aani-media';

  -- 2) سياسة قراءة متساهلة صريحة تعتمد على القرار الأمني.
  --    (سياسة restrictive وحدها لا تمنح شيئاً.)
  execute 'drop policy if exists "Aani media is readable by signed-in users" on storage.objects';
  execute $policy$
    create policy "Aani media is readable by signed-in users"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'aani-media'
        and public.aani_can_read_media_object(name)
      )
  $policy$;

  raise notice 'تم تحويل bucket aani-media إلى private وتحديث سياسة القراءة.';
end $$;

commit;

-- =====================================================================
-- تحقق بعد التنفيذ
-- =====================================================================
-- 1) هل الـbucket موجود، وهل أصبح خاصاً؟ (صفر صفوف = لا bucket)
--    select id, public from storage.buckets where id = 'aani-media';
--
-- 2) إن وُجد: رابط قديم بصيغة /object/public/ يجب أن يُرفض (400/404)
--    curl -I "https://<project>.supabase.co/storage/v1/object/public/aani-media/<path>"
--
-- 3) إن وُجد: رابط موقّع يعمل لحساب يملك حق القراءة
--    select storage.create_signed_url('aani-media', '<path>', 60);
