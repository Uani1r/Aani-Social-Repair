begin;

-- تصحيح صلاحيات تنفيذ إعادة ترتيب قصص أبرز القصص.
--
-- الدالة أُنشئت في 20270217000000 مع revoke من public وgrant إلى
-- authenticated، لكن قواعد Supabase التي تمنح EXECUTE على دوال public
-- الجديدة للأدوار anon و authenticated عبر ALTER DEFAULT PRIVILEGES تحتفظ
-- بصلاحية anon على الدالة عند إنشائها. هذا الترحيل يغلقها صراحةً.
--
-- لا يُعاد تعريف الدالة هنا: لا جسم ولا توقيع ولا منطق ترتيب ولا أي بيانات
-- مستخدمين — صلاحيات التنفيذ فقط، وتعديل الترحيل السابق غير مطلوب.
revoke all on function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) from anon;
revoke all on function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) from public;
grant execute on function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) to authenticated;

-- تحقق داخل الترحيل نفسه: إن غابت الدالة أو بقي منح خاطئ يفشل الترحيل بدل
-- أن يُطبَّق تصحيح ناقص بصمت.
do $$
declare
  v_public_execute boolean;
begin
  if to_regprocedure('public.aani_reorder_profile_highlight_stories(uuid, uuid[])') is null then
    raise exception 'aani_reorder_profile_highlight_stories(uuid, uuid[]) must exist before its EXECUTE privileges are corrected';
  end if;

  select exists (
    select 1
    from pg_proc as function_row
    cross join lateral aclexplode(coalesce(function_row.proacl, acldefault('f', function_row.proowner))) as acl
    where function_row.oid = 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) into v_public_execute;

  if coalesce(v_public_execute, false) then
    raise exception 'PUBLIC must not be able to execute the reordering function';
  end if;

  if has_function_privilege('anon', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'anon must not be able to execute the reordering function';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'authenticated must be able to execute the reordering function';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
