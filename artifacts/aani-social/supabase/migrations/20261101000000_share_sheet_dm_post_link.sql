-- =====================================================================
-- Aani: ربط الرسائل الخاصة بالمنشورات المُرسلة (معاينة غنية داخل المحادثات)
-- + توحيد أعمدة الإشعارات لدعم إشعارات إعادة النشر القابلة للنقر
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent)
-- =====================================================================

begin;

-- 1. مرجع المنشور الأصلي في الرسالة (يُحذف الرابط فقط عند حذف المنشور)
alter table public.messages
  add column if not exists post_id uuid references public.posts (id) on delete set null;

create index if not exists messages_post_id_idx
  on public.messages (post_id);

-- 2. البث الفوري يحمل الحقول كاملة (بما فيها post_id) لعرض المعاينة مباشرة
alter table public.messages replica identity full;

-- 3. التحقق من سياسات القراءة/الإرسال (تُعاد للشكل الصحيح إن كانت مفقودة)
drop policy if exists "Users can read their own messages" on public.messages;
create policy "Users can read their own messages"
  on public.messages for select to authenticated
  using (
    sender_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );

drop policy if exists "Users can send messages as themselves" on public.messages;
create policy "Users can send messages as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and sender_id <> recipient_id
  );

grant select, insert on public.messages to authenticated;

-- 4. توحيد أعمدة الإشعارات (مرجع المنشور + صاحب الفعل) دون حذف أو تغيير
--    الأعمدة القديمة، ليعمل إشعار "أعاد نشر منشورك" في كل نسخ المخطط
do $$
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'entity_id'
  ) then
    alter table public.notifications add column entity_id uuid;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'reference_id'
  ) then
    alter table public.notifications add column reference_id uuid;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'actor_id'
  ) then
    alter table public.notifications add column actor_id uuid;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'content'
  ) then
    alter table public.notifications add column content text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'comment_id'
  ) then
    alter table public.notifications add column comment_id uuid;
  end if;
end;
$$;

create index if not exists notifications_entity_id_idx
  on public.notifications (entity_id);

commit;

-- =====================================================================
-- فحص سريع بعد التشغيل (اختياري): يجب أن يظهر عمود post_id في messages
-- =====================================================================
-- select column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'messages'
-- order by ordinal_position;
