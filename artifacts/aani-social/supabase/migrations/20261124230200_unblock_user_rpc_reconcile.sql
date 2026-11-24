-- تصحيحي: استعادة aani_unblock_user(uuid)
-- (الملف الأصلي 20261218000000_account_privacy_settings.sql لم يُطبَّق).
--
-- create or replace: آمن لإعادة التطبيق. يحذف علاقة الحجب للمستخدم نفسه فقط
-- من public.user_blocks، ويحتمل المخططين: blocked_user_id (الحالي) أو
-- blocked_id (القديم في النسخ المنشورة). يُختار العمود بعد فحص
-- information_schema.columns، ولا يمسح أي صف آخر.
begin;

create or replace function public.aani_unblock_user(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  has_blocked_user_id boolean := false;
  has_blocked_id boolean := false;
  delete_sql text;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to unblock' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public' and table_name = 'user_blocks'
  ) then
    raise exception 'public.user_blocks does not exist' using errcode = '42P01';
  end if;

  select coalesce(bool_or(column_name = 'blocked_user_id'), false),
         coalesce(bool_or(column_name = 'blocked_id'), false)
  into has_blocked_user_id, has_blocked_id
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'user_blocks'
    and column_name in ('blocked_user_id', 'blocked_id');

  if has_blocked_user_id then
    delete_sql := 'delete from public.user_blocks
                   where blocker_id = $1 and blocked_user_id = $2';
  elsif has_blocked_id then
    delete_sql := 'delete from public.user_blocks
                   where blocker_id = $1 and blocked_id = $2';
  else
    raise exception 'public.user_blocks has neither blocked_user_id nor blocked_id'
      using errcode = '42703';
  end if;

  execute delete_sql using actor_id, p_blocked_user_id;
end;
$$;

alter function public.aani_unblock_user(uuid) owner to postgres;
revoke all on function public.aani_unblock_user(uuid) from public, anon;
grant execute on function public.aani_unblock_user(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
