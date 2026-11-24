-- تصحيحي: استعادة aani_unblock_user(uuid)
-- (الملف الأصلي 20261218000000_account_privacy_settings.sql لم يُطبَّق).
--
-- create or replace: آمن لإعادة التطبيق. يحذف علاقة الحجب للمستخدم نفسه فقط
-- من public.user_blocks كما هي في المخطط، ولا يمسح أي صف آخر.
begin;

create or replace function public.aani_unblock_user(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to unblock' using errcode = '22023';
  end if;

  delete from public.user_blocks
  where blocker_id = actor_id and blocked_user_id = p_blocked_user_id;
end;
$$;

alter function public.aani_unblock_user(uuid) owner to postgres;
revoke all on function public.aani_unblock_user(uuid) from public, anon;
grant execute on function public.aani_unblock_user(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
