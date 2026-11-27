-- بيئة اختبار خصوصية إعدادات المحادثات: الشكل الفعلي للجدول والسياسات
-- كما في fresh_schema_cloudflare_r2.sql قبل الإصلاح، مع ثلاثة مستخدمين A وB وC.
-- تُعاد بناؤها بأمان (drop policy + insert on conflict do nothing).

create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

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
  id uuid primary key references auth.users (id) on delete cascade,
  username text
);

-- الشكل الفعلي (fresh_schema_cloudflare_r2.sql:305-311).
create table if not exists public.message_conversation_settings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  other_user_id uuid not null references public.profiles (id) on delete cascade,
  is_muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
);

alter table public.message_conversation_settings enable row level security;

-- المنح الفعلية (fresh_schema_cloudflare_r2.sql:804) — لا تُغيَّر في الإصلاح.
grant select, insert, update, delete on public.message_conversation_settings to authenticated;

-- التعريف الفعلي قبل الإصلاح (fresh_schema_cloudflare_r2.sql:727-732).
drop policy if exists "Users read own conversation settings" on public.message_conversation_settings;
create policy "Users read own conversation settings"
  on public.message_conversation_settings for select to authenticated
  using (user_id = (select auth.uid()) or other_user_id = (select auth.uid()));

drop policy if exists "Users manage own conversation settings" on public.message_conversation_settings;
create policy "Users manage own conversation settings"
  on public.message_conversation_settings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('b0000000-0000-0000-0000-00000000000b', 'b@example.com'),
  ('c0000000-0000-0000-0000-00000000000c', 'c@example.com')
on conflict (id) do nothing;

insert into public.profiles (id, username) values
  ('a0000000-0000-0000-0000-00000000000a', 'user_a'),
  ('b0000000-0000-0000-0000-00000000000b', 'user_b'),
  ('c0000000-0000-0000-0000-00000000000c', 'user_c')
on conflict (id) do nothing;

-- A كتم محادثته مع B، وB له إعداد مستقل مع A.
insert into public.message_conversation_settings (user_id, other_user_id, is_muted) values
  ('a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000b', true),
  ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', false)
on conflict (user_id, other_user_id) do nothing;
