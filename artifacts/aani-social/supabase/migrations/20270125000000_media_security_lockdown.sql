-- إغلاق صلاحيات دوال SECURITY DEFINER الخاصة بوسائط التطبيق:
-- 1) دوال طابور الحذف المؤجل والتنظيف تعمل من الخادم الموثوق (service_role)
--    أو عبر Triggers (تنفيذ Trigger لا يتطلب صلاحية EXECUTE أصلاً)، فلا سبب
--    لبقاء EXECUTE الافتراضي على PUBLIC. هذه الجولة تسحب الصلاحية من PUBLIC
--    ومن anon ومن authenticated صراحةً، وتمنحها لـ service_role فقط.
-- 2) الجداول (media_deletion_jobs و media_upload_ledger) تُسحب منها أي منح
--    مباشر لـ anon/authenticated (RLS يرفض مطلقاً أصلاً — نضاعف الحماية).
--
-- استقلالية الترحيل: إن لم تُطبَّق الترحيلات السابقة (23/24) فالدوال والجداول
-- غير الموجودة تُتخطى بلا فشل عبر to_regprocedure/to_regclass/to_regrole —
-- لا افتراض أن أي ترحيل سابق مطبَّق في Supabase.

begin;

-- 1) إغلاق صلاحيات دوال الوسائط ============================================
do $ddl$
declare
  target_functions text[] := array[
    'aani_claim_media_deletion_jobs(integer,integer)',
    'aani_enqueue_media_deletion_job(text)',
    'aani_queue_deleted_media()',
    'aani_queue_media_if_replaced()',
    'aani_queue_deleted_message_media()',
    'aani_cleanup_expired_media_records()'
  ];
  target_signature text;
  proc_oid oid;
begin
  foreach target_signature in array target_functions loop
    proc_oid := to_regprocedure('public.' || target_signature);
    if proc_oid is null then
      raise notice 'الدالة % غير موجودة في هذه البيئة — تُتخطى (الترحيل المرجعي لم يُطبَّق)', target_signature;
      continue;
    end if;

    -- PUBLIC: الوضع الافتراضي عند CREATE FUNCTION يمنح EXECUTE للعموم — نسحبه
    execute format('revoke all on function public.%s from public', target_signature);
    -- أدوار Supabase (إن وُجدت في هذه البيئة)
    if to_regrole('anon') is not null then
      execute format('revoke all on function public.%s from anon', target_signature);
    end if;
    if to_regrole('authenticated') is not null then
      execute format('revoke all on function public.%s from authenticated', target_signature);
    end if;
    -- الخادم الموثوق فقط
    if to_regrole('service_role') is not null then
      execute format('grant execute on function public.%s to service_role', target_signature);
    end if;
    raise notice 'أُغلقت صلاحيات الدالة % — service_role فقط', target_signature;
  end loop;
end $ddl$;

-- 2) الجداول: لا وصول مباشر لأي مستخدم عادي ===============================
do $ddl$
begin
  if to_regclass('public.media_deletion_jobs') is not null then
    if to_regrole('anon') is not null then
      revoke all on table public.media_deletion_jobs from anon;
    end if;
    if to_regrole('authenticated') is not null then
      revoke all on table public.media_deletion_jobs from authenticated;
    end if;
    if to_regrole('service_role') is not null then
      grant select, insert, update, delete on table public.media_deletion_jobs to service_role;
    end if;
  else
    raise notice 'public.media_deletion_jobs غير موجود — تُتخطى حجب الجدول (طبِّق ترحيل 20270123000000 أولاً)';
  end if;

  if to_regclass('public.media_upload_ledger') is not null then
    if to_regrole('anon') is not null then
      revoke all on table public.media_upload_ledger from anon;
    end if;
    if to_regrole('authenticated') is not null then
      revoke all on table public.media_upload_ledger from authenticated;
    end if;
    if to_regrole('service_role') is not null then
      grant select, insert, delete on table public.media_upload_ledger to service_role;
    end if;
  else
    raise notice 'public.media_upload_ledger غير موجود — تُتخطى حجب الجدول (طبِّق ترحيل 20270124000000 أولاً)';
  end if;
end $ddl$;

notify pgrst, 'reload schema';

commit;
