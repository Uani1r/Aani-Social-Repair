-- يتحقق ترحيل Realtime لإعدادات المحادثات على قاعدة CI مؤقتة فقط.
-- يُشغَّل بعد الترحيل، ويُعاد بعد تطبيقه مرة ثانية لإثبات قابلية إعادة التنفيذ.
--
-- المطلوب: الجدول عضو واحد في منشور supabase_realtime، والمنشور ليس
-- FOR ALL TABLES، والترحيل لم يغيّر RLS ولا أعمدة الجدول.

begin;

do $$
declare
  v_publish_all boolean;
  v_members integer;
  v_columns integer;
  v_rls boolean;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'supabase_realtime publication must exist for this test';
  end if;

  select puballtables into v_publish_all
  from pg_catalog.pg_publication
  where pubname = 'supabase_realtime';

  if v_publish_all then
    raise exception 'the fixture must not use a FOR ALL TABLES publication';
  end if;

  select count(*) into v_members
  from pg_catalog.pg_publication_rel rel
  join pg_catalog.pg_class cls on cls.oid = rel.prrelid
  join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
  where rel.prpubid = (select oid from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and ns.nspname = 'public'
    and cls.relname = 'message_conversation_settings';

  if v_members <> 1 then
    raise exception 'message_conversation_settings must be published exactly once, found %', v_members;
  end if;

  select count(*) into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'message_conversation_settings';

  if v_columns <> 4 then
    raise exception 'the migration must not change the table columns, found %', v_columns;
  end if;

  select relrowsecurity into v_rls
  from pg_catalog.pg_class
  where oid = 'public.message_conversation_settings'::regclass;

  if v_rls then
    raise exception 'the migration must not change RLS on message_conversation_settings';
  end if;
end
$$;

commit;

\echo 'message conversation settings realtime: publication membership verified'
