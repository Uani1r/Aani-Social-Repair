-- ============================================================================
-- تصليب صلاحيات دوال المشغّلات (SECURITY DEFINER) — ترحيل مستقل
--
-- ما يفعله هذا الترحيل فقط:
--   1) سحب EXECUTE من PUBLIC و anon و authenticated عن دوال المشغّلات الخمس:
--        aani_attach_notification_content_metadata()
--        aani_notify_new_comment()
--        aani_sync_post_counters()
--        aani_sync_post_privacy_counters()
--        create_profile_for_new_user()
--   2) aani_is_user_blocked(uuid, uuid): سحب EXECUTE من PUBLIC و anon،
--      ومنحه صريحاً لـ authenticated و service_role لأن سياسات RLS تعتمد عليه.
--
-- لا يُغيَّر في هذا الترحيل:
--   * تعريفات الدوال أو أجسامها أو أي مشغّل (trigger).
--   * أي سياسة RLS.
--   * صلاحيات aani_can_read_post(uuid, uuid): وصول anon إليها مقصود ولم تُلمس.
--   * صلاحية service_role على الدوال الخمس: تُقاس قبل السحب وتُعاد كما كانت،
--     لأن PUBLIC قد تكون مصدرها الوحيد.
--
-- aani_notify_new_comment() غير معرَّفة في ملفات هذا المستودع (كائن قائم في
-- قاعدة البيانات)، لذا تُطبَّق عليها التغييرات إن وُجدت ويُسجَّل NOTICE إن غابت.
-- الترحيل آمن لإعادة التشغيل: كل السحب والمنح idempotent.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) سحب EXECUTE عن دوال المشغّلات الخمس (PUBLIC و anon و authenticated)
-- ============================================================================
do $$
declare
  v_functions text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_notify_new_comment()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.create_profile_for_new_user()'
  ];
  v_signature text;
  v_function regprocedure;
  v_service_keep boolean;
begin
  foreach v_signature in array v_functions
  loop
    v_function := to_regprocedure(v_signature);

    if v_function is null then
      raise notice 'aani: % غير موجودة في هذا المخطط — تخطّي سحب الصلاحيات.', v_signature;
      continue;
    end if;

    -- نحفظ صلاحية service_role قبل سحب PUBLIC (قد تكون PUBLIC مصدرها الوحيد)
    v_service_keep := has_function_privilege('service_role', v_function, 'EXECUTE');

    execute format('revoke execute on function %s from public', v_signature);
    execute format('revoke execute on function %s from anon', v_signature);
    execute format('revoke execute on function %s from authenticated', v_signature);

    if v_service_keep then
      execute format('grant execute on function %s to service_role', v_signature);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) aani_is_user_blocked(uuid, uuid): authenticated و service_role فقط
-- ============================================================================
do $$
begin
  if to_regprocedure('public.aani_is_user_blocked(uuid, uuid)') is null then
    raise exception 'public.aani_is_user_blocked(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  execute 'revoke execute on function public.aani_is_user_blocked(uuid, uuid) from public';
  execute 'revoke execute on function public.aani_is_user_blocked(uuid, uuid) from anon';
  execute 'grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated';
  execute 'grant execute on function public.aani_is_user_blocked(uuid, uuid) to service_role';
end $$;

-- ----------------------------------------------------------------------------
-- 3) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_functions text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_notify_new_comment()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.create_profile_for_new_user()'
  ];
  v_signature text;
  v_function oid;
  v_public_execute boolean;
begin
  -- 3.1 الدوال الخمس: لا PUBLIC، لا anon، لا authenticated
  foreach v_signature in array v_functions
  loop
    if to_regprocedure(v_signature) is null then
      continue;
    end if;

    v_function := v_signature::regprocedure::oid;

    select exists (
      select 1
      from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
      where acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    )
    into v_public_execute
    from pg_proc as proc
    where proc.oid = v_function;

    if coalesce(v_public_execute, false) then
      raise exception 'aani: ما زال PUBLIC يملك EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;

    if has_function_privilege('anon', v_function, 'EXECUTE') then
      raise exception 'aani: ما زال anon يملك EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;

    if has_function_privilege('authenticated', v_function, 'EXECUTE') then
      raise exception 'aani: ما زال authenticated يملك EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;
  end loop;

  -- 3.2 aani_is_user_blocked: لا anon ولا PUBLIC، وauthenticated وservice_role يملكانها
  v_function := 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure::oid;

  select exists (
    select 1
    from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
  into v_public_execute
  from pg_proc as proc
  where proc.oid = v_function;

  if coalesce(v_public_execute, false) then
    raise exception 'aani: ما زال PUBLIC يملك EXECUTE على aani_is_user_blocked.'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', v_function, 'EXECUTE') then
    raise exception 'aani: ما زال anon يملك EXECUTE على aani_is_user_blocked.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
    raise exception 'aani: فقدان صلاحية authenticated على aani_is_user_blocked — لم يكن مقصوداً.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('service_role', v_function, 'EXECUTE') then
    raise exception 'aani: فقدان صلاحية service_role على aani_is_user_blocked — لم يكن مقصوداً.'
      using errcode = '42501';
  end if;

  -- 3.3 aani_can_read_post لم تُلمس: anon ما زال يملكها (وصول مقصود لسياسة الزوار)
  if to_regprocedure('public.aani_can_read_post(uuid, uuid)') is not null then
    if not has_function_privilege('anon', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'aani: anon فقد صلاحية aani_can_read_post — كان يجب ألا تُلمس.'
        using errcode = '42501';
    end if;
  end if;
end $$;

commit;
