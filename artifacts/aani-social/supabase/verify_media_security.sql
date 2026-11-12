-- تحقق (قراءة فقط) من صلاحيات دوال الوسائط وتغطية فحص المراجع.
-- شغّله في Supabase SQL Editor:
--   قبل تطبيق ترحيل 20270125000000: تتوقع رؤية PUBLIC في القائمة (الفجوة).
--   بعده: يجب أن تظهر service_role فقط — لا PUBLIC ولا anon ولا authenticated.

-- 1) صلاحيات التنفيذ على دوال SECURITY DEFINER للوسائط
select
  p.proname as function_name,
  pg_get_userbyid(a.grantee) as grantee,
  a.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
where n.nspname = 'public'
  and p.proname in (
    'aani_claim_media_deletion_jobs',
    'aani_enqueue_media_deletion_job',
    'aani_queue_deleted_media',
    'aani_queue_media_if_replaced',
    'aani_queue_deleted_message_media',
    'aani_cleanup_expired_media_records'
  )
order by 1, 2, 3;

-- 2) وجود الجداول والأعمدة التي يعتمد عليها فحص المراجع (mediaInActiveUse)
select
  to_regclass('public.posts') is not null as has_posts,
  to_regclass('public.stories') is not null as has_stories,
  to_regclass('public.profile_highlights') is not null as has_profile_highlights,
  to_regclass('public.profile_highlight_collections') is not null as has_highlight_collections,
  to_regclass('public.sounds') is not null as has_sounds,
  to_regclass('public.messages') is not null as has_messages,
  to_regclass('public.profiles') is not null as has_profiles,
  to_regclass('public.media_assets') is not null as has_media_assets,
  to_regclass('public.media_deletion_jobs') is not null as has_media_deletion_jobs,
  to_regclass('public.media_upload_ledger') is not null as has_media_upload_ledger;

select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'posts'
            and column_name = 'media_urls') as posts_has_media_urls,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'posts'
            and column_name = 'audio_url') as posts_has_audio_url,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'profile_highlight_collections'
            and column_name = 'cover_url') as collections_has_cover_url,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'media_assets'
            and column_name = 'poster_url') as media_assets_has_poster_url;

-- 3) دلالة فحص media_urls بعدة روابط فعلياً:
--    PostgREST يترجم media_urls=ov.{u1,u2} إلى المعامل && (تقاطع مصفوفتين).
--    هذه الاستعلامات تثبت الدلالة على بيانات حقيقية: كل رابط شرط مستقل
--    (مطابق لبناء mediaInActiveUse الجديد — شرط ov واحد لكل رابط داخل or=).
select
  count(*) as rows_with_media_urls_array,
  count(*) filter (where media_urls && array['https://example.invalid/aani/u1/first.mp4'::text]) as rows_matching_url_1,
  count(*) filter (where media_urls && array['https://example.invalid/aani/u1/first.mp4'::text, 'https://example.invalid/aani/u1/second.mp4'::text]) as rows_matching_either_url,
  count(*) filter (where media_urls && array['https://example.invalid/aani/u1/first.mp4'::text] and media_urls && array['https://example.invalid/aani/u1/second.mp4'::text]) as rows_matching_both_urls
from public.posts
where media_urls is not null;

-- 4) عينة صفوف حقيقية بمصفوفة تحتوي عدة روابط (للاطلاع على الصيغة المخزنة)
select id, media_url, media_urls
from public.posts
where array_length(media_urls, 1) > 1
limit 3;
