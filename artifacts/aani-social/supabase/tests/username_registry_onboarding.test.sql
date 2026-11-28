-- أثباتات ترحيل سجل أسماء المستخدمين وإكمال التسجيل على قاعدة مؤقتة.
--
-- ما يثبته: قيد 1–32 بعد إلغاء الحد الأدنى (3)، تطبيع الأحرف الكبيرة،
-- رفض المسافات والمحارف غير المسموحة، التفرد بلا حساسية لحالة الأحرف،
-- المطالبة الذرية ومنع السباق، رفض المحجوز والممنوع، عدم تجاوز ذلك بتحديث
-- مباشر من authenticated، تسجيل الموافقة ووقت الإكمال، سجل التدقيق، وتهيئة
-- الحسابات القائمة مرة واحدة فقط.
--
-- ما لا يثبته: تزامن اتصالين حقيقيين (الحسم هو القيد الفريد على
-- lower(username) والمطالبة داخل معاملة واحدة)، ولا سلوك Edge Functions.

set client_min_messages = warning;

-- =====================================================================
-- 1) البنية: الأعمدة والقيد والفهرس والجداول وRLS والصلاحيات
-- =====================================================================
do $$
declare
  columns_layout text;
  constraint_definition text;
  has_index boolean;
begin
  select string_agg(column_name || ':' || data_type, ',' order by column_name)
    into columns_layout
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'profiles'
    and column_name in ('onboarding_completed_at', 'terms_accepted_at', 'terms_version');

  if columns_layout is distinct from
     'onboarding_completed_at:timestamp with time zone,terms_accepted_at:timestamp with time zone,terms_version:text' then
    raise exception 'ASSERT: missing onboarding/consent columns (%)', columns_layout;
  end if;

  select pg_get_constraintdef(oid) into constraint_definition
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and conname = 'profiles_username_format_check';

  if constraint_definition is null then
    raise exception 'ASSERT: profiles_username_format_check is missing';
  end if;
  if position('{1,32}' in constraint_definition) = 0 then
    raise exception 'ASSERT: the username check must allow 1–32 characters (%)', constraint_definition;
  end if;
  if position('{3,32}' in constraint_definition) > 0 then
    raise exception 'ASSERT: the old 3-character minimum is still in the check (%)', constraint_definition;
  end if;
  if position('lower(username)' in constraint_definition) = 0 then
    raise exception 'ASSERT: the check must require lower-case usernames (%)', constraint_definition;
  end if;

  select exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'profiles_username_lower_idx'
  ) into has_index;
  if not has_index then
    raise exception 'ASSERT: the case-insensitive unique index is missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.username_registry'::regclass) then
    raise exception 'ASSERT: row level security must be enabled on the registry';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.username_registry_audit'::regclass) then
    raise exception 'ASSERT: row level security must be enabled on the audit log';
  end if;

  if has_table_privilege('anon', 'public.username_registry', 'SELECT')
     or has_table_privilege('authenticated', 'public.username_registry', 'SELECT')
     or has_table_privilege('authenticated', 'public.username_registry', 'INSERT')
     or has_table_privilege('authenticated', 'public.username_registry', 'UPDATE')
     or has_table_privilege('authenticated', 'public.username_registry', 'DELETE') then
    raise exception 'ASSERT: no client role may touch the registry directly';
  end if;

  if has_table_privilege('anon', 'public.username_registry_audit', 'SELECT')
     or has_table_privilege('authenticated', 'public.username_registry_audit', 'SELECT')
     or has_table_privilege('authenticated', 'public.username_registry_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.username_registry_audit', 'DELETE') then
    raise exception 'ASSERT: the audit log must not be reachable from a client role';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public'
        and tablename in ('username_registry', 'username_registry_audit')
        and 'authenticated' = any(roles)) <> 0 then
    raise exception 'ASSERT: no policy may grant authenticated access to the registry or the audit log';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_username_status(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.aani_claim_username(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.aani_complete_onboarding(text,text,date,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.aani_my_onboarding_state()', 'EXECUTE') then
    raise exception 'ASSERT: authenticated must execute the registry and onboarding functions';
  end if;

  if has_function_privilege('anon', 'public.aani_claim_username(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.aani_complete_onboarding(text,text,date,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.aani_my_onboarding_state()', 'EXECUTE') then
    raise exception 'ASSERT: anon must not claim usernames nor complete onboarding';
  end if;
end $$;

-- =====================================================================
-- 2) التهيئة: الأسماء القائمة محفوظة ومُسجَّلة، والحسابات القائمة مكتملة
-- =====================================================================
do $$
declare
  claimed integer;
begin
  if exists (select 1 from public.profiles where onboarding_completed_at is null) then
    raise exception 'ASSERT: existing accounts must not be asked to sign up again';
  end if;

  if exists (select 1 from public.profiles where username <> lower(username)) then
    raise exception 'ASSERT: existing usernames must be lower-cased, never renamed to another person';
  end if;

  if (select username from public.profiles where id = '11111111-1111-1111-1111-111111111111') <> 'a' then
    raise exception 'ASSERT: a one-character username must survive the migration';
  end if;

  select count(*) into claimed from public.username_registry where state = 'claimed';
  if claimed <> 3 then
    raise exception 'ASSERT: every existing username must be registered as claimed (got %)', claimed;
  end if;

  if exists (
    select 1 from public.profiles as profile
    left join public.username_registry as registry
      on registry.username = profile.username and registry.user_id = profile.id
    where registry.username is null
  ) then
    raise exception 'ASSERT: every existing username must have a registry row owned by its account';
  end if;
end $$;

-- =====================================================================
-- 3) الأسماء المقبولة: محرف واحد، رقم واحد، حرفان، رقمان، ثلاثة أرقام،
--    20 رقماً، 20 حرفاً، مختلط — والأحرف الكبيرة تُخزَّن صغيرة
-- =====================================================================
do $$
declare
  account_a constant uuid := '11111111-1111-1111-1111-111111111111';
  candidate text;
  stored text;
begin
  foreach candidate in array array[
    'x',
    '7',
    'ab',
    '12',
    '123',
    '12345678901234567890',
    'abcdefghijklmnopqrst',
    'a1.b_2',
    repeat('z', 32)
  ] loop
    update public.profiles set username = candidate where id = account_a;
    select username into stored from public.profiles where id = account_a;
    if stored is distinct from candidate then
      raise exception 'ASSERT: % must be accepted as a username (stored %)', candidate, stored;
    end if;
  end loop;

  update public.profiles set username = 'MiXeD' where id = account_a;
  select username into stored from public.profiles where id = account_a;
  if stored is distinct from 'mixed' then
    raise exception 'ASSERT: usernames must be stored lower-case (got %)', stored;
  end if;

  update public.profiles set username = 'a' where id = account_a;
end $$;

-- =====================================================================
-- 4) الأسماء المرفوضة: مسافة، محرف غير مسموح، عربي، أكثر من 32
-- =====================================================================
do $$
declare
  account_a constant uuid := '11111111-1111-1111-1111-111111111111';
  candidate text;
  rejected boolean;
