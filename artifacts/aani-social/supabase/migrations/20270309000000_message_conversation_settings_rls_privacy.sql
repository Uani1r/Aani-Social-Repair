-- خصوصية إعدادات المحادثات: القراءة لصاحب الصف وحده.
--
-- المشكلة المثبتة (من المخطط الفعلي fresh_schema_cloudflare_r2.sql:727-729):
--   policy "Users read own conversation settings" for select to authenticated
--     using (user_id = (select auth.uid()) or other_user_id = (select auth.uid()));
-- الشرط الثاني يجعل الطرف الآخر يقرأ صفّ صاحب الإعداد، فيعرف أنه كتم المحادثة
-- أو غيّر مدّتها — وهذا كشف لحالة خاصة لا يجوز.
--
-- الإصلاح: القراءة تصبح لصاحب الصف وحده (user_id = auth.uid()). سياسة المالك
-- (FOR ALL) تبقى كما هي، والمنح (select/insert/update/delete) لا تتغير، فلا
-- تتعطل عمليات التطبيق. لا يُلمس أي جدول أو سياسة أخرى.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

do $$
declare
  v_columns_ok boolean;
  v_offender text;
begin
  -- الجدول الفعلي يستخدم user_id/other_user_id. على مخطط آخر (user_a/user_b
  -- في ترحيلات قديمة) لا يوجد هذا العمود، فلا نغيّر شيئاً.
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'message_conversation_settings'
      and column_name = 'user_id'
  ) into v_columns_ok;

  if not v_columns_ok then
    raise notice 'message_conversation_settings has no user_id column; nothing to change';
    return;
  end if;

  execute 'alter table public.message_conversation_settings enable row level security';

  execute 'drop policy if exists "Users read own conversation settings" on public.message_conversation_settings';
  execute $policy$
    create policy "Users read own conversation settings"
      on public.message_conversation_settings for select to authenticated
      using (user_id = (select auth.uid()))
  $policy$;

  -- فشل مغلق: أي سياسة permissive أخرى تُستخدم للقراءة (SELECT أو ALL) وتشير
  -- إلى other_user_id تعني تجاوزاً للعزل، فتُوقف تطبيق الترحيل حتى تُراجع يدوياً.
  select string_agg(pol.polname, ', ' order by pol.polname) into v_offender
  from pg_catalog.pg_policy pol
  join pg_catalog.pg_class cls on cls.oid = pol.polrelid
  join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
    and cls.relname = 'message_conversation_settings'
    and pol.polpermissive
    and pol.polcmd in ('r', '*')
    and pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) like '%other_user_id%';

  if v_offender is not null then
    raise exception 'a permissive policy still reads foreign conversation settings: %', v_offender
      using errcode = '42501';
  end if;
end
$$;

commit;
