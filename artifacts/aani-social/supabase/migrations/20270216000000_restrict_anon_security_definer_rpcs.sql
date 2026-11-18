-- ============================================================================
-- تقييد استدعاء دوال SECURITY DEFINER من anon
--
-- الهدف: ألا يستطيع anon تنفيذ دوال RPC التي تتجاوز RLS، مع إبقاء الوصول
-- للمستخدمين المسجّلين (authenticated) و service_role كما هو مطلوب.
--
-- الدوال المشمولة:
--   aani_can_view_story(uuid, uuid)          → authenticated + service_role
--   aani_mark_conversation_read(uuid)        → authenticated + service_role
--   aani_mark_messages_delivered(uuid[])     → authenticated + service_role
--   aani_cleanup_old_notifications()         → authenticated + service_role
--   aani_story_exists(uuid)                  → داخلية فقط (تُسحب من الجميع)
--
-- aani_story_exists دالة SECURITY DEFINER يستدعيها aani_create_story (وهي
-- SECURITY DEFINER أيضاً، ومالكها postgres). سحب EXECUTE من كل الأدوار لا
-- يعطّلها في هذا المسار: التنفيذ داخل دالة SECURITY DEFINER يجري بصلاحيات
-- المالك، ومالك الدالة يملك EXECUTE دائماً. لذلك يجب التأكد قبل السحب من أن
-- aani_create_story هي SECURITY DEFINER فعالاً، ومن عدم وجود أي دالة
-- SECURITY INVOKER تستدعي aani_story_exists (وإلا لانكسر مسارها).
--
-- لا تُغيَّر أي دالة أو سياسة أو جدول آخر. آمن لإعادة التشغيل.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) شروط مسبقة
-- ============================================================================
do $$
declare
  v_open_functions text[] := array[
    'public.aani_can_view_story(uuid, uuid)',
    'public.aani_mark_conversation_read(uuid)',
    'public.aani_mark_messages_delivered(uuid[])',
    'public.aani_cleanup_old_notifications()'
  ];
  v_internal_function text := 'public.aani_story_exists(uuid)';
  v_signature text;
  v_missing text[] := array[]::text[];
  v_role text;
  v_create_secdef boolean;
  v_create_calls boolean;
  v_invoker_caller text;
begin
  -- 1.1 كل الدوال موجودة بالتوقيع المطابق
  foreach v_signature in array v_open_functions
  loop
    if to_regprocedure(v_signature) is null then
      v_missing := v_missing || v_signature;
    end if;
  end loop;

  if to_regprocedure(v_internal_function) is null then
    v_missing := v_missing || v_internal_function;
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'aani: الدوال التالية غير موجودة بهذه التواقيع: %. أوقف الترحيل.', array_to_string(v_missing, ', ')
      using errcode = '42883';
  end if;

  -- 1.2 الأدوار المطلوبة موجودة
  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    if not exists (select 1 from pg_roles as r where r.rolname = v_role) then
      raise exception 'aani: الدور % غير موجود في هذا العنقود؛ لا يمكن ضبط صلاحياته.', v_role
        using errcode = '42704';
    end if;
  end loop;

  -- 1.3 aani_create_story: كل نسخها SECURITY DEFINER، وإحداها تستدعي aani_story_exists
  select bool_and(proc.prosecdef), bool_or(proc.prosrc ilike '%aani_story_exists%')
  into v_create_secdef, v_create_calls
  from pg_proc as proc
  join pg_namespace as ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname = 'aani_create_story';

  if v_create_secdef is null then
    raise exception 'aani: public.aani_create_story غير موجودة؛ لا يمكن التحقق من المسار الداخلي لـ aani_story_exists.'
      using errcode = '42883';
  end if;

  if not v_create_secdef then
    raise exception 'aani: إحدى نسخ public.aani_create_story ليست SECURITY DEFINER؛ سحب EXECUTE من aani_story_exists سيعطّل مسار النشر.'
      using errcode = '42501';
  end if;

  if not coalesce(v_create_calls, false) then
    raise exception 'aani: لا نسخة من public.aani_create_story تستدعي public.aani_story_exists؛ لا يمكن تأكيد أن الدالة داخلية فقط.'
      using errcode = '42883';
  end if;

  -- 1.4 لا دالة SECURITY INVOKER في public تستدعي aani_story_exists
  select proc.oid::regprocedure::text
  into v_invoker_caller
  from pg_proc as proc
  join pg_namespace as ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname <> 'aani_story_exists'
    and not proc.prosecdef
    and proc.prosrc ilike '%aani_story_exists%'
  limit 1;

  if v_invoker_caller is not null then
    raise exception 'aani: الدالة % تستدعي aani_story_exists وهي SECURITY INVOKER؛ سحب EXECUTE سيعطّل هذا المسار.', v_invoker_caller
      using errcode = '42501';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) التطبيق
-- ============================================================================

-- 2.1 الدوال الأربع المفتوحة للمستخدم المسجّل فقط
--     revoke من PUBLIC أولاً لأنه يمنح الجميع ضمنياً، ثم من anon صراحةً،
--     ثم منح صريح لـ authenticated و service_role (منح المتجر مفقوداً).
revoke execute on function public.aani_can_view_story(uuid, uuid) from public;
revoke execute on function public.aani_can_view_story(uuid, uuid) from anon;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;
grant execute on function public.aani_can_view_story(uuid, uuid) to service_role;

