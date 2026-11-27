-- بيئة اختبار نظام الإشعارات الموحد على قاعدة CI مؤقتة فقط.
-- تعيد الشكل الفعلي المختصر للجداول التي تعتمد عليها الترحيلات الجديدة:
--   profiles, messages, notifications (+ حارس 20261229), user_blocks,
--   message_conversation_settings، وأدوار Supabase وauth.uid().
-- لا تُشغَّل على أي مشروع Supabase.

create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  -- service_role في Supabase يمتلك BYPASSRLS، وبه يعمل العامل على outbox
  -- (RLS مفعّلة بلا سياسات، فالمستخدم العادي ممنوع تماماً).
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  else
    alter role service_role bypassrls;
  end if;
end
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table if not exists public.profiles (
  id uuid primary key,
  username text,
  notification_settings jsonb not null default '{}'::jsonb
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null,
  recipient_id uuid not null,
  content text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  actor_id uuid,
  type text not null default 'system',
  content text,
  reference_id uuid,
  entity_id uuid,
  comment_id uuid,
  metadata jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.user_blocks (
  blocker_id uuid not null,
  blocked_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_user_id)
);

create table if not exists public.message_conversation_settings (
  user_id uuid not null,
  other_user_id uuid not null,
  is_muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
);

-- حارس 20261229: يمنع إدراج الرسائل والمكالمات في الإشعارات العامة.
create or replace function public.aani_block_message_call_notifications()
returns trigger
language plpgsql
as $$
begin
  if lower(new.type) in ('message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call') then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_block_message_call_notifications on public.notifications;
create trigger aani_block_message_call_notifications
before insert on public.notifications
for each row execute function public.aani_block_message_call_notifications();

-- سياسات الإشعارات الفعلية (قراءة/تحديث/حذف صاحبها).
alter table public.notifications enable row level security;
grant select, update, delete on public.notifications to authenticated;

drop policy if exists "Users read own notifications" on public.notifications;
create policy "Users read own notifications"
  on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "Users update own notifications" on public.notifications;
create policy "Users update own notifications"
  on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users delete own notifications" on public.notifications;
create policy "Users delete own notifications"
  on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));

insert into public.profiles (id, username, notification_settings) values
  ('a0000000-0000-0000-0000-00000000000a', 'user_a', '{}'::jsonb),
  ('b0000000-0000-0000-0000-00000000000b', 'user_b', '{}'::jsonb),
  ('c0000000-0000-0000-0000-00000000000c', 'user_c', '{}'::jsonb)
on conflict (id) do nothing;
