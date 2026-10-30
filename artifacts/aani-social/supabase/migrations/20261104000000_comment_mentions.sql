-- =====================================================================
-- Aani: دعم إشعارات المنشن والردود في التعليقات
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent) ولا يحذف أي بيانات
-- =====================================================================

begin;

-- 1. حقول الإشعار اللازمة لربط الإشعار بتعليق محدد
do $$
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'comment_id'
  ) then
    alter table public.notifications add column comment_id uuid;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'content'
  ) then
    alter table public.notifications add column content text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications' and column_name = 'actor_id'
  ) then
    alter table public.notifications add column actor_id uuid;
  end if;
end;
$$;

create index if not exists notifications_comment_id_idx
  on public.notifications (comment_id);

-- 2. السماح للمستخدم بإرسال إشعار بصفتِه (رد/منشن) دون السماح بانتحال غيره
do $$
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications'
      and policyname = 'Users can insert notifications as the actor'
  ) then
    create policy "Users can insert notifications as the actor"
      on public.notifications for insert to authenticated
      with check (actor_id = (select auth.uid()));
  end if;
end;
$$;

grant select, insert, update on public.notifications to authenticated;

commit;

-- =====================================================================
-- فحص سريع (اختياري): يظهر أنواع الإشعارات الأخيرة
-- =====================================================================
-- select type, content, created_at from public.notifications
-- order by created_at desc limit 10;
