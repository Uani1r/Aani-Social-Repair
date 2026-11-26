-- =====================================================================
-- بيئة اختبار Sandbox المالي (Postgres محلي بالكامل — لا Supabase سحابي).
--
-- هذا ليس ترحيلاً ولا يُطبَّق على الإنتاج. يُنشئ الأدوار ومخططات auth/storage/
-- extensions/realtime الأدنى اللازمة لتطبيق المخطط الأساسي (fresh_schema) ثم
-- جميع الترحيلات بالترتيب الزمني، مع توفير متطلبات Supabase Auth وRLS فعلياً
-- (auth.uid() / auth.role() وسياسات RLS حقيقية).
--
-- يُطبَّق أولاً، ثم fresh_schema_cloudflare_r2.sql (المخطط الأساسي)، ثم جميع
-- الترحيلات في migrations/ بالترتيب (الترحيل المالي 20270306000000 هو الأخير)،
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

-- 3) مخطط storage الأدنى (حتى تُنشأ سياسات storage.objects في المخطط الأساسي).
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

-- 4) مخطط extensions + pg_trgm (يستخدمه ترحيل فهارس البحث 20270228000000).
--    الترحيل ينشئ الامتداد نفسه داخل هذا المخطط؛ نوفر المخطط فقط.
create schema if not exists extensions;

-- 5) مخطط realtime الأدنى (سياسات Broadcast في 20270302000000 تشير إلى
--    realtime.messages و realtime.topic()، ودالة realtime.send اختيارية).
create schema if not exists realtime;

create table if not exists realtime.messages (
  id bigserial primary key,
  topic text,
  extension text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- realtime.topic(): يقرأ الموضوع من ترويسات الطلب (مثل Supabase). اختبارياً
-- يعيد NULL (بلا جلسة WebSocket) فتصبح سياسات Broadcast غير مطابقة بأمان.
create or replace function realtime.topic()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.headers', true)::jsonb ->> 'topic', '')
$$;

-- realtime.send(): دالة إرسال Broadcast. نجعلها no-op حتى لا تُنشأ trigger
-- الحذف التي تستدعيها (الترحيل يتخطاها إن كانت غير موجودة؛ ووجودها آمن).
create or replace function realtime.send(
  p_payload jsonb,
  p_event text,
  p_topic text,
  p_private boolean default false
)
returns void
language plpgsql
as $$
begin
  null;
end;
$$;

-- 6) صلاحيات الاستخدام للأدوار (مثل Supabase).
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema realtime to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;