begin
  foreach candidate in array array[
    'a b',
    'user-name',
    'user@name',
    'مستخدم',
    repeat('x', 33),
    ' '
  ] loop
    rejected := false;
    begin
      update public.profiles set username = candidate where id = account_a;
    exception
      when check_violation or invalid_parameter_value or not_null_violation then
        rejected := true;
    end;
    if not rejected then
      raise exception 'ASSERT: % must be refused as a username', candidate;
    end if;
  end loop;

  -- المسافة الطرفية تُطبَّع (تُحذف) ولا تُنشئ اسماً ثانياً.
  update public.profiles set username = '  user  ' where id = account_a;
  select username into candidate from public.profiles where id = account_a;
  if candidate is distinct from 'user' then
    raise exception 'ASSERT: surrounding spaces must be trimmed (got %)', candidate;
  end if;

  update public.profiles set username = 'a' where id = account_a;
  select username into candidate from public.profiles where id = account_a;
  if candidate <> 'a' then
    raise exception 'ASSERT: a refused username must not change the stored one (got %)', candidate;
  end if;
end $$;

-- =====================================================================
-- 5) التفرد بلا حساسية لحالة الأحرف + المطالبة الذرية (لا اسم مزدوج)
-- =====================================================================
do $$
declare
  account_a constant uuid := '11111111-1111-1111-1111-111111111111';
  account_b constant uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- B يحاول أخذ اسم A بأحرف كبيرة.
  begin
    update public.profiles set username = 'A' where id = account_b;
    raise exception 'ASSERT: a duplicate username (different case) must be refused';
  exception
    when unique_violation then null;
  end;

  -- مطالبتان متتاليتان لنفس الاسم الحرّ: الثانية تفشل.
  perform set_config('request.jwt.claim.sub', account_a::text, false);
  if public.aani_claim_username('race.name') <> 'race.name' then
    raise exception 'ASSERT: the first claim must succeed';
  end if;

  perform set_config('request.jwt.claim.sub', account_b::text, false);
  begin
    perform public.aani_claim_username('race.name');
    raise exception 'ASSERT: the second claim of the same username must fail';
  exception
    when unique_violation then null;
  end;

  -- صاحب الاسم الحالي يحتفظ به.
  perform set_config('request.jwt.claim.sub', account_a::text, false);
  if public.aani_claim_username('race.name') <> 'race.name' then
    raise exception 'ASSERT: the owner must keep its own username';
  end if;
  if public.aani_username_status('race.name') <> 'self' then
    raise exception 'ASSERT: the owner must see its own username as self';
  end if;

  perform set_config('request.jwt.claim.sub', account_b::text, false);
  if public.aani_username_status('race.name') <> 'claimed' then
    raise exception 'ASSERT: another account must see the username as claimed';
  end if;
