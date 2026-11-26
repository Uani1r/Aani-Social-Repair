-- =====================================================================
-- بيئة اختبار Sandbox المالي (Postgres محلي بالكامل — لا Supabase سحابي).
--
-- هذا ليس ترحيلاً ولا يُطبَّق على الإنتاج. يُنشئ الأدوار ومخطط auth ومخطط
-- storage الأدنى اللازمين لتطبيق schema.sql والترحيل المالي، مع توفير متطلبات
-- Supabase Auth وRLS فعلياً (auth.uid() / auth.role() وسياسات RLS حقيقية).
--
-- يُطبَّق أولاً، ثم schema.sql، ثم الترحيل 20270306000000_aani_sandbox_financial.sql،
-- ثم بيانات الاختبار، ثم الاختبارات.
-- =====================================================================

-- 1) الأدوار التي تشير إليها السياسات/المنح.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- 2) مخطط auth مع جدول users بالأعمدة التي يتطلبها trigger إنشاء الملف الشخصي.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- auth.uid(): يقرأ sub من request.jwt.claims (نفس سلوك Supabase).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

-- auth.role(): يقرأ role من request.jwt.claims (نفس سلوك Supabase).
create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$$;

-- 3) مخطط storage الأدنى (حتى تُنشأ سياسات storage.objects في schema.sql).
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid
);

create or replace function storage.foldername(name text)
returns text[]
language plpgsql
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  if array_length(parts, 1) <= 1 then
    return array[]::text[];
  end if;
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

-- 4) صلاحيات الاستخدام للأدوار (مثل Supabase).
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;