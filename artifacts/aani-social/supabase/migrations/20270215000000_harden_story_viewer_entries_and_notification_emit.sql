-- ============================================================================
-- تصليب أمني (الخطوة الأولى)
--   1) public.story_viewer_entries: تفعيل security_invoker حتى تخضع القراءة
--      لسياسات RLS الخاصة بـ public.story_views بدل صلاحيات مالك الـview.
--   2) public.aani_emit_interaction_notification(...): سحب EXECUTE من
--      PUBLIC و anon و authenticated، وإبقاؤها لـ service_role فقط.
--
-- السياق الذي بُني عليه هذا الترحيل (مراجعة المستودع):
--   * public.story_viewer_entries مُعرَّف في APPLY_MANUALLY_story_views_likes.sql
--     (سطر 158) فوق public.story_views، ولا يُنشأ في أي ترحيل رسمي. الـview
--     يعمل بصلاحيات المالك (postgres) فيتجاوز RLS على story_views، وهذا ما
--     يجعل أي مستخدم مسجَّل يقرأ مشاهدي أي قصة. security_invoker = true يعيد
--     القراءة إلى سياسة aani_story_views_select_story_owner لصاحب القصة فقط.
--   * aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid,
--     text, jsonb) و aani_notify_new_comment غير موجودتين في ملفات هذا
--     المستودع؛ هما كائنان قائمان في قاعدة الإنتاج. لذلك يبدأ الترحيل بشرط
--     مسبق صريح يوقف التنفيذ إن غاب أي منهما بدل تعديل صلاحيات كائن آخر.
--   * لا يوجد أي استدعاء لهذه الدالة في كود التطبيق (artifacts/aani-social/src)
--     ولا في ملفات SQL داخل المستودع؛ الاستدعاء الداخلي الوحيد المتوقع هو من
--     aani_notify_new_comment، وهي SECURITY DEFINER (يرث تحققها في الترحيل).
--
-- لا يُغيَّر أي جدول أو صف أو سياسة أخرى. آمن لإعادة التشغيل.
-- لا معاملة صريحة هنا: مشغّل الترحيلات ينفّذ الملف كدفعة واحدة، وأي فشل في
-- اختبارات التحقق أدناه يجعل الدفعة كلها تفشل دون تطبيق جزئي.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) شروط مسبقة: تفشل برسالة واضحة إن غاب الكائن أو الدور أو الإصدار.
-- ============================================================================
do $$
declare
  v_view regclass;
  v_view_kind text;
  v_func regprocedure;
  v_role text;
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'aani: security_invoker يتطلب PostgreSQL 15 أو أحدث (الإصدار الحالي: %).',
      current_setting('server_version')
      using errcode = '0A000';
  end if;

  v_view := to_regclass('public.story_viewer_entries');
  if v_view is null then
    raise exception 'aani: public.story_viewer_entries غير موجود في هذا المخطط؛ الكائن قائم في بيئة الإنتاج فقط (APPLY_MANUALLY_story_views_likes.sql) ولا يُنشأ هنا. أوقف الترحيل.'
      using errcode = '42P01';
  end if;

  select pg_class.relkind::text into v_view_kind
  from pg_class
  where pg_class.oid = v_view;

  if v_view_kind <> 'v' then
    raise exception 'aani: public.story_viewer_entries ليس view (relkind=%). أوقف الترحيل.', v_view_kind
      using errcode = '42809';
  end if;

  v_func := to_regprocedure(
    'public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb)'
  );
  if v_func is null then
    raise exception 'aani: public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) غير موجود بهذا التوقيع. أوقف الترحيل ولا تُغيَّر صلاحيات دالة أخرى.'
      using errcode = '42883';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    if not exists (select 1 from pg_roles as r where r.rolname = v_role) then
      raise exception 'aani: الدور % غير موجود في هذا العنقود؛ لا يمكن ضبط صلاحياته.', v_role
        using errcode = '42704';
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) التطبيق
-- ============================================================================

-- 2.1 القراءة عبر الـview تمر بصلاحيات المستدعي ⇒ تسري سياسة RLS على story_views
alter view public.story_viewer_entries set (security_invoker = true);

