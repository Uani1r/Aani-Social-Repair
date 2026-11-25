-- تصحيحي: استعادة mark_all_notifications_as_read()
-- (الملف الأصلي 20270105000000_mark_all_notifications_as_read.sql لم يُطبَّق).
--
-- create or replace: آمن لإعادة التطبيق. security invoker: سياسات RLS على
-- public.notifications تُطبَّق على المستدعي، فلا تُقرأ إشعارات غيره ولا تُعدَّل.
begin;

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

notify pgrst, 'reload schema';

commit;
