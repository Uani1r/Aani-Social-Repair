-- اختبار عزل إعدادات المحادثات: A وB وC بهويات مصادقة حقيقية وسياسات RLS.
-- يُشغَّل بعد harness/message_conversation_settings_schema.sql ثم الترحيل،
-- ويُنظّف بياناته في النهاية فلا يترك أثراً.

\set ON_ERROR_STOP on

-- 0) الشكل والأمان: RLS مفعّلة، المنح كما هي، ولا سياسة قراءة تتجاوز العزل.
do $$
declare
  v_offender text;
begin
  if not (select relrowsecurity from pg_class
          where oid = 'public.message_conversation_settings'::regclass) then
    raise exception 'RLS must stay enabled on message_conversation_settings';
  end if;

  if not has_table_privilege('authenticated', 'public.message_conversation_settings', 'select')
     or not has_table_privilege('authenticated', 'public.message_conversation_settings', 'insert')
     or not has_table_privilege('authenticated', 'public.message_conversation_settings', 'update')
     or not has_table_privilege('authenticated', 'public.message_conversation_settings', 'delete') then
    raise exception 'the owner grants (select/insert/update/delete) must stay in place';
  end if;

  select string_agg(pol.polname, ', ') into v_offender
  from pg_policy pol
  join pg_class cls on cls.oid = pol.polrelid
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
    and cls.relname = 'message_conversation_settings'
    and pol.polpermissive
    and pol.polcmd in ('r', '*')
    and pg_get_expr(pol.polqual, pol.polrelid) like '%other_user_id%';

  if v_offender is not null then
    raise exception 'a permissive policy still reads foreign settings: %', v_offender;
  end if;
end
$$;

-- 1) A يقرأ إعداداته الخاصة، ولا يرى إعداد B.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', false);

do $$
declare
  v_own integer;
  v_foreign integer;
begin
  select count(*) into v_own
  from public.message_conversation_settings
  where user_id = 'a0000000-0000-0000-0000-00000000000a'
    and other_user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_own <> 1 then
    raise exception 'A must read its own settings row, found %', v_own;
  end if;

  select count(*) into v_foreign
  from public.message_conversation_settings
  where user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_foreign <> 0 then
    raise exception 'A must not read B settings, found %', v_foreign;
  end if;

  select count(*) into v_foreign from public.message_conversation_settings;
  if v_foreign <> 1 then
    raise exception 'A must see exactly its own row, found %', v_foreign;
  end if;
end
$$;

-- 2) B لا يقرأ إعداد A ولو كان other_user_id = B (هذا هو الخلل الأصلي).
do $$
declare
  v_leak integer;
begin
  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', false);

  select count(*) into v_leak
  from public.message_conversation_settings
  where user_id = 'a0000000-0000-0000-0000-00000000000a'
    and other_user_id = 'b0000000-0000-0000-0000-00000000000b';
  if v_leak <> 0 then
    raise exception 'B must not read A settings through other_user_id, found %', v_leak;
  end if;

  if (select is_muted from public.message_conversation_settings
      where user_id = 'a0000000-0000-0000-0000-00000000000a') is not null then
    raise exception 'B must not learn A mute state';
  end if;
end
$$;

-- 3) C لا يقرأ إعداد A.
do $$
declare
  v_leak integer;
begin
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', false);

  select count(*) into v_leak
  from public.message_conversation_settings
  where user_id = 'a0000000-0000-0000-0000-00000000000a';
  if v_leak <> 0 then
    raise exception 'C must not read A settings, found %', v_leak;
  end if;

  select count(*) into v_leak from public.message_conversation_settings;
  if v_leak <> 0 then
    raise exception 'C has no settings and must see none, found %', v_leak;
  end if;
end
$$;

-- 4) عمليات المالك المسموحة تبقى تعمل: إضافة وتعديل وحذف لصفّه.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', false);

  insert into public.message_conversation_settings (user_id, other_user_id, is_muted)
  values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', false);

  update public.message_conversation_settings
  set is_muted = true
  where user_id = 'a0000000-0000-0000-0000-00000000000a'
    and other_user_id = 'c0000000-0000-0000-0000-00000000000c';
  if not found then
    raise exception 'the owner must still update its own settings';
  end if;

  if not (select is_muted from public.message_conversation_settings
          where user_id = 'a0000000-0000-0000-0000-00000000000a'
            and other_user_id = 'c0000000-0000-0000-0000-00000000000c') then
    raise exception 'the owner update must be applied';
  end if;

  delete from public.message_conversation_settings
  where user_id = 'a0000000-0000-0000-0000-00000000000a'
    and other_user_id = 'c0000000-0000-0000-0000-00000000000c';
  if found then
    null;
  else
    raise exception 'the owner must still delete its own settings';
  end if;
end
$$;

-- 5) لا يستطيع المالك كتابة صف باسم مستخدم آخر.
do $$
begin
  begin
    insert into public.message_conversation_settings (user_id, other_user_id, is_muted)
    values ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', true);
    raise exception 'a user must not insert a settings row for another user';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

-- تنظيف: إزالة صفوف الاختبار الثلاثة (تُعاد من harness عند إعادة البناء).
reset role;
delete from public.message_conversation_settings
where user_id in (
  'a0000000-0000-0000-0000-00000000000a',
  'b0000000-0000-0000-0000-00000000000b',
  'c0000000-0000-0000-0000-00000000000c'
);

\echo 'message conversation settings RLS: all assertions passed'
