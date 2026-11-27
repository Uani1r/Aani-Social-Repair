-- إعدادات الحساب: جلسات الحساب، حماية is_deactivated، والتعطيل وإعادة التفعيل.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.
--
-- القواعد:
-- - قراءة الجلسات لهوية الجلسة وحدها عبر دالة `security definer`، ولا وصول
--   مباشر لمخطط `auth` من العميل. لا تُعاد رموز ولا عناوين داخلية.
-- - `is_deactivated` لا يُغيَّر بتحديث مباشر من authenticated: مشغّل يرفض أي
--   تغيير خارج `aani_deactivate_account` / `aani_reactivate_account` (كل واحدة
--   تضبط علامة محلية داخل معاملتها قبل التحديث).
-- - التعطيل ينهي جلسات المستخدم الأخرى ويُبقي الجلسة الحالية (لتُنفَّذ بعدها
--   الجلسة المحلية تُغادر من العميل).
-- - لا حذف لأي بيانات هنا: حذف الحساب يتم من دالة Edge، والوسائط تدخل طابور
--   الحذف بمشغّلات موجودة سابقاً (20270126000000_profile_deletion_media_outbox).
-- - الترحيل idempotent: إعادة تطبيقه لا تُكرّر المشغّل ولا الدوال.

begin;

-- 1) هوية الجلسة الحالية من مطالبات JWT (session_id) — لا تُمنح للعميل.
create or replace function public.aani_current_session_id()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(current_setting('request.jwt.claim.session_id', true), '')::uuid;
$$;

revoke all on function public.aani_current_session_id() from public, anon, authenticated;
grant execute on function public.aani_current_session_id() to service_role;

-- 2) حارس is_deactivated: التغيير فقط عبر دالتي التعطيل/إعادة التفعيل.
create or replace function public.aani_guard_account_deactivation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.is_deactivated is distinct from old.is_deactivated
     and current_setting('aani.account_settings', true) is distinct from 'rpc' then
    raise exception 'is_deactivated changes only through aani_deactivate_account or aani_reactivate_account'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.aani_guard_account_deactivation() from public, anon, authenticated;

drop trigger if exists aani_guard_account_deactivation on public.profiles;
create trigger aani_guard_account_deactivation
  before update of is_deactivated on public.profiles
  for each row
  execute function public.aani_guard_account_deactivation();

-- 3) جلسات الحساب: صفوف الجلسة الحالية وحدها، بلا رموز.
create or replace function public.aani_account_sessions()
returns table (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip text,
  is_current boolean
)
language sql
stable
security definer
set search_path = auth, public, pg_temp
as $$
  select s.id,
         s.created_at,
         s.updated_at,
         s.refreshed_at,
         s.user_agent::text,
         s.ip::text,
         (s.id = public.aani_current_session_id()) as is_current
  from auth.sessions s
  where s.user_id = auth.uid()
  order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc;
$$;

revoke all on function public.aani_account_sessions() from public, anon;
grant execute on function public.aani_account_sessions() to authenticated, service_role;

-- 4) تعطيل الحساب: يضبط العلامة (عبر الحارس) وينهي الجلسات الأخرى.
create or replace function public.aani_deactivate_account()
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_current uuid := public.aani_current_session_id();
begin
  if v_user is null then
    raise exception 'a signed-in session is required' using errcode = '28000';
  end if;

  perform set_config('aani.account_settings', 'rpc', true);
  update public.profiles set is_deactivated = true where id = v_user;
  if not found then
    raise exception 'profile row missing' using errcode = 'P0002';
  end if;

  -- الجلسة الحالية تبقى حتى يغادر العميل بعد نجاح النداء.
  delete from auth.sessions s
  where s.user_id = v_user
    and (v_current is null or s.id <> v_current);

  return true;
end;
$$;

revoke all on function public.aani_deactivate_account() from public, anon;
grant execute on function public.aani_deactivate_account() to authenticated;

-- 5) إعادة التفعيل عند الدخول التالي (بعد MFA إن كانت مفعّلة).
create or replace function public.aani_reactivate_account()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'a signed-in session is required' using errcode = '28000';
  end if;

  perform set_config('aani.account_settings', 'rpc', true);
  update public.profiles set is_deactivated = false where id = v_user;
  if not found then
    raise exception 'profile row missing' using errcode = 'P0002';
  end if;
  return true;
end;
$$;

revoke all on function public.aani_reactivate_account() from public, anon;
grant execute on function public.aani_reactivate_account() to authenticated;

-- 6) RLS: يبقى التحديث للصف نفسه فقط (السياسة القائمة)، والحارس يمنع العمود.
--    لا سياسة جديدة تفتح قراءة أو كتابة أوسع، ولا منح لـ anon.

commit;
