-- بيئة اختبار ترحيل Realtime لإعدادات المحادثات على قاعدة CI مؤقتة فقط.
--
-- ينشئ ما يحتاجه الترحيل وحده: منشور supabase_realtime (بلا FOR ALL TABLES)
-- وجدول message_conversation_settings بالأعمدة الفعلية.
-- لا RLS ولا سياسات ولا منح هنا: الترحيل يجب ألا يمسّها، والاختبار يتحقق من ذلك.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

create table if not exists public.message_conversation_settings (
  user_id uuid not null,
  other_user_id uuid not null,
  is_muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
);
