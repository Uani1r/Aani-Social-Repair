-- =====================================================================
-- Aani: احتساب كل عملية توجيه في عدّاد المشاركات + بث فوري للعدادات
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent)
-- =====================================================================

begin;

-- 1. السماح بعدّة عمليات توجيه من نفس المستخدم لنفس المنشور
--    (كل عملية إرسال إلى شخص = سجل منفصل وعدّاد +1)
drop index if exists public.aani_post_shares_post_user_unique;

create index if not exists aani_post_shares_post_created_idx
  on public.post_shares (post_id, created_at desc);

-- 2. ضمان وجود عمود عدّاد المشاركات
alter table public.posts
  add column if not exists shares_count integer not null default 0;

-- 3. دالة مزامنة العدّادات (تُنشئها أو تستبدلها دون حذف أي شيء)
create or replace function public.aani_sync_post_counters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post uuid;
  delta integer;
begin
  if tg_op = 'INSERT' then
    target_post := new.post_id;
    delta := 1;
  else
    target_post := old.post_id;
    delta := -1;
  end if;

  if target_post is null then
    return null;
  end if;

  if tg_table_name = 'likes' then
    update public.posts
      set likes_count = greatest(0, coalesce(likes_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts
      set comments_count = greatest(0, coalesce(comments_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'reposts' then
    update public.posts
      set reposts_count = greatest(0, coalesce(reposts_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'post_shares' then
    update public.posts
      set shares_count = greatest(0, coalesce(shares_count, 0) + delta)
      where id = target_post;
  end if;

  return null;
end;
$$;

-- 4. ضمان وجود مشغّل عدّاد المشاركات
do $$
begin
  if to_regclass('public.post_shares') is null then
    return;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'aani_post_shares_counter'
      and tgrelid = 'public.post_shares'::regclass
  ) then
    create trigger aani_post_shares_counter
      after insert or delete on public.post_shares
      for each row execute function public.aani_sync_post_counters();
  end if;
end;
$$;

-- 5. دالة تسجيل التوجيه التي يستدعيها التطبيق بعد نجاح الإرسال
--    تُدرج سجلاً لكل مستقبل (حتى لو تكرر نفس الشخص) فيزيد العدّاد بعددها
create or replace function public.aani_register_post_share(p_post_id uuid, p_count integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  total integer := greatest(1, least(coalesce(p_count, 1), 50));
begin
  if actor is null or p_post_id is null then
    return;
  end if;

  if not exists (select 1 from public.posts p where p.id = p_post_id) then
    return;
  end if;

  insert into public.post_shares (post_id, user_id)
  select p_post_id, actor
  from generate_series(1, total);
end;
$$;

revoke all on function public.aani_register_post_share(uuid, integer) from public;
grant execute on function public.aani_register_post_share(uuid, integer) to authenticated;

-- 6. مزامنة القيمة الحالية للعدّاد مع السجلات الموجودة
update public.posts p
set shares_count = coalesce(
  (select count(*) from public.post_shares s where s.post_id = p.id),
  0
);

-- 7. البث الفوري لجدول المنشورات حتى تظهر العدّادات المُحدثة للجميع
alter table public.posts replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'posts'
     ) then
    execute 'alter publication supabase_realtime add table public.posts';
  end if;
end;
$$;

commit;

-- =====================================================================
-- فحص سريع (اختياري)
-- =====================================================================
-- select id, shares_count from public.posts order by created_at desc limit 5;
