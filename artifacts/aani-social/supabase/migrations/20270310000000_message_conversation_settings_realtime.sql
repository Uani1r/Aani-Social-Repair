-- مزامنة كتم المحادثات: إضافة message_conversation_settings إلى منشور Realtime.
--
-- بدون هذا الإضافة لا تصل تغييرات الكتم إلى الأجهزة الأخرى: التطبيق يشترك على
-- الجدول بفلتر user_id=eq.<المستخدم>، وRealtime لا يبثّ إلا جداول المنشور.
--
-- الترحيل محصور في عضوية المنشور:
--   * لا يغيّر RLS ولا المنح ولا أعمدة الجدول.
--   * لا يفعل شيئاً إن غاب المنشور أو الجدول أو كان المنشور FOR ALL TABLES.
--   * قابل لإعادة التنفيذ: العضوية الموجودة لا تُضاف مرة ثانية.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

do $$
declare
  v_publication_oid oid;
  v_publish_all boolean;
begin
  select oid, puballtables
    into v_publication_oid, v_publish_all
  from pg_catalog.pg_publication
  where pubname = 'supabase_realtime';

  if v_publication_oid is null then
    raise notice 'publication supabase_realtime is absent; nothing to publish';
    return;
  end if;

  -- منشور FOR ALL TABLES ينشر الجدول ضمناً، فإضافة عضوية صريحة له خطأ.
  if v_publish_all then
    raise notice 'publication supabase_realtime publishes all tables; no explicit membership needed';
    return;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class cls
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public'
      and cls.relname = 'message_conversation_settings'
      and cls.relkind = 'r'
  ) then
    raise notice 'message_conversation_settings does not exist; nothing to publish';
    return;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_publication_rel rel
    join pg_catalog.pg_class cls on cls.oid = rel.prrelid
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    where rel.prpubid = v_publication_oid
      and ns.nspname = 'public'
      and cls.relname = 'message_conversation_settings'
  ) then
    raise notice 'message_conversation_settings is already published; nothing to change';
    return;
  end if;

  execute 'alter publication supabase_realtime add table public.message_conversation_settings';
  raise notice 'message_conversation_settings added to publication supabase_realtime';
end
$$;

commit;
