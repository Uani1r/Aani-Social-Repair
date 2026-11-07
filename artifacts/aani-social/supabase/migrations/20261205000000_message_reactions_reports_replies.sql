begin;

alter table public.messages
  add column if not exists reply_to_message_id uuid references public.messages(id) on delete set null;

create index if not exists aani_messages_reply_to_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

create or replace function public.aani_validate_message_reply_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reply_to_message_id is not null and not exists (
    select 1
    from public.messages as parent
    where parent.id = new.reply_to_message_id
      and (
        (parent.sender_id = new.sender_id and parent.recipient_id = new.recipient_id)
        or (parent.sender_id = new.recipient_id and parent.recipient_id = new.sender_id)
      )
  ) then
    raise exception 'Reply target must belong to the same conversation' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists aani_validate_message_reply_target on public.messages;
drop trigger if exists aani_validate_message_reply_target_insert on public.messages;
drop trigger if exists aani_validate_message_reply_target_update on public.messages;
create trigger aani_validate_message_reply_target_insert
  before insert on public.messages
  for each row execute function public.aani_validate_message_reply_target();
create trigger aani_validate_message_reply_target_update
  before update of reply_to_message_id, sender_id, recipient_id on public.messages
  for each row execute function public.aani_validate_message_reply_target();

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists aani_message_reactions_message_idx
  on public.message_reactions (message_id, created_at);

alter table public.message_reactions enable row level security;
revoke all on public.message_reactions from public, anon, authenticated;
grant select, insert, update, delete on public.message_reactions to authenticated;

drop policy if exists aani_message_reactions_select_participant on public.message_reactions;
create policy aani_message_reactions_select_participant on public.message_reactions
  for select to authenticated using (
    exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );
drop policy if exists aani_message_reactions_insert_own on public.message_reactions;
create policy aani_message_reactions_insert_own on public.message_reactions
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );
drop policy if exists aani_message_reactions_update_own on public.message_reactions;
create policy aani_message_reactions_update_own on public.message_reactions
  for update to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  ) with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages as message
      where message.id = message_reactions.message_id
        and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
    )
  );
drop policy if exists aani_message_reactions_delete_own on public.message_reactions;
create policy aani_message_reactions_delete_own on public.message_reactions
  for delete to authenticated using (user_id = (select auth.uid()));

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  message_content text not null default '',
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null default 'other' check (category in ('spam', 'harassment', 'hate', 'fake_account', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint aani_message_reports_not_self check (reporter_id <> reported_user_id),
  constraint aani_message_reports_reporter_message_unique unique (reporter_id, message_id)
);

create index if not exists aani_message_reports_target_created_idx
  on public.message_reports (reported_user_id, created_at desc);

alter table public.message_reports enable row level security;
revoke all on public.message_reports from public, anon, authenticated;

drop policy if exists aani_message_reports_insert_participant on public.message_reports;

create or replace function public.aani_report_message(p_message_id uuid, p_details text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  message_sender_id uuid;
  message_content text;
  inserted_count integer;
  normalized_details text := btrim(coalesce(p_details, ''));
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if char_length(normalized_details) > 1000 then
    raise exception 'Report details are too long' using errcode = '22023';
  end if;

  select message.sender_id, message.content
    into message_sender_id, message_content
  from public.messages as message
  where message.id = p_message_id
    and (message.sender_id = actor_id or message.recipient_id = actor_id);
  if not found then
    raise exception 'Message is unavailable to this user' using errcode = '42501';
  end if;
  if message_sender_id = actor_id then
    raise exception 'Users may only report messages received from others' using errcode = '42501';
  end if;

  insert into public.message_reports (
    message_id, message_content, reporter_id, reported_user_id, category, details
  ) values (
    p_message_id, message_content, actor_id, message_sender_id, 'other', normalized_details
  ) on conflict (reporter_id, message_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    raise exception 'This message has already been reported' using errcode = '23505';
  end if;
end;
$$;
revoke all on function public.aani_report_message(uuid, text) from public, anon;
grant execute on function public.aani_report_message(uuid, text) to authenticated;

create or replace function public.aani_hide_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  message_exists boolean;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  select exists (
    select 1 from public.messages as message
    where message.id = p_message_id
      and (message.sender_id = actor_id or message.recipient_id = actor_id)
  ) into message_exists;
  if not message_exists then
    raise exception 'Message is unavailable to this user' using errcode = '42501';
  end if;

  insert into public.message_hides (user_id, message_id)
  values (actor_id, p_message_id)
  on conflict (user_id, message_id) do nothing;
end;
$$;

create or replace function public.aani_delete_message_for_everyone(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  message_sender_id uuid;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select message.sender_id into message_sender_id
  from public.messages as message
  where message.id = p_message_id;
  if not found then
    raise exception 'Message is unavailable' using errcode = 'P0002';
  end if;
  if message_sender_id <> actor_id then
    raise exception 'Only the message sender may delete it for everyone' using errcode = '42501';
  end if;

  delete from public.messages as message
  where message.id = p_message_id and message.sender_id = actor_id;
end;
$$;

revoke all on function public.aani_hide_message(uuid) from public, anon;
revoke all on function public.aani_delete_message_for_everyone(uuid) from public, anon;
grant execute on function public.aani_hide_message(uuid) to authenticated;
grant execute on function public.aani_delete_message_for_everyone(uuid) to authenticated;

alter table public.message_reactions replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.message_reactions;
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end;
$$;

commit;