end $$;

-- =====================================================================
-- 6) المحجوز والممنوع: لا مطالبة ولا تجاوز، وانتهاء الحجز يُتيح
-- =====================================================================
do $$
declare
  account_a constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into public.username_registry (username, state, actor_kind, reason)
  values ('vip', 'reserved', 'admin', 'reserved for a brand account')
  on conflict (username) do update set state = 'reserved', user_id = null;

  insert into public.username_registry (username, state, actor_kind, reason)
  values ('banned', 'blocked', 'admin', 'blocked by policy')
  on conflict (username) do update set state = 'blocked', user_id = null;

  perform set_config('request.jwt.claim.sub', account_a::text, false);

  if public.aani_username_status('vip') <> 'reserved' then
    raise exception 'ASSERT: a reserved username must be reported as reserved';
  end if;
  if public.aani_username_status('banned') <> 'blocked' then
    raise exception 'ASSERT: a blocked username must be reported as blocked';
  end if;

  begin
    perform public.aani_claim_username('vip');
    raise exception 'ASSERT: a reserved username must not be claimed';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.aani_claim_username('banned');
    raise exception 'ASSERT: a blocked username must not be claimed';
  exception
    when insufficient_privilege then null;
  end;

  -- حجز مؤقت منتهٍ: الاسم متاح من جديد.
  update public.username_registry set reserved_until = now() - interval '1 day' where username = 'vip';
  if public.aani_username_status('vip') <> 'available' then
    raise exception 'ASSERT: an expired reservation must free the username';
  end if;
  update public.username_registry set reserved_until = null where username = 'vip';

  if public.aani_username_status('free.name') <> 'available' then
    raise exception 'ASSERT: an unused username must be reported as available';
  end if;
  if public.aani_username_status('a b') <> 'invalid' then
    raise exception 'ASSERT: an invalid username must be reported as invalid';
  end if;
end $$;

-- =====================================================================
-- 7) لا تجاوز من REST: المستخدم العادي لا يكتب الاسم المحجوز/الممنوع ولا
--    أعمدة الموافقة، ولا يقرأ السجل ولا التدقيق
-- =====================================================================
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;

do $$
begin
  begin
    update public.profiles set username = 'vip' where id = auth.uid();
    raise exception 'ASSERT: a direct update must not bypass a reservation';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.profiles set username = 'banned' where id = auth.uid();
    raise exception 'ASSERT: a direct update must not bypass a block';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.profiles set username = 'user.b' where id = auth.uid();
    raise exception 'ASSERT: a direct update must not take another account username';
  exception
    when unique_violation then null;
  end;

  begin
    perform 1 from public.username_registry limit 1;
    raise exception 'ASSERT: authenticated must not read the registry';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.username_registry_audit limit 1;
    raise exception 'ASSERT: authenticated must not read the audit log';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.profiles set onboarding_completed_at = now() where id = auth.uid();
    raise exception 'ASSERT: onboarding_completed_at must not be writable directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.profiles set terms_accepted_at = now() where id = auth.uid();
    raise exception 'ASSERT: terms_accepted_at must not be writable directly';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

-- =====================================================================
-- 8) إكمال التسجيل: الموافقة إلزامية وتسجّل وقتها، والجنس صريح،
--    والاسم يُطالب به، وحالة الإكمال تُقرأ لصاحبها
-- =====================================================================
do $$
declare
  account_c constant uuid := '33333333-3333-3333-3333-333333333333';
  completed_at timestamptz;
  consented_at timestamptz;
  stored_version text;
  rejected boolean;
