-- بيئة اختبار نظام الإشعارات على قاعدة CI مؤقتة فقط، مطابقة للمخطط الإنتاجي
-- (auqqqwfjxrxizlmeweka) كما جرى فحصه للقراءة فقط:
--   * public.user_blocks بعموديها الفعليين: blocker_id و blocked_id
--     (لا blocked_user_id).
--   * public.messages: id, sender_id, recipient_id, content.
--   * public.profiles: notification_settings jsonb.
--   * public.message_conversation_settings: user_id, other_user_id, is_muted.
--   * الـtrigger القديم aani_message_notification_after_insert على public.messages
--     يستدعي public.aani_notify_on_message_insert() وينشئ إشعار رسالة عاماً.
--     يُنشأ هنا كما هو في الإنتاج، والترحيلات الجديدة يجب أن تُسقطه.
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
  -- service_role في Supabase يمتلك BYPASSRLS، وبه يعمل العامل على outbox.
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

-- الأعمدة الفعلية للرسائل في الإنتاج.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null,
  recipient_id uuid not null,
  content text
);

-- الأعمدة الفعلية للحظر في الإنتاج: blocker_id و blocked_id.
create table if not exists public.user_blocks (
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists public.message_conversation_settings (
  user_id uuid not null,
  other_user_id uuid not null,
  is_muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
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

-- الـtrigger القديم الفعلي في الإنتاج: ينشئ إشعار رسالة عاماً.
create or replace function public.aani_notify_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_id is null
    or new.recipient_id is null
    or new.sender_id = new.recipient_id
    or coalesce(new.content, '') like '[aani-call:v1]%' then
    return new;
  end if;

  insert into public.notifications (user_id, actor_id, type, content, reference_id)
  values (new.recipient_id, new.sender_id, 'message', 'أرسل لك رسالة', new.id);

  return new;
end;
$$;

drop trigger if exists aani_message_notification_after_insert on public.messages;
create trigger aani_message_notification_after_insert
after insert on public.messages
for each row execute function public.aani_notify_on_message_insert();

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
