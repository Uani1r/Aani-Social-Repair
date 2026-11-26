-- أرقام الدخول بالهاتف (alias) لكل حساب.
--
-- الرقم هنا وسيلة دخول إضافية تُستخدم مع كلمة مرور الحساب، ولا يُرسل إليه
-- أي SMS أو OTP، ولا يُكتب في auth.users.phone، ولا يُستخدم phone_confirm.
--
-- القيود المقصودة:
-- - رقم واحد لكل حساب (user_id مفتاح أساسي).
-- - الرقم فريد على مستوى جميع الحسابات (UNIQUE على phone_e164).
-- - الصيغة E.164 فقط عبر CHECK.
-- - RLS مفعّل بلا أي سياسة، وسُحبت كل صلاحيات anon وauthenticated عن الجدول
--   وعن الدوال: لا قراءة ولا كتابة مباشرة من العميل، ولا سياسة تكشف الأرقام.
-- - الخدمة الخلفية (service_role) وحدها تصل عبر الدوال أدناه.
-- - لا كلمات مرور ولا رموز OTP ولا رموز جلسات: رقم ووقتان فقط.
--
-- التحديث ذري: عبارة واحدة (INSERT ... ON CONFLICT (user_id) DO UPDATE). إذا
-- كان الرقم الجديد مستخدماً في حساب آخر يفشل القيد الفريد وتُرحّل العبارة
-- كاملة، فيبقى الرقم السابق كما هو.

begin;

create table if not exists public.account_phone_aliases (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone_e164 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_phone_aliases_phone_e164_format
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint account_phone_aliases_phone_e164_unique
    unique (phone_e164)
);

comment on table public.account_phone_aliases is
  'أرقام الدخول بالهاتف مع كلمة مرور الحساب. لا SMS ولا OTP، ولا اتصال بـ auth.users.phone.';
comment on column public.account_phone_aliases.user_id is
  'الحساب المالك للرقم — مفتاح أساسي، ورقم واحد لكل حساب.';
comment on column public.account_phone_aliases.phone_e164 is
  'الرقم بصيغة E.164 وفريد بين جميع الحسابات.';
comment on column public.account_phone_aliases.updated_at is
  'وقت آخر إضافة أو تغيير للرقم — للعرض والتشخيص فقط.';

-- القيود تُضاف أيضاً إن كان الجدول موجوداً من نسخة أقدم بلا هذه القيود.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'account_phone_aliases_phone_e164_unique'
      and conrelid = 'public.account_phone_aliases'::regclass
  ) then
    alter table public.account_phone_aliases
      add constraint account_phone_aliases_phone_e164_unique unique (phone_e164);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_phone_aliases_phone_e164_format'
      and conrelid = 'public.account_phone_aliases'::regclass
  ) then
    alter table public.account_phone_aliases
      add constraint account_phone_aliases_phone_e164_format
      check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end;
$$;

alter table public.account_phone_aliases enable row level security;

-- لا سياسات على الجدول إطلاقاً: RLS بلا سياسات يمنع كل الوصول لغير المتجاوز،
-- وسحب الصلاحيات يمنع حتى الوصول إلى الجدول نفسه.
revoke all on table public.account_phone_aliases from public;
revoke all on table public.account_phone_aliases from anon;
revoke all on table public.account_phone_aliases from authenticated;
-- الكتابة للخدمة الخلفية عبر الدوال أدناه فقط (security definer): لا كتابة
-- مباشرة على الجدول حتى لو منحت Supabase الافتراضية كل الصلاحيات.
revoke insert, update, delete, truncate, references, trigger
  on table public.account_phone_aliases from service_role;
grant select on table public.account_phone_aliases to service_role;
grant usage on schema public to service_role;

-- updated_at يتحدث مع كل تغيير للرقم.
create or replace function public.aani_account_phone_alias_touch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.aani_account_phone_alias_touch() from public;
revoke all on function public.aani_account_phone_alias_touch() from anon;
revoke all on function public.aani_account_phone_alias_touch() from authenticated;

drop trigger if exists account_phone_aliases_touch on public.account_phone_aliases;
create trigger account_phone_aliases_touch
  before update on public.account_phone_aliases
  for each row execute function public.aani_account_phone_alias_touch();

-- إضافة/تغيير رقم الحساب في عبارة واحدة ذرية.
-- 23505 (unique_violation) تعني أن الرقم مستخدم في حساب آخر، والعبارة كلها
-- تُرحّل فيبقى الرقم السابق دون تغيير. 22023 (invalid_parameter_value) تعني
-- أن الحساب أو الرقم غير صالح.
create or replace function public.aani_set_account_phone_alias(
  p_user_id uuid,
  p_phone_e164 text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'invalid_account' using errcode = '22023';
  end if;

  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  insert into public.account_phone_aliases (user_id, phone_e164)
  values (p_user_id, p_phone_e164)
  on conflict (user_id) do update
    set phone_e164 = excluded.phone_e164,
        updated_at = now();

  return p_phone_e164;
end;
$$;

revoke all on function public.aani_set_account_phone_alias(uuid, text) from public;
revoke all on function public.aani_set_account_phone_alias(uuid, text) from anon;
revoke all on function public.aani_set_account_phone_alias(uuid, text) from authenticated;
grant execute on function public.aani_set_account_phone_alias(uuid, text) to service_role;

-- حذف رقم الحساب فقط. يعيد عدد الصفوف المحذوفة (0 أو 1).
create or replace function public.aani_delete_account_phone_alias(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
begin
  if p_user_id is null then
    raise exception 'invalid_account' using errcode = '22023';
  end if;

  delete from public.account_phone_aliases where user_id = p_user_id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.aani_delete_account_phone_alias(uuid) from public;
revoke all on function public.aani_delete_account_phone_alias(uuid) from anon;
revoke all on function public.aani_delete_account_phone_alias(uuid) from authenticated;
grant execute on function public.aani_delete_account_phone_alias(uuid) to service_role;

commit;