begin
  perform set_config('request.jwt.claim.sub', account_c::text, false);

  -- بلا موافقة: رفض.
  rejected := false;
  begin
    perform public.aani_complete_onboarding('c1', 'Account C', date '1990-05-06', 'female', '');
  exception
    when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a completion without consent must be refused';
  end if;

  -- بلا جنس صريح: رفض.
  rejected := false;
  begin
    perform public.aani_complete_onboarding('c1', 'Account C', date '1990-05-06', null, 'aani-terms-2026-11');
  exception
    when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a completion without an explicit gender must be refused';
  end if;

  -- تاريخ ميلاد غير صالح: رفض.
  rejected := false;
  begin
    perform public.aani_complete_onboarding('c1', 'Account C', current_date + 1, 'female', 'aani-terms-2026-11');
  exception
    when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a future birth date must be refused';
  end if;

  if public.aani_complete_onboarding('c1', 'Account C', date '1990-05-06', 'female', 'aani-terms-2026-11') <> 'c1' then
    raise exception 'ASSERT: a valid completion must claim the username';
  end if;

  select onboarding_completed_at, terms_accepted_at, terms_version
    into completed_at, consented_at, stored_version
  from public.profiles
  where id = account_c;

  if completed_at is null then
    raise exception 'ASSERT: completion must record onboarding_completed_at';
  end if;
  if consented_at is null or stored_version <> 'aani-terms-2026-11' then
    raise exception 'ASSERT: completion must record the consent time and version';
  end if;

  if (select username from public.profiles where id = account_c) <> 'c1' then
    raise exception 'ASSERT: completion must store the claimed username';
  end if;
  if (select full_name from public.profiles where id = account_c) <> 'Account C' then
    raise exception 'ASSERT: completion must store the full name';
  end if;
  if (select birth_date from public.profiles where id = account_c) <> date '1990-05-06' then
    raise exception 'ASSERT: completion must store birth_date';
  end if;
  if (select gender from public.profiles where id = account_c) <> 'female' then
    raise exception 'ASSERT: completion must store an explicit gender';
  end if;
  if (select state from public.username_registry where username = 'c1') is distinct from 'claimed' then
    raise exception 'ASSERT: the claimed username must be registered as claimed';
  end if;
  if (select username from public.aani_my_onboarding_state()) is distinct from 'c1' then
    raise exception 'ASSERT: the onboarding state must be readable by its owner';
  end if;
end $$;

-- =====================================================================
-- 9) سجل التدقيق: مطالبة وإتاحة مسجّلتان مع من فعلهما
-- =====================================================================
do $$
begin
  if not exists (
    select 1 from public.username_registry_audit
    where new_state = 'claimed' and actor_kind = 'system'
  ) then
    raise exception 'ASSERT: claims must be audited';
  end if;

  if not exists (
    select 1 from public.username_registry_audit
    where new_state = 'available' and reason like '%rename%'
  ) then
    raise exception 'ASSERT: releasing a username on rename must be audited';
  end if;

  if not exists (
    select 1 from public.username_registry_audit
    where username = 'c1' and new_user_id = '33333333-3333-3333-3333-333333333333'
  ) then
    raise exception 'ASSERT: the audit entry must record the owning account';
  end if;
end $$;

-- =====================================================================
-- 10) إعادة تطبيق الترحيل لا تُكمل حساباً جديداً (التهيئة مرة واحدة)
-- =====================================================================
insert into auth.users (id, email)
values ('44444444-4444-4444-4444-444444444444', 'late@example.com')
on conflict (id) do nothing;

insert into public.profiles (id, username, full_name)
values ('44444444-4444-4444-4444-444444444444', 'late', 'Late Account')
on conflict (id) do nothing;

\i artifacts/aani-social/supabase/migrations/20270314000000_profile_onboarding_and_username_registry.sql

do $$
begin
  if (select onboarding_completed_at from public.profiles
      where id = '44444444-4444-4444-4444-444444444444') is not null then
    raise exception 'ASSERT: re-applying the migration must not grandfather a new account';
  end if;
end $$;

-- =====================================================================
-- 11) حذف الحساب يُحرّر اسمه (سجل الاسم يُحذف معه، فلا اسم مملوك لحساب
--     محذوف، ولا يفشل الحذف على قيد username_registry_claim_shape)
-- =====================================================================
delete from auth.users where id = '44444444-4444-4444-4444-444444444444';

do $$
begin
  if exists (select 1 from public.profiles where id = '44444444-4444-4444-4444-444444444444') then
    raise exception 'ASSERT: deleting the account must delete its profile';
  end if;
  if exists (select 1 from public.username_registry where username = 'late') then
    raise exception 'ASSERT: deleting the account must free its username';
  end if;
end $$;

\echo 'username_registry_onboarding: all assertions passed'
