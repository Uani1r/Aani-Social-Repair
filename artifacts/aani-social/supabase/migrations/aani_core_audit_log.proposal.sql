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

-- دالة التدقيق العامة (security-definer، تُدرج في sandbox.admin_actions).
-- هوية الفاعل تُستمد من auth.uid() داخل الدالة، وليس من 매개 المتصفح.
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
begin
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '42501';
  end if;

  if p_result not in ('ok', 'error') then
    raise exception 'invalid result' using errcode = '22023';
  end if;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_reason, p_result);
end;
$$;

-- ملاحظة: تُمنح صلاحية التنفيذ للمصادقين فقط.
revoke all on function public.aani_core_audit_log(text, text, uuid, text, text) from public, anon;
grant execute on function public.aani_core_audit_log(text, text, uuid, text, text) to authenticated;

-- ملاحظة: جدول sandbox.admin_actions لديه سياسة RSL للقراءة فقط (المؤلف أو مؤسس).
-- لا حاجة لسياسة إدراج للعميل لأن الدالة security-definer تُدخل نيابة عنه.
