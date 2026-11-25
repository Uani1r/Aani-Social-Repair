-- تصحيحي: استعادة aani_unblock_user(uuid)
-- (الملف الأصلي 20261218000000_account_privacy_settings.sql لم يُطبَّق).
--
-- create or replace: آمن لإعادة التطبيق.
--
-- لماذا لا يكفي الحذف على blocked_user_id وحده: قاعدة الإنتاج تحتوي العمودين
-- blocked_user_id و blocked_id معاً، لكن وجود العمود لا يعني أنه مملوء. الصفوف
-- المكتوبة قبل ترحيل 20270204000000 حملت blocked_id وحده، فـblocked_user_id
-- فيها NULL. الحذف على blocked_user_id وحده يطابق صفراً، فتبقى علاقة الحظر
-- القديمة قائمة ولا يمكن إلغاؤها أبداً: aani_is_user_blocked (يقرأ
-- blocked_user_id) يراها غير موجودة، بينما نسخة aani_can_view_story المنشورة
-- تقرأ blocked_id وتواصل حجب القصص، وإعادة المحاولة لا تُصلح شيئاً.
--
-- الحل: يُبنى شرط الحذف من الأعمدة الموجودة فعلاً كما هي في
-- information_schema.columns: عند وجودهما (blocked_user_id = $2 or
-- blocked_id = $2)، وعند وجود واحد فقط العمود نفسه — مع blocker_id = المستدعي
-- دائماً.
--
-- لا حذف خاطئ: إن وُجد صف متناقض (أحد العمودين للمستهدف والآخر لقيمة غير
-- فارغة مختلفة) يتوقف الحذف برسالة 23514 بدل حذف علاقة مستخدم آخر.
-- ولا نجاح كاذب: يُعاد العدّ بعد الحذف، وأي صف متبقٍ يرفع 42501 بدل أن تُبلغ
-- الواجهة «تم إلغاء الحظر» وتبقى العلاقة (RLS، أو الصلاحيات، أو صف أُعيد).
--
-- الصلاحيات المحلية: 20270204000000 يمنح select, insert, delete على
-- public.user_blocks لـauthenticated، والسياسة الوحيدة للقراءة (select own)،
-- والدالة security definer بمالك postgres فلا تمر بالـRLS.
begin;

create or replace function public.aani_unblock_user(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  has_blocked_user_id boolean := false;
  has_blocked_id boolean := false;
  block_predicate text;
  contradictions bigint := 0;
  deleted_rows bigint := 0;
  remaining_rows bigint := 0;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to unblock' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public' and table_name = 'user_blocks'
  ) then
    raise exception 'public.user_blocks does not exist' using errcode = '42P01';
  end if;

  select coalesce(bool_or(column_name = 'blocked_user_id'), false),
         coalesce(bool_or(column_name = 'blocked_id'), false)
  into has_blocked_user_id, has_blocked_id
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'user_blocks'
    and column_name in ('blocked_user_id', 'blocked_id');

  if not has_blocked_user_id and not has_blocked_id then
    raise exception 'public.user_blocks has neither blocked_user_id nor blocked_id'
      using errcode = '42703';
  end if;

  if has_blocked_user_id and has_blocked_id then
    execute $q$
      select count(*)
      from public.user_blocks
      where blocker_id = $1
        and (
          (blocked_user_id = $2 and blocked_id is not null and blocked_id <> $2)
          or (blocked_id = $2 and blocked_user_id is not null and blocked_user_id <> $2)
        )
    $q$ into contradictions using actor_id, p_blocked_user_id;

    if contradictions > 0 then
      raise exception
        'public.user_blocks: % صفاً متناقضاً بين blocked_user_id وblocked_id — أوقف الحذف وراجع البيانات يدوياً',
        contradictions
        using errcode = '23514';
    end if;

    block_predicate := '(blocked_user_id = $2 or blocked_id = $2)';
  elsif has_blocked_user_id then
    block_predicate := '(blocked_user_id = $2)';
  else
    block_predicate := '(blocked_id = $2)';
  end if;

  execute 'delete from public.user_blocks where blocker_id = $1 and ' || block_predicate
    using actor_id, p_blocked_user_id;
  get diagnostics deleted_rows = row_count;

  execute 'select count(*) from public.user_blocks where blocker_id = $1 and ' || block_predicate
    into remaining_rows
    using actor_id, p_blocked_user_id;

  if remaining_rows > 0 then
    raise exception
      'public.user_blocks: % صفاً بقي بعد الحذف (حُذف %) — تحقق من RLS وصلاحيات الحذف',
      remaining_rows, deleted_rows
      using errcode = '42501';
  end if;
end;
$$;

alter function public.aani_unblock_user(uuid) owner to postgres;
revoke all on function public.aani_unblock_user(uuid) from public, anon;
grant execute on function public.aani_unblock_user(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
