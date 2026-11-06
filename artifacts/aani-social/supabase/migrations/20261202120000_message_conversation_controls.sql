begin;

create table if not exists public.message_hides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists aani_message_hides_message_idx
  on public.message_hides (message_id);

alter table public.message_hides enable row level security;
revoke all on public.message_hides from public, anon, authenticated;
grant select on public.message_hides to authenticated;

drop policy if exists aani_message_hides_select_own on public.message_hides;
create policy aani_message_hides_select_own on public.message_hides
  for select to authenticated
  using (user_id = (select auth.uid()));

alter table public.message_hides replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'message_hides'
     ) then
    execute 'alter publication supabase_realtime add table public.message_hides';
  end if;
end;
$$;

create or replace function public.aani_hide_message_conversation(p_other_user_id uuid)
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
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;

  insert into public.message_hides (user_id, message_id)
  select actor_id, message.id
  from public.messages as message
  where (message.sender_id = actor_id and message.recipient_id = p_other_user_id)
     or (message.sender_id = p_other_user_id and message.recipient_id = actor_id)
  on conflict (user_id, message_id) do nothing;
end;
$$;

create or replace function public.aani_delete_message_conversation_for_everyone(p_other_user_id uuid)
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
  if p_other_user_id is null or p_other_user_id = actor_id then
    raise exception 'Invalid conversation participant' using errcode = '22023';
  end if;

  delete from public.messages as message
  where (message.sender_id = actor_id and message.recipient_id = p_other_user_id)
     or (message.sender_id = p_other_user_id and message.recipient_id = actor_id);
end;
$$;

revoke all on function public.aani_hide_message_conversation(uuid) from public, anon;
revoke all on function public.aani_delete_message_conversation_for_everyone(uuid) from public, anon;
grant execute on function public.aani_hide_message_conversation(uuid) to authenticated;
grant execute on function public.aani_delete_message_conversation_for_everyone(uuid) to authenticated;

commit;
