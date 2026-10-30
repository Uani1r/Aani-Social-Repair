-- =====================================================================
-- Aani: دعم الإرسال الخاص للمنشورات وإعادة النشر مع ملاحظة
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent)
-- =====================================================================

begin;

-- 1. حقل الملاحظة على إعادة النشر (اختياري مع كل إعادة نشر)
alter table public.reposts
  add column if not exists note text;

-- 2. منع تكرار إعادة النشر لنفس المنشور من نفس المستخدم
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'reposts_post_user_uidx'
      and conrelid = 'public.reposts'::regclass
  ) then
    alter table public.reposts
      add constraint reposts_post_user_uidx unique (post_id, user_id);
  end if;
end;
$$;

-- 3. ربط الرسائل بالمنشورات المُرسلة (مرجع المنشور الأصلي في المحادثات)
alter table public.messages
  add column if not exists post_id uuid;

-- 4. ضمان أن إشعارات إعادة النشر مقبولة (إزالة قيد CHECK قديم إن وجد)
do $$
declare
  con record;
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%type%'
      and pg_get_constraintdef(oid) not ilike '%reply%'
      and pg_get_constraintdef(oid) not ilike '%repost%'
  loop
    execute format('alter table public.notifications drop constraint %I', con.conname);
  end loop;
end;
$$;

commit;