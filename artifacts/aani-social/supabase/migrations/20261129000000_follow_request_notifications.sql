create or replace function public.aani_notify_follow_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (user_id, actor_id, type, content, reference_id, is_read, created_at)
  values (
    new.recipient_id,
    new.requester_id,
    'follow_request',
    'أرسل طلب متابعة',
    new.requester_id,
    false,
    new.created_at
  );
  return new;
end;
$$;

revoke all on function public.aani_notify_follow_request() from public;

drop trigger if exists aani_follow_request_notification_trg on public.follow_requests;
create trigger aani_follow_request_notification_trg
after insert on public.follow_requests
for each row execute function public.aani_notify_follow_request();

insert into public.notifications (user_id, actor_id, type, content, reference_id, is_read, created_at)
select request.recipient_id, request.requester_id, 'follow_request', 'أرسل طلب متابعة', request.requester_id, false, request.created_at
from public.follow_requests as request
where not exists (
  select 1
  from public.notifications as notification
  where notification.user_id = request.recipient_id
    and notification.actor_id = request.requester_id
    and notification.type = 'follow_request'
    and notification.reference_id = request.requester_id
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'follow_requests'
     ) then
    execute 'alter publication supabase_realtime add table public.follow_requests';
  end if;
end;
$$;



create or replace function public.aani_resolve_follow_request_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notifications
  set is_read = true
  where user_id = old.recipient_id
    and actor_id = old.requester_id
    and type = 'follow_request'
    and reference_id = old.requester_id
    and is_read = false;
  return old;
end;
$$;

revoke all on function public.aani_resolve_follow_request_notification() from public;

drop trigger if exists aani_follow_request_resolved_notification_trg on public.follow_requests;
create trigger aani_follow_request_resolved_notification_trg
after delete on public.follow_requests
for each row execute function public.aani_resolve_follow_request_notification();