-- 2.2 الدالة تبقى قابلة للتنفيذ من مالكها ومن service_role فقط.
--     revoke من PUBLIC منفصل عن الدورين لأن PUBLIC يمنح الجميع ضمنياً.
revoke execute on function public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) from public;
revoke execute on function public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) from anon;
revoke execute on function public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) from authenticated;
grant execute on function public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 3) اختبارات تحقق داخلية: تفشل الترحيل (وتلغيه) إن لم يتحقق أي شرط.
-- ============================================================================
do $$
declare
  v_view regclass := 'public.story_viewer_entries'::regclass;
  v_func oid := 'public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb)'::regprocedure::oid;
  v_options text[];
  v_public_execute boolean;
  v_anon_execute boolean;
  v_authenticated_execute boolean;
  v_service_execute boolean;
  v_invoker_caller text;
  v_notify_exists boolean;
  v_notify_secdef boolean;
begin
  -- (أ) الـview يعمل بصلاحيات المستدعي
  select pg_class.reloptions into v_options
  from pg_class
  where pg_class.oid = v_view;

  if v_options is null or not ('security_invoker=true' = any (v_options)) then
    raise exception 'aani: لم يُضبط security_invoker=true على public.story_viewer_entries (reloptions=%).',
      coalesce(array_to_string(v_options, ','), 'null')
      using errcode = '22023';
  end if;

  -- (ب) لا منح EXECUTE لـ PUBLIC على الدالة
  select exists (
    select 1
    from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
  into v_public_execute
  from pg_proc as proc
  where proc.oid = v_func;

  if coalesce(v_public_execute, false) then
    raise exception 'aani: ما زال PUBLIC يملك EXECUTE على public.aani_emit_interaction_notification.'
      using errcode = '42501';
  end if;

  -- (ج) anon و authenticated بلا EXECUTE
  v_anon_execute := has_function_privilege('anon', v_func, 'EXECUTE');
  v_authenticated_execute := has_function_privilege('authenticated', v_func, 'EXECUTE');

  if v_anon_execute then
    raise exception 'aani: الدور anon ما زال يملك EXECUTE على public.aani_emit_interaction_notification.'
      using errcode = '42501';
  end if;

  if v_authenticated_execute then
    raise exception 'aani: الدور authenticated ما زال يملك EXECUTE على public.aani_emit_interaction_notification.'
      using errcode = '42501';
  end if;

  -- (د) service_role يحتفظ بالصلاحية
  v_service_execute := has_function_privilege('service_role', v_func, 'EXECUTE');

  if not v_service_execute then
    raise exception 'aani: service_role فقد صلاحية EXECUTE على public.aani_emit_interaction_notification.'
      using errcode = '42501';
  end if;

  -- (هـ) لا دالة SECURITY INVOKER داخل public تستدعي الدالة، وإلا لتعطّل مسارها
  select proc.oid::regprocedure::text into v_invoker_caller
  from pg_proc as proc
  join pg_namespace as ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.oid <> v_func
    and not proc.prosecdef
    and proc.prosrc ilike '%aani_emit_interaction_notification%'
  limit 1;

  if v_invoker_caller is not null then
    raise exception 'aani: الدالة % تستدعي aani_emit_interaction_notification وهي SECURITY INVOKER؛ سحب الصلاحية سيعطّل هذا المسار.', v_invoker_caller
      using errcode = '42501';
  end if;

  -- (و) المسار الداخلي المتوقع (aani_notify_new_comment) يجب أن يكون SECURITY DEFINER
  select true, bool_and(proc.prosecdef)
  into v_notify_exists, v_notify_secdef
  from pg_proc as proc
  join pg_namespace as ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname = 'aani_notify_new_comment'
  having count(*) > 0;

  if coalesce(v_notify_exists, false) then
    if not coalesce(v_notify_secdef, false) then
      raise exception 'aani: public.aani_notify_new_comment ليست SECURITY DEFINER؛ سحب EXECUTE من authenticated سيعطّل مسار الإشعار الداخلي.'
        using errcode = '42501';
    end if;
  else
    raise notice 'aani: public.aani_notify_new_comment غير موجودة في هذا المخطط؛ لم يُفحص المسار الداخلي.';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط)
-- ============================================================================
-- 1) خيارات الـview:
-- select c.reloptions from pg_class c where c.oid = 'public.story_viewer_entries'::regclass;
--
-- 2) صلاحيات الدالة كما تراها الأدوار فعلياً:
-- select r.rolname,
--        has_function_privilege(r.rolname,
--          'public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb)',
--          'EXECUTE') as can_execute
--   from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role');
--
-- 3) السجل الكامل لصلاحيات الدالة (يجب ألا يظهر grantee = 0 أي PUBLIC):
-- select * from aclexplode((
--   select coalesce(p.proacl, acldefault('f', p.proowner))
--     from pg_proc p
--    where p.oid = 'public.aani_emit_interaction_notification(uuid, uuid, text, uuid, uuid, uuid, text, jsonb)'::regprocedure
-- ));
