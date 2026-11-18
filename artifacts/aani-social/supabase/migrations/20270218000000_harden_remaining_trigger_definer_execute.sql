-- ============================================================================
-- تصليب دوال المشغّلات وSECURITY DEFINER المتبقية
--
-- ما يفعله هذا الترحيل فقط:
--   1) سحب EXECUTE من PUBLIC و anon و authenticated عن:
--        aani_attach_notification_content_metadata()
--        aani_sync_post_counters()
--        aani_sync_post_privacy_counters()
--        create_profile_for_new_user()
--        aani_notify_new_comment()
--   2) ضبط search_path = '' للدوال:
--        aani_attach_notification_content_metadata()
--        aani_sync_post_counters()
--        aani_sync_post_privacy_counters()
--        aani_notify_new_comment()
--   3) سحب EXECUTE من anon فقط عن:
--        aani_is_user_blocked(uuid, uuid)
--
-- لا يُغيَّر:
--   * صلاحيات service_role: تُحفظ كما هي بالضبط (تُقاس قبل السحب وتُعاد إن كانت
--     قائمة، لأن سحب PUBLIC قد يقطع صلاحية لم تكن إلا عبره).
--   * aani_can_read_post(uuid, uuid): وصول anon إليها مقصود ولم تُلمس.
--   * أجسام الدوال أو المشغّلات أو أي كائن آخر.
--
-- aani_notify_new_comment غير موجودة في ملفات هذا المستودع (تُعرَّف في قاعدة
-- البيانات فقط)، لذا تُطبَّق عليها التغييرات إن وُجدت ويُسجّل NOTICE إن غابت.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) التطبيق
-- ============================================================================
do $$
declare
  -- تُسحب من PUBLIC و anon و authenticated
  v_restricted text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.create_profile_for_new_user()',
    'public.aani_notify_new_comment()'
  ];
  -- تُضاف إليها search_path = '' (بلا create_profile_for_new_user)
  v_harden_path text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.aani_notify_new_comment()'
  ];
  -- يُسحب منها EXECUTE من anon فقط
  v_anon_only text[] := array[
    'public.aani_is_user_blocked(uuid, uuid)'
  ];
  v_signature text;
  v_function regprocedure;
  v_service_keep boolean;
begin
  foreach v_signature in array v_restricted
  loop
    v_function := to_regprocedure(v_signature);

    if v_function is null then
      raise notice 'aani: % غير موجودة في هذا المخطط — تخطّي سحب الصلاحيات.', v_signature;
      continue;
    end if;

    -- نحفظ صلاحية service_role كما هي قبل سحب PUBLIC
    v_service_keep := has_function_privilege('service_role', v_function, 'EXECUTE');

    execute format('revoke execute on function %s from public', v_signature);
    execute format('revoke execute on function %s from anon', v_signature);
    execute format('revoke execute on function %s from authenticated', v_signature);

    if v_service_keep then
      execute format('grant execute on function %s to service_role', v_signature);
    end if;
  end loop;

  foreach v_signature in array v_harden_path
  loop
    if to_regprocedure(v_signature) is null then
      raise notice 'aani: % غير موجودة في هذا المخطط — تخطّي ضبط search_path.', v_signature;
      continue;
    end if;

    execute format('alter function %s set search_path = %L', v_signature, '');
  end loop;

  foreach v_signature in array v_anon_only
  loop
    if to_regprocedure(v_signature) is null then
      raise notice 'aani: % غير موجودة في هذا المخطط — تخطّي سحب صلاحية anon.', v_signature;
      continue;
    end if;

    execute format('revoke execute on function %s from anon', v_signature);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_restricted text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.create_profile_for_new_user()',
    'public.aani_notify_new_comment()'
  ];
  v_harden_path text[] := array[
    'public.aani_attach_notification_content_metadata()',
    'public.aani_sync_post_counters()',
    'public.aani_sync_post_privacy_counters()',
    'public.aani_notify_new_comment()'
  ];
  v_signature text;
  v_function oid;
  v_public_execute boolean;
  v_config text[];
begin
  -- 2.1 الدوال الخمس: لا PUBLIC، لا anon، لا authenticated
  foreach v_signature in array v_restricted
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

  -- 2.2 search_path = '' للدوال الأربع
  foreach v_signature in array v_harden_path
  loop
    if to_regprocedure(v_signature) is null then
      continue;
    end if;

    select proc.proconfig into v_config
    from pg_proc as proc
    where proc.oid = v_signature::regprocedure::oid;

    if v_config is null or not ('search_path=""' = any (v_config)) then
      raise exception 'aani: لم يُضبط search_path = '''' على % (proconfig=%).', v_signature,
        coalesce(array_to_string(v_config, ','), 'null')
        using errcode = '22023';
    end if;
  end loop;

  -- 2.3 aani_is_user_blocked: anon فقط سُحبت، وauthenticated باقية
  if to_regprocedure('public.aani_is_user_blocked(uuid, uuid)') is not null then
    if has_function_privilege('anon', 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'aani: ما زال anon يملك EXECUTE على public.aani_is_user_blocked.'
        using errcode = '42501';
    end if;

    if not has_function_privilege('authenticated', 'public.aani_is_user_blocked(uuid, uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'aani: فقدان صلاحية authenticated على public.aani_is_user_blocked — لم يكن مقصوداً.'
        using errcode = '42501';
    end if;
  end if;

  -- 2.4 aani_can_read_post لم تُلمس: anon ما زال يملكها (وصول مقصود)
  if to_regprocedure('public.aani_can_read_post(uuid, uuid)') is not null then
    if not has_function_privilege('anon', 'public.aani_can_read_post(uuid, uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'aani: anon فقد صلاحية aani_can_read_post — كان يجب ألا تُلمس.'
        using errcode = '42501';
    end if;
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select p.oid::regprocedure::text, p.prosecdef, p.proconfig
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('aani_attach_notification_content_metadata','aani_sync_post_counters',
--                      'aani_sync_post_privacy_counters','create_profile_for_new_user',
--                      'aani_notify_new_comment','aani_is_user_blocked','aani_can_read_post');
