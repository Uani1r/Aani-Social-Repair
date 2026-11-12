-- تنظيف تلقائي للمحتوى المنتهي ضمن حد قاعدة البيانات (500 MB في الباقة المجانية):
-- - القصص المنتهية قبل أكثر من يومين وغير المستخدمة في أبرز القصص (بالمرجع أو بالرابط)
--   أو في الأصوات النشطة، مع أرشفة مشاهداتها.
-- - الإشعارات الأقدم من 30 يوماً.
-- ملفات ImageKit المقابلة تُحذف عبر نقطة النهاية /api/media/purge-expired من الخادم.
begin;

create or replace function public.aani_cleanup_expired_media_records()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  purged_stories bigint := 0;
  purged_views bigint := 0;
  purged_notifications bigint := 0;
  expired_ids uuid[];
begin
  select array_agg(s.id) into expired_ids
  from public.stories s
  where s.expires_at < now() - interval '2 days'
    and not exists (
      select 1 from public.profile_highlights h
      where h.source_story_id = s.id
        or (h.media_url is not null and s.media_url is not null
            and regexp_replace(h.media_url, '[#?].*$', '') = regexp_replace(s.media_url, '[#?].*$', ''))
    )
    and not exists (
      select 1 from public.sounds sd
      where (sd.source_video_url is not null and s.media_url is not null
             and regexp_replace(sd.source_video_url, '[#?].*$', '') = regexp_replace(s.media_url, '[#?].*$', ''))
         or (sd.preview_url is not null and s.media_url is not null
             and regexp_replace(sd.preview_url, '[#?].*$', '') = regexp_replace(s.media_url, '[#?].*$', ''))
    );

  if expired_ids is not null then
    delete from public.story_views where story_id = any(expired_ids);
    get diagnostics purged_views = row_count;

    delete from public.stories where id = any(expired_ids);
    get diagnostics purged_stories = row_count;
  end if;

  delete from public.notifications where created_at < now() - interval '30 days';
  get diagnostics purged_notifications = row_count;

  return jsonb_build_object(
    'stories', purged_stories,
    'story_views', purged_views,
    'notifications', purged_notifications
  );
end $$;

grant execute on function public.aani_cleanup_expired_media_records() to authenticated;

-- جدولة يومية عبر pg_cron إن كان متاحاً في هذه البيئة — وإلا يغطي الفحص
-- الدوري من العميل (مرة كل 24 ساعة لكل مستخدم) نفس العمل دون تعطل الترحيل.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    if not exists (select 1 from pg_extension where extname = 'pg_cron') then
      create extension if not exists pg_cron;
    end if;

    if exists (select 1 from cron.job where jobname = 'aani-expired-media-cleanup') then
      perform cron.unschedule('aani-expired-media-cleanup');
    end if;

    perform cron.schedule(
      'aani-expired-media-cleanup',
      '17 3 * * *',
      'select public.aani_cleanup_expired_media_records();'
    );
  end if;
exception
  when others then
    null; -- pg_cron غير متاح — لا تفشل الترحيل
end $cron$;

notify pgrst, 'reload schema';

commit;
