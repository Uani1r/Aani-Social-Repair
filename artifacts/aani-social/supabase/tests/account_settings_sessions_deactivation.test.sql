-- اختبار ترحيل إعدادات الحساب: الجلسات، حارس is_deactivated، التعطيل والتفعيل.
--
-- يُشغَّل على بيئة harness/account_settings_schema.sql بعد تطبيق الترحيل، ثم
-- يُعاد الترحيل ويُعاد الاختبار (idempotency) من CI.
-- لا يلمس أي مشروع Supabase حقيقي، ولا يحذف أي حساب.

\set ON_ERROR_STOP on

-- 1) صلاحيات الدوال: authenticated فقط، وليس anon.
do $$
begin
  if not has_function_privilege('authenticated', 'public.aani_account_sessions()', 'execute') then
    raise exception 'authenticated must read its sessions';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_deactivate_account()', 'execute') then
    raise exception 'authenticated must deactivate its account';
  end if;
  if not has_function_privilege('authenticated', 'public.aani_reactivate_account()', 'execute') then
    raise exception 'authenticated must reactivate its account';
  end if;
  if has_function_privilege('anon', 'public.aani_account_sessions()', 'execute') then
    raise exception 'anon must not read sessions';
  end if;
  if has_function_privilege('anon', 'public.aani_deactivate_account()', 'execute') then
    raise exception 'anon must not deactivate an account';
  end if;
  if has_function_privilege('authenticated', 'public.aani_current_session_id()', 'execute') then
    raise exception 'the session id helper must stay server-side';
  end if;
end
$$;

-- 2) مشغّل الحارس موجود مرة واحدة فقط.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_trigger
  where tgname = 'aani_guard_account_deactivation'
    and tgrelid = 'public.profiles'::regclass
    and not tgisinternal;
  if v_count <> 1 then
    raise exception 'expected exactly one deactivation guard trigger, found %', v_count;
  end if;
end
$$;

-- 3) جلسات الحساب: صفوف المستخدم الحالي وحدها.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.session_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);

do $$
declare
  v_total integer;
  v_foreign integer;
begin
  select count(*) into v_total from public.aani_account_sessions();
  if v_total <> 2 then
    raise exception 'expected the two sessions of the current user, found %', v_total;
  end if;

  select count(*) into v_foreign
  from public.aani_account_sessions() s
  where s.id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if v_foreign <> 0 then
    raise exception 'another user session must never be returned';
  end if;
end
$$;

-- 4) تحديث مباشر لـ is_deactivated يُرفض.
do $$
begin
  begin
    update public.profiles
      set is_deactivated = true
      where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'a direct is_deactivated update must be refused';
  exception
    when insufficient_privilege then
      null; -- المتوقع: 42501 من الحارس
  end;

  if (select is_deactivated from public.profiles
      where id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'the refused update must not change the flag';
  end if;
end
$$;

-- 5) التعطيل: يضبط العلامة، ينهي الجلسة الأخرى، ويُبقي الحالية.
do $$
begin
  if public.aani_deactivate_account() is not true then
    raise exception 'deactivation must return true';
  end if;

  if not (select is_deactivated from public.profiles
          where id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'deactivation must set the flag';
  end if;

  if exists (select 1 from auth.sessions
             where id = 'aaaaaaaa-0000-0000-0000-000000000002') then
    raise exception 'the other session must be deleted';
  end if;

  if not exists (select 1 from auth.sessions
                 where id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'the current session must survive';
  end if;

  -- الجلسة الأخرى لمستخدم آخر لا تُمس.
  if not exists (select 1 from auth.sessions
                 where id = 'bbbbbbbb-0000-0000-0000-000000000001') then
    raise exception 'another user session must never be deleted';
  end if;
end
$$;

-- 6) إعادة التفعيل تعيد العلامة إلى false.
do $$
begin
  if public.aani_reactivate_account() is not true then
    raise exception 'reactivation must return true';
  end if;
  if (select is_deactivated from public.profiles
      where id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'reactivation must clear the flag';
  end if;
end
$$;

-- 7) anon لا يستطيع تنفيذ أي من الدوال.
reset role;
set role anon;
do $$
begin
  begin
    perform public.aani_deactivate_account();
    raise exception 'anon must not deactivate an account';
  exception
    when insufficient_privilege then
      null;
  end;
end
$$;

reset role;
\echo 'account settings migration: all assertions passed'
