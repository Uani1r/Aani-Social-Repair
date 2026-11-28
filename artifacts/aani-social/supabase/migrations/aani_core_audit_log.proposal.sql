-- =====================================================================
-- مقترح: دالة تدقيق عامة aani_core_audit_log (للمراجعة فقط)
-- =====================================================================
-- تحذير: هذا الملف مقترح للمراجعة فقط. لا يُطبَّق على إنتاج Supabase
-- تلقائياً. يجب التأكد من وجود جدول sandbox.admin_actions وصلاحياته
-- قبل التطبيق، واستشارة مسؤول القاعدة.
--
-- الغرض: توفير عقد RPC آمن لإدخال سجل تدقيق للعمليات الإدارية الحساسة
-- (حظر مستخدم، إشراف محتوى، منشور رسمي، إعلان، إلخ) يُستمد فيه هوية
-- الفاعل من auth.uid() داخل الدالة، ولا يُوثق في إدخال المتصفح.
--
-- يعتمد على جدول sandbox.admin_actions الموجود من ترحيل
-- 20270306000001_aani_sandbox_financial.sql.
-- =====================================================================

-- قائمة سماح للأفعال المسموح تسجيلها في التدقيق.
-- كل فعل يحدّد الأدوار المسموح لها بتسجيله، وأنواع الأهداف المسموحة.
-- يُستخرج الدور من دوال RPC الخادمة (aani_current_account_role equivalents).
create or replace function public.aani_core_audit_log(
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_result text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
begin
  -- هوية الفاعل تُستمد من auth.uid() حصراً داخل الدالة، لا من متصفح.
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '42501';
  end if;

  if p_result not in ('ok', 'error') then
    raise exception 'invalid result' using errcode = '22023';
  end if;

  -- جلب دور الفاعل من الخادم (يفترض وجود aani_current_account_role().
  -- إذا غابت، يُرفع خطأ لمنع تسجيل تدقيق بغير هوية مؤكدة).
  select public.aani_current_account_role() into v_actor_role;

  -- قائمة سماح: الأفعال المسموح والأدوار المسموحة لكل فعل وأنواع الأهداف.
  if p_action = 'ban_user' then
    -- المؤسس أو المسؤول فقط يمكنهما حظر مستخدم، والهدف يجب أن يكون مستخدم.
    if v_actor_role not in ('founder', 'admin') then
      raise exception 'role not authorized for action: ban_user' using errcode = '42501';
    end if;
    if p_target_type <> 'user' then
      raise exception 'invalid target type for action: ban_user' using errcode = '22023';
    end if;
  elsif p_action = 'moderate_content' then
    -- المؤسس أو المسؤول فقط يمكنهما الإشراف على المحتوى.
    if v_actor_role not in ('founder', 'admin') then
      raise exception 'role not authorized for action: moderate_content' using errcode = '42501';
    end if;
    if p_target_type not in ('post', 'comment') then
      raise exception 'invalid target type for action: moderate_content' using errcode = '22023';
    end if;
  elsif p_action = 'create_post' then
    -- المؤسس أو المسؤول أو الحساب الرسمي يمكنهم إنشاء منشور رسمي.
    if v_actor_role not in ('founder', 'admin', 'official') then
      raise exception 'role not authorized for action: create_post' using errcode = '42501';
    end if;
    if p_target_type <> 'post' then
      raise exception 'invalid target type for action: create_post' using errcode = '22023';
    end if;
  elsif p_action = 'send_announcement' then
    -- المؤسس أو المسؤول أو الحساب الرسمي يمكنهم إرسال إعلان.
    if v_actor_role not in ('founder', 'admin', 'official') then
      raise exception 'role not authorized for action: send_announcement' using errcode = '42501';
    end if;
    if p_target_type <> 'announcement' then
      raise exception 'invalid target type for action: send_announcement' using errcode = '22023';
    end if;
  elsif p_action = 'grant_coins' or p_action = 'refund_top_up' then
    -- المؤسس فقط يمكنه تنفيذ العمليات المالية.
    if v_actor_role <> 'founder' then
      raise exception 'role not authorized for action: ' || p_action using errcode = '42501';
    end if;
    if p_target_type <> 'user' and p_target_type <> 'top_up' then
      raise exception 'invalid target type for action: ' || p_action using errcode = '22023';
    end if;
  else
    -- أي فعل غير موجود في قائمة السماح يُرفض.
    raise exception 'action not allowed for audit logging: %', p_action using errcode = '42501';
  end if;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_reason, p_result);
end;
$$;

-- ملاحظة: تُمنح صلاحية التنفيذ للمصادقين فقط.
revoke all on function public.aani_core_audit_log(text, text, uuid, text, text) from public, anon;
grant execute on function public.aani_core_audit_log(text, text, uuid, text, text) to authenticated;

-- ملاحظة: جدول sandbox.admin_actions لديه سياسة RLS للقراءة فقط (المؤلف أو مؤسس).
-- لا حاجة لسياسة إدراج للعميل لأن الدالة security-definer تُدرج نيابة عنه
-- بعد التحقق من الدور والقائمة البيضاء.