revoke execute on function public.aani_mark_conversation_read(uuid) from public;
revoke execute on function public.aani_mark_conversation_read(uuid) from anon;
grant execute on function public.aani_mark_conversation_read(uuid) to authenticated;
grant execute on function public.aani_mark_conversation_read(uuid) to service_role;

revoke execute on function public.aani_mark_messages_delivered(uuid[]) from public;
revoke execute on function public.aani_mark_messages_delivered(uuid[]) from anon;
grant execute on function public.aani_mark_messages_delivered(uuid[]) to authenticated;
grant execute on function public.aani_mark_messages_delivered(uuid[]) to service_role;

revoke execute on function public.aani_cleanup_old_notifications() from public;
revoke execute on function public.aani_cleanup_old_notifications() from anon;
grant execute on function public.aani_cleanup_old_notifications() to authenticated;
grant execute on function public.aani_cleanup_old_notifications() to service_role;

-- 2.2 دالة داخلية: تُسحب من الجميع، ويبقى تنفيذها من مالكها عبر
--     aani_create_story (SECURITY DEFINER).
revoke execute on function public.aani_story_exists(uuid) from public;
revoke execute on function public.aani_story_exists(uuid) from anon;
revoke execute on function public.aani_story_exists(uuid) from authenticated;
revoke execute on function public.aani_story_exists(uuid) from service_role;

-- ----------------------------------------------------------------------------
-- 3) اختبارات تحقق داخلية: أي فشل يُفشل الملف كاملاً.
-- ============================================================================
do $$
declare
  v_open_functions text[] := array[
    'public.aani_can_view_story(uuid, uuid)',
    'public.aani_mark_conversation_read(uuid)',
    'public.aani_mark_messages_delivered(uuid[])',
    'public.aani_cleanup_old_notifications()'
  ];
  v_internal_function text := 'public.aani_story_exists(uuid)';
  v_signature text;
  v_function oid;
  v_has_public_grant boolean;
  v_owner name;
  v_create_secdef boolean;
  v_create_calls boolean;
begin
  -- 3.1 الدوال الأربع: لا PUBLIC، لا anon، ونعم لـ authenticated و service_role
  foreach v_signature in array v_open_functions
  loop
    v_function := v_signature::regprocedure::oid;

    select exists (
      select 1
      from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
      where acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    )
    into v_has_public_grant
    from pg_proc as proc
    where proc.oid = v_function;

    if coalesce(v_has_public_grant, false) then
      raise exception 'aani: ما زال PUBLIC يملك EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;

    if has_function_privilege('anon', v_function, 'EXECUTE') then
      raise exception 'aani: الدور anon ما زال يملك EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;

    if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
      raise exception 'aani: الدور authenticated فقد صلاحية EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;

    if not has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'aani: الدور service_role فقد صلاحية EXECUTE على %.', v_signature
        using errcode = '42501';
    end if;
  end loop;

  -- 3.2 الدالة الداخلية: لا PUBLIC ولا أي من الأدوار الثلاثة
  v_function := v_internal_function::regprocedure::oid;

  select exists (
    select 1
    from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
  into v_has_public_grant
  from pg_proc as proc
  where proc.oid = v_function;

  if coalesce(v_has_public_grant, false) then
    raise exception 'aani: ما زال PUBLIC يملك EXECUTE على public.aani_story_exists.'
      using errcode = '42501';
  end if;

  if has_function_privilege('anon', v_function, 'EXECUTE')
     or has_function_privilege('authenticated', v_function, 'EXECUTE')
     or has_function_privilege('service_role', v_function, 'EXECUTE') then
    raise exception 'aani: إحدى الأدوار (anon/authenticated/service_role) ما زالت تملك EXECUTE على public.aani_story_exists.'
      using errcode = '42501';
  end if;

  -- 3.3 المالك يحتفظ بالتنفيذ ⇒ المسار الداخلي من aani_create_story سليم
  select pg_get_userbyid(proc.proowner) into v_owner
  from pg_proc as proc
  where proc.oid = v_function;

  if not has_function_privilege(v_owner, v_function, 'EXECUTE') then
    raise exception 'aani: مالك public.aani_story_exists (%) لا يملك EXECUTE؛ مسار aani_create_story سيتعطّل.', v_owner
      using errcode = '42501';
  end if;

  -- 3.4 aani_create_story ما زالت SECURITY DEFINER وتستدعي الدالة الداخلية
  select bool_and(proc.prosecdef), bool_or(proc.prosrc ilike '%aani_story_exists%')
  into v_create_secdef, v_create_calls
  from pg_proc as proc
  join pg_namespace as ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname = 'aani_create_story';

  if not coalesce(v_create_secdef, false) or not coalesce(v_create_calls, false) then
    raise exception 'aani: تحقق مسار aani_create_story → aani_story_exists فشل بعد التعديل (security_definer=%, calls=%).',
      v_create_secdef, v_create_calls
      using errcode = '42501';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط)
-- ============================================================================
-- select p.oid::regprocedure::text as function,
--        r.rolname,
--        has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
--   from pg_proc p
--   cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) r
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('aani_can_view_story', 'aani_mark_conversation_read',
--                      'aani_mark_messages_delivered', 'aani_cleanup_old_notifications',
--                      'aani_story_exists')
--  order by 1, 2;
