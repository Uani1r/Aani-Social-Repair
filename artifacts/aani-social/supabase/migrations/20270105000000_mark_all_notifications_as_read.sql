-- ترحيل: دالة القراءة التلقائية لكل الإشعارات عند فتح شاشة الإشعارات
-- يُطبق يدوياً في Supabase SQL Editor. آمن للتكرار (idempotent).

-- تُستدعى من واجهة الإشعارات: تعلّم كل إشعارات المستخدم الحالي كمقروءة
-- (تعمل بصلاحيات المستخدم؛ سياسات RLS على notifications تُطبَّق تلقائياً).
create or replace function public.mark_all_notifications_as_read()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.notifications
  set is_read = true
  where user_id = (select auth.uid())
    and (is_read is distinct from true);
end;
$$;

revoke all on function public.mark_all_notifications_as_read() from public, anon;
grant execute on function public.mark_all_notifications_as_read() to authenticated;
