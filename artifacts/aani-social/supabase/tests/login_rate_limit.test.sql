-- Asserts the shared login rate limiter: table shape, RLS with no policies, no
-- direct access for anon/authenticated/service_role, the atomic consume
-- function (allowed, remaining, retry_after), window reset, input validation,
-- one row per bucket under repeated concurrent-style calls, expired cleanup and
-- no raw phone/password/token columns.
--
-- What this proves: the database-side guarantee, in a throwaway PostgreSQL.
-- What it does not prove: real two-connection concurrency (the guarantee is the
-- single atomic upsert statement) or the Edge Function behaviour (covered by the
-- Deno tests with two handler instances sharing one fake store).

set client_min_messages = warning;

do $$
declare
  bucket_a text := 'login:phone:' || repeat('a', 64);
  bucket_b text := 'login:ip:' || repeat('b', 64);
  layout text;
  first_row record;
  rows_left integer;
  rejected boolean;
begin
  -- 1) الشكل.
  select string_agg(column_name || ':' || data_type, ',' order by ordinal_position)
    into layout
  from information_schema.columns
  where table_schema = 'public' and table_name = 'login_rate_limits';

  if layout is distinct from
     'bucket:text,window_started_at:timestamp with time zone,attempts:integer' then
    raise exception 'ASSERT: unexpected rate limit layout: %', layout;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'login_rate_limits'
      and column_name ~* '(pass|otp|token|secret|session|phone|ip|email)'
  ) then
    raise exception 'ASSERT: the limiter must not store raw phones, passwords, tokens or sessions';
  end if;

  -- 2) RLS بلا سياسات، وبلا وصول مباشر لأي دور.
  if not (select relrowsecurity from pg_class where oid = 'public.login_rate_limits'::regclass) then
    raise exception 'ASSERT: row level security must be enabled';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'login_rate_limits') <> 0 then
    raise exception 'ASSERT: no policy may exist on the limiter table';
  end if;

  if has_table_privilege('anon', 'public.login_rate_limits', 'SELECT')
     or has_table_privilege('authenticated', 'public.login_rate_limits', 'SELECT')
     or has_table_privilege('service_role', 'public.login_rate_limits', 'SELECT') then
    raise exception 'ASSERT: no role may read the limiter table directly';
  end if;

  if not has_function_privilege('service_role', 'public.aani_consume_login_attempt(text,integer,integer)', 'EXECUTE') then
    raise exception 'ASSERT: service_role must execute the consume function';
  end if;

  if has_function_privilege('anon', 'public.aani_consume_login_attempt(text,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.aani_consume_login_attempt(text,integer,integer)', 'EXECUTE') then
    raise exception 'ASSERT: anon and authenticated must not execute the consume function';
  end if;

  -- 3) الحد يعمل: 3 مسموحة ثم رفض مع زمن انتظار.
  select * into first_row from public.aani_consume_login_attempt(bucket_a, 600, 3);
  if not first_row.allowed or first_row.remaining <> 2 then
    raise exception 'ASSERT: the first attempt must be allowed with 2 remaining';
  end if;

  select * into first_row from public.aani_consume_login_attempt(bucket_a, 600, 3);
  if not first_row.allowed or first_row.remaining <> 1 then
    raise exception 'ASSERT: the second attempt must leave 1 remaining';
  end if;

  select * into first_row from public.aani_consume_login_attempt(bucket_a, 600, 3);
  if not first_row.allowed or first_row.remaining <> 0 then
    raise exception 'ASSERT: the third attempt must leave 0 remaining';
  end if;

  select * into first_row from public.aani_consume_login_attempt(bucket_a, 600, 3);
  if first_row.allowed then
    raise exception 'ASSERT: the fourth attempt must be refused';
  end if;
  if first_row.remaining <> 0 or first_row.retry_after_seconds < 1 then
    raise exception 'ASSERT: a refusal must report zero remaining and a wait time';
  end if;

  -- 4) النافذة تنتهي فيُسمح من جديد.
  update public.login_rate_limits
  set window_started_at = now() - interval '11 minutes'
  where bucket = bucket_a;

  select * into first_row from public.aani_consume_login_attempt(bucket_a, 600, 3);
  if not first_row.allowed or first_row.remaining <> 2 then
    raise exception 'ASSERT: an expired window must start over';
  end if;

  -- 5) مدخلات غير صالحة تُرفض.
  rejected := false;
  begin
    perform public.aani_consume_login_attempt('short', 600, 3);
  exception when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: a short bucket must be refused';
  end if;

  rejected := false;
  begin
    perform public.aani_consume_login_attempt(bucket_a, 0, 3);
  exception when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: an invalid window must be refused';
  end if;

  rejected := false;
  begin
    perform public.aani_consume_login_attempt(bucket_a, 600, 0);
  exception when invalid_parameter_value then rejected := true;
  end;
  if not rejected then
    raise exception 'ASSERT: an invalid limit must be refused';
  end if;

  -- 6) صف واحد لكل مفتاح بعد عدة زيادةات (عبارة واحدة ذرية).
  select count(*) into rows_left from public.login_rate_limits where bucket = bucket_a;
  if rows_left <> 1 then
    raise exception 'ASSERT: one bucket must keep exactly one row (got %)', rows_left;
  end if;

  -- 7) نافذة قديمة تُنظَّف عند الاستدعاء التالي.
  insert into public.login_rate_limits (bucket, window_started_at, attempts)
  values (bucket_b, now() - interval '3 days', 5);

  perform public.aani_consume_login_attempt(bucket_b, 600, 3);

  select count(*) into rows_left from public.login_rate_limits where bucket = bucket_b;
  if rows_left <> 1 then
    raise exception 'ASSERT: an old window must be reset, not duplicated';
  end if;
end;
$$;

delete from public.login_rate_limits;

\echo 'login_rate_limits: all assertions passed'
