-- ============================================================================
-- Simulate missing reply validation and synchronization objects in CI's
-- throwaway PostgreSQL database. The migration must restore them without
-- relying on the earlier migration's function or triggers.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create role anon';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create role authenticated';
  end if;
end $$;

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.messages to anon, authenticated;

drop trigger if exists aani_validate_message_reply_target_insert on public.messages;
drop trigger if exists aani_validate_message_reply_target_update on public.messages;
drop trigger if exists aani_sync_message_reply_ids on public.messages;

drop function if exists public.aani_validate_message_reply_target();
drop function if exists public.aani_sync_message_reply_ids();

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname in (
        'aani_validate_message_reply_target_insert',
        'aani_validate_message_reply_target_update',
        'aani_sync_message_reply_ids'
      )
      and not tgisinternal
  ) then
    raise exception 'لم تُحذف مشغلات التحقق والمزامنة قبل اختبار bootstrap.';
  end if;

  if exists (
    select 1 from pg_proc as procedure_row
    join pg_namespace as schema_row on schema_row.oid = procedure_row.pronamespace
    where schema_row.nspname = 'public'
      and procedure_row.proname in (
        'aani_validate_message_reply_target',
        'aani_sync_message_reply_ids'
      )
  ) then
    raise exception 'لم تُحذف دالتا التحقق والمزامنة قبل اختبار bootstrap.';
  end if;
end $$;

commit;
