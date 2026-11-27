-- بيئة اختبار ترحيل إعدادات الحساب: auth مبسّط + profiles + الأدوار.
-- تُبنى فقط الأجزاء التي يلمسها الترحيل والاختبار (لا مشروع Supabase حقيقي).

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

create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  refreshed_at timestamptz,
  user_agent text,
  ip text
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
  username text,
  is_deactivated boolean not null default false
);

alter table public.profiles enable row level security;

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant select, update on public.profiles to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com')
on conflict (id) do nothing;

insert into public.profiles (id, username) values
  ('11111111-1111-1111-1111-111111111111', 'user_a'),
  ('22222222-2222-2222-2222-222222222222', 'user_b')
on conflict (id) do nothing;

insert into auth.sessions (id, user_id, created_at, refreshed_at, user_agent, ip) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '2026-01-01T10:00:00Z', '2026-01-03T10:00:00Z', 'iPhone Safari', '203.0.113.9'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '2026-01-02T10:00:00Z', '2026-01-04T10:00:00Z', 'Mac Chrome', '203.0.113.10'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z', 'Android Chrome', '203.0.113.11')
on conflict (id) do nothing;
