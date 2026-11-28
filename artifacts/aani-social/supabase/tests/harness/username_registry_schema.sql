-- بيئة اختبار ترحيل سجل أسماء المستخدمين وإكمال التسجيل.
-- تُبنى فقط الأجزاء التي يلمسها الترحيل والاختبار (لا مشروع Supabase حقيقي):
-- auth.users وauth.uid() والأدوار وpublic.profiles بلا أعمدة الإكمال (يضيفها
-- الترحيل) وبلا قيد اسم المستخدم القديم (يستبدله الترحيل).

create extension if not exists "pgcrypto";

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
end $$;

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
  username text,
  full_name text,
  gender text not null default 'male',
  birth_date date,
  city text,
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated
  using (true);

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant select on public.profiles to authenticated;
-- منح أعمدة التحديث حتى تصل محاولة التجاوز المباشر إلى المشغّل ولا تفشل
-- على الصلاحية وحدها؛ أعمدة الإكمال والموافقة يضيفها الترحيل ويسحبها.
grant update (username, full_name, gender, birth_date) on public.profiles to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'c@example.com')
on conflict (id) do nothing;

-- أسماء قائمة قبل الترحيل: قصير جداً (a)، وحروف كبيرة (User.B وUSERC).
insert into public.profiles (id, username, full_name, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'a', 'Account A', now() - interval '30 days'),
  ('22222222-2222-2222-2222-222222222222', 'User.B', 'Account B', now() - interval '20 days'),
  ('33333333-3333-3333-3333-333333333333', 'USERC', 'Account C', now() - interval '10 days')
on conflict (id) do nothing;
