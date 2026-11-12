-- ============================================================================
-- 20270126000000_profile_deletion_media_outbox.sql
-- Trigger حذف الحساب: يسجل أفاتار وغلاف الحساب في طابور الحذف المؤجل
-- (media_deletion_jobs) داخل معاملة حذف الحساب نفسها — لا حذف مباشر من
-- الـ Trigger؛ Worker الخادم يفحص المراجع الحية (Fail Closed) قبل الحذف.
--
-- ضمانات التوافق:
-- - إنشاء الـ Trigger مشروط بوجود public.profiles وأعمدتي avatar_url و
--   cover_url ودالتي الإدراج الموحد والـ Trigger نفسها — أي نقص = Notice لا فشل.
-- - EXECUTE لدالة الـ Trigger على service_role فقط (تسحب من public/anon/
--   authenticated) — تنفيذ Trigger لا يتطلب صلاحية أصلاً فلا يُكسر شيء.
-- - لا يلمس Trigger الاستبدال (aani_queue_replaced_media) ولا أي ترحيل مطبق.
-- ============================================================================

begin;

-- 1) دالة Trigger الحذف: تدرج أفاتار وغلاف الحساب عبر الإدراج الموحد =======
-- (الدالة الموحدة تتجاهل NULL والروابط خارج /aani/ — لا تأثير جانبي)
create or replace function public.aani_queue_deleted_profile_media()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.aani_enqueue_media_deletion_job(old.avatar_url);
  perform public.aani_enqueue_media_deletion_job(old.cover_url);
  return old;
end $$;

-- صلاحية التنفيذ لـ service_role فقط — لا وصول من أي مستخدم عادي
revoke all on function public.aani_queue_deleted_profile_media() from public;

do $ddl$
begin
  -- صلاحيات الدالة تُضبط دائماً بلا شروط (إن وُجدت الأدوار في هذه البيئة)
  if to_regrole('anon') is not null then
    revoke all on function public.aani_queue_deleted_profile_media() from anon;
  end if;
  if to_regrole('authenticated') is not null then
    revoke all on function public.aani_queue_deleted_profile_media() from authenticated;
  end if;
  if to_regrole('service_role') is not null then
    grant execute on function public.aani_queue_deleted_profile_media() to service_role;
  end if;
  raise notice 'صلاحيات aani_queue_deleted_profile_media أُغلقت على service_role فقط';
end $ddl$;

-- 2) إنشاء Trigger الحذف مشروط بوجود الجدول والأعمدة والدالتين =============
do $ddl$
declare
  has_profiles boolean := to_regclass('public.profiles') is not null;
  has_enqueue_fn boolean := to_regprocedure('public.aani_enqueue_media_deletion_job(text)') is not null;
  has_trigger_fn boolean := to_regprocedure('public.aani_queue_deleted_profile_media()') is not null;
  has_avatar boolean;
  has_cover boolean;
begin
  if not has_trigger_fn then
    raise notice 'دالة aani_queue_deleted_profile_media غير موجودة — يُتخطى Trigger حذف الحساب';
  elsif not has_enqueue_fn then
    raise notice 'الدالة الموحدة aani_enqueue_media_deletion_job غير موجودة — يُتخطى Trigger حذف الحساب (طبِّق ترحيل 20270124000000 أولاً)';
  elsif not has_profiles then
    raise notice 'public.profiles غير موجود — يُتخطى Trigger حذف الحساب';
  else
    select
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'avatar_url'),
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'cover_url')
    into has_avatar, has_cover;

    if has_avatar and has_cover then
      drop trigger if exists aani_queue_deleted_profile_media on public.profiles;
      create trigger aani_queue_deleted_profile_media
        after delete on public.profiles
        for each row execute function public.aani_queue_deleted_profile_media();
      raise notice 'Trigger حذف الحساب جاهز — أفاتار وغلاف الحساب يُسجلان في الطابور عند الحذف';
    else
      raise notice 'أعمدة profiles للوسائط غير مكتملة — يُتخطى Trigger حذف الحساب (طبّق ترحيل 20261210000000 أولاً)';
    end if;
  end if;
end $ddl$;

notify pgrst, 'reload schema';

commit;
