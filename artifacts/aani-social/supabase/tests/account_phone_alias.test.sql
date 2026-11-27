-- Asserts the account phone alias migration: table shape, RLS with no policies,
-- no direct anon/authenticated access, E.164 + uniqueness constraints, atomic
-- replace that keeps the previous number, per-user delete, cascade on user
-- deletion, and no password/OTP/session columns.
--
-- What this proves: the database-level guarantees above, in a throwaway
-- PostgreSQL with a reduced auth schema. What it does not prove: real
-- two-connection concurrency (the guarantee is the UNIQUE constraint and the
-- single-statement upsert), nor the Edge Function behaviour.

set client_min_messages = warning;

do $$
declare
  a uuid := '11111111-1111-4111-8111-111111111111';
  b uuid := '22222222-2222-4222-8222-222222222222';
  c uuid := '33333333-3333-4333-8333-333333333333';
  layout text;
  rejected boolean;
  v text;
  removed integer;
  old_updated timestamptz;
begin
  -- الحسابات الموجودة في auth.users لهذا الاختبار (يُنشئها الـharness، ويُعاد
  -- إنشاؤها هنا ليعمل الاختبار بعد تطبيق الترحيل مرة ثانية).
  insert into auth.users (id) values (a), (b), (c)
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------
  -- 1) الشكل: أربعة أعمدة فقط، بالأسماء والأنواع المطلوبة.
  -- ---------------------------------------------------------------------
  select string_agg(column_name || ':' || data_type, ',' order by ordinal_position)
    into layout
  from information_schema.columns
  where table_schema = 'public' and table_name = 'account_phone_aliases';

  if layout is distinct from
     'user_id:uuid,phone_e164:text,created_at:timestamp with time zone,updated_at:timestamp with time zone' then
    raise exception 'ASSERT: unexpected table layout: %', layout;
  end if;

  -- لا كلمات مرور ولا OTP ولا رموز جلسات.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'account_phone_aliases'
      and column_name ~* '(pass|otp|token|secret|session|code|jwt)'
  ) then
    raise exception 'ASSERT: the alias table must not store passwords, OTP or session tokens';
  end if;

  -- ---------------------------------------------------------------------
  -- 2) RLS مفعّل، وبلا أي سياسة (لا سياسة تكشف أرقام المستخدمين).
  -- ---------------------------------------------------------------------
  if not (select relrowsecurity from pg_class where oid = 'public.account_phone_aliases'::regclass) then
    raise exception 'ASSERT: row level security must be enabled';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'account_phone_aliases') <> 0 then
    raise exception 'ASSERT: no policy may exist on the alias table';
  end if;

  -- ---------------------------------------------------------------------
  -- 3) anon وauthenticated: لا صلاحيات على الجدول ولا على الدوال.
  -- ---------------------------------------------------------------------
  if has_table_privilege('anon', 'public.account_phone_aliases', 'SELECT')
     or has_table_privilege('anon', 'public.account_phone_aliases', 'INSERT')
     or has_table_privilege('anon', 'public.account_phone_aliases', 'UPDATE')
     or has_table_privilege('anon', 'public.account_phone_aliases', 'DELETE') then
    raise exception 'ASSERT: anon must have no table privileges';
  end if;

  if has_table_privilege('authenticated', 'public.account_phone_aliases', 'SELECT')
     or has_table_privilege('authenticated', 'public.account_phone_aliases', 'INSERT')
     or has_table_privilege('authenticated', 'public.account_phone_aliases', 'UPDATE')
     or has_table_privilege('authenticated', 'public.account_phone_aliases', 'DELETE') then
    raise exception 'ASSERT: authenticated must have no table privileges';
  end if;

  if has_function_privilege('anon', 'public.aani_set_account_phone_alias(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.aani_delete_account_phone_alias(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.aani_set_account_phone_alias(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.aani_delete_account_phone_alias(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: anon and authenticated must not execute the alias functions';
  end if;

  -- الخدمة الخلفية وحدها: قراءة ونداء الدوال، وبلا كتابة مباشرة على الجدول.
  if not has_table_privilege('service_role', 'public.account_phone_aliases', 'SELECT') then
    raise exception 'ASSERT: service_role must be able to read the alias table';
  end if;

  if has_table_privilege('service_role', 'public.account_phone_aliases', 'INSERT')
     or has_table_privilege('service_role', 'public.account_phone_aliases', 'UPDATE')
     or has_table_privilege('service_role', 'public.account_phone_aliases', 'DELETE') then
    raise exception 'ASSERT: service_role must write only through the alias functions';
  end if;

  if not has_function_privilege('service_role', 'public.aani_set_account_phone_alias(uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.aani_delete_account_phone_alias(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: service_role must execute the alias functions';
  end if;

  -- ---------------------------------------------------------------------
  -- 4) الصيغة: رقم محلي أو غير E.164 يُرفض، ورقم E.164 يُقبل بلا SMS.
  -- ---------------------------------------------------------------------
  rejected := false;
  begin
    perform public.aani_set_account_phone_alias(a, '07701234567');
  exception
    when check_violation or invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a local (non E.164) number must be rejected';
  end if;

  rejected := false;
  begin
    insert into public.account_phone_aliases (user_id, phone_e164) values (a, '+96477');
  exception
    when check_violation then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a too-short number must violate the E.164 check';
  end if;

  -- الحساب a يحصل على رقمه بصيغة E.164 عبر الدالة.
  if public.aani_set_account_phone_alias(a, '+9647701234567') <> '+9647701234567' then
    raise exception 'ASSERT: setting a valid E.164 number must succeed';
  end if;

  if public.aani_set_account_phone_alias(b, '+9647709876543') <> '+9647709876543' then
    raise exception 'ASSERT: the second account must get its own number';
  end if;

  -- ---------------------------------------------------------------------
  -- 5) رقم واحد لكل حساب: صف ثانٍ للحساب نفسه يُرفض.
  -- ---------------------------------------------------------------------
  rejected := false;
  begin
    insert into public.account_phone_aliases (user_id, phone_e164)
    values (a, '+9647701111111');
  exception
    when unique_violation then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: one account must have at most one alias';
  end if;

  -- ---------------------------------------------------------------------
  -- 6) التفرّد على مستوى الحسابات: الرقم نفسه لحساب آخر يُرفض.
  -- ---------------------------------------------------------------------
  rejected := false;
  begin
    perform public.aani_set_account_phone_alias(b, '+9647701234567');
  exception
    when unique_violation then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a number taken by another account must be refused';
  end if;

  -- ---------------------------------------------------------------------
  -- 7) ذرية التحديث: فشل التحديث يُبقي الرقم السابق دون تغيير.
  -- ---------------------------------------------------------------------
  select phone_e164 into v from public.account_phone_aliases where user_id = b;
  if v <> '+9647709876543' then
    raise exception 'ASSERT: the previous number must stay after a failed replace (got %)', v;
  end if;

  -- والصف الأصلي للحساب a ما زال رقمه الأول.
  select phone_e164 into v from public.account_phone_aliases where user_id = a;
  if v <> '+9647701234567' then
    raise exception 'ASSERT: the first account must keep its number (got %)', v;
  end if;

  -- ---------------------------------------------------------------------
  -- 8) التغيير الناجح يحدّث updated_at، والتاريخ يُحدَّث معه.
  -- ---------------------------------------------------------------------
  update public.account_phone_aliases
  set updated_at = timestamptz '2000-01-01 00:00:00+00'
  where user_id = b;

  perform public.aani_set_account_phone_alias(b, '+9647705555555');

  select updated_at into old_updated from public.account_phone_aliases where user_id = b;
  if old_updated <= timestamptz '2000-01-01 00:00:00+00' then
    raise exception 'ASSERT: updated_at must move with each change';
  end if;

  -- ---------------------------------------------------------------------
  -- 9) الحذف لصاحب الرقم فقط.
  -- ---------------------------------------------------------------------
  if public.aani_delete_account_phone_alias(b) <> 1 then
    raise exception 'ASSERT: deleting an existing alias must remove one row';
  end if;

  if exists (select 1 from public.account_phone_aliases where user_id = b) then
    raise exception 'ASSERT: the deleted alias must be gone';
  end if;

  if not exists (select 1 from public.account_phone_aliases where user_id = a) then
    raise exception 'ASSERT: deleting one account must not touch another';
  end if;

  if public.aani_delete_account_phone_alias(b) <> 0 then
    raise exception 'ASSERT: deleting a missing alias must remove nothing';
  end if;

  -- ---------------------------------------------------------------------
  -- 10) الحذف المتسلسل مع حذف الحساب، وربط المفتاح الأجنبي بـ auth.users.
  -- ---------------------------------------------------------------------
  perform public.aani_set_account_phone_alias(c, '+9647706666666');

  rejected := false;
  begin
    perform public.aani_set_account_phone_alias('44444444-4444-4444-8444-444444444444'::uuid, '+9647707777777');
  exception
    when foreign_key_violation then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: an alias must reference an existing auth user';
  end if;

  delete from auth.users where id = c;
  if exists (select 1 from public.account_phone_aliases where user_id = c) then
    raise exception 'ASSERT: deleting the account must delete its alias';
  end if;

  -- ---------------------------------------------------------------------
  -- 11) ضمان التزامن: قيد UNIQUE واحد على phone_e164 هو ما يمنع حجز الرقم
  -- نفسه. هذا فحص للقيد في جلسة واحدة، وليس اختبار اتصالين متزامنين.
  -- ---------------------------------------------------------------------
  if not exists (
    select 1
    from pg_index i
    join pg_attribute att on att.attrelid = i.indrelid and att.attnum = i.indkey[0]
    where i.indrelid = 'public.account_phone_aliases'::regclass
      and i.indisunique
      and i.indnkeyatts = 1
      and att.attname = 'phone_e164'
  ) then
    raise exception 'ASSERT: phone_e164 must carry a single-column UNIQUE index';
  end if;

  -- تنظيف ما بقي ليعاد الاختبار بلا تعارض.
  perform public.aani_delete_account_phone_alias(a);
  removed := public.aani_delete_account_phone_alias(c);
  if removed <> 0 then
    raise exception 'ASSERT: cleanup must find no row for the removed account';
  end if;
end;
$$;

\echo 'account_phone_aliases: all assertions passed'
