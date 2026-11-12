-- إغلاق صلاحيات دوال SECURITY DEFINER الخاصة بوسائط التطبيق:
-- 1) دوال طابور الحذف المؤجل والتنظيف تعمل من الخادم الموثوق (service_role)
--    أو عبر Triggers (تنفيذ Trigger لا يتطلب صلاحية EXECUTE أصلاً)، فلا سبب
--    لبقاء EXECUTE الافتراضي على PUBLIC. هذه الجولة تسحب الصلاحية من PUBLIC
--    ومن anon ومن authenticated صراحةً، وتمنحها لـ service_role فقط.
-- 2) Triggers الاستبدال (أغلفة الحساب/الأبرز) تُنشأ فقط عندما تكون أعمدتها موجودة،
--    وبيئة ناقصة المخطط لا تفشل.
-- 3) الجداول (media_deletion_jobs و media_upload_ledger) تُسحب منها أي منح
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

-- 2) ضمانة توافق: إنشاء Triggers الاستبدال مشروط بوجود الأعمدة نفسها —
--    بيئة تنقصها profiles.cover_url أو profile_highlight_collections
--    (ترحيلات 20261210/20261215 غير مطبقة) لا تفشل هنا؛ يُنشأ كل Trigger
--    فقط عندما تكون أعمدته موجودة فعلاً، مع إشعار صريح لما يُتخطى.
--    (هذا لا يعدّل ترحيلاً مطبقاً — Triggers مطابقة لترحيل 24 عند اكتمال المخطط)
do $ddl$
declare
  has_profiles_table boolean := to_regclass('public.profiles') is not null;
  has_collections_table boolean := to_regclass('public.profile_highlight_collections') is not null;
  has_avatar boolean;
  has_profile_cover boolean;
  has_collection_cover boolean;
begin
  if has_profiles_table then
    select
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'avatar_url'),
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'cover_url')
    into has_avatar, has_profile_cover;

    if has_avatar and has_profile_cover then
      drop trigger if exists aani_queue_replaced_media on public.profiles;
      create trigger aani_queue_replaced_media
        after update of avatar_url, cover_url on public.profiles
        for each row execute function public.aani_queue_media_if_replaced();
      raise notice 'Trigger استبدال وسائط profiles جاهز';
    else
      raise notice 'أعمدة profiles للوسائط غير مكتملة — يُتخطى Trigger الاستبدال (طبّق ترحيل 20261210000000 أولاً)';
    end if;
  else
    raise notice 'public.profiles غير موجود — يُتخطى Trigger الاستبدال';
  end if;

  if has_collections_table then
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'profile_highlight_collections'
                     and column_name = 'cover_url')
    into has_collection_cover;

    if has_collection_cover then
      drop trigger if exists aani_queue_replaced_media on public.profile_highlight_collections;
      create trigger aani_queue_replaced_media
        after update of cover_url on public.profile_highlight_collections
        for each row execute function public.aani_queue_media_if_replaced();
      raise notice 'Trigger استبدال أغلفة أبرز القصص جاهز';
    else
      raise notice 'عمود cover_url غير موجود في profile_highlight_collections — يُتخطى Trigger (طبّق ترحيل 20261215000000 أولاً)';
    end if;
  else
    raise notice 'public.profile_highlight_collections غير موجود — يُتخطى Trigger (طبّق ترحيل 20261212000000 أولاً)';
  end if;
end $ddl$;

-- 3) الجداول: لا وصول مباشر لأي مستخدم عادي ===============================
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
