-- =====================================================================
-- Aani: إصلاح تفاعل الإعجاب وتوحيد مشغّلات العدّادات (منع التضاعف)
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent) ولا يحذف أي بيانات
-- =====================================================================

begin;

-- 1. دالة العدّادات (تُنشأ أو تُستبدل)
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

-- 2. حذف أي مشغّل عدّاد مكرر (حتى لو كان باسم مختلف) وإنشاء واحد فقط لكل جدول
do $$
declare
  target_table text;
  target_rel regclass;
  trigger_name text;
  existing text;
begin
  foreach target_table in array array['likes', 'comments', 'reposts', 'post_shares']
  loop
    begin
      target_rel := format('public.%I', target_table)::regclass;
    exception
      when undefined_table then
        continue;
    end;

    for existing in
      select t.tgname
      from pg_trigger t
      where t.tgrelid = target_rel
        and not t.tgisinternal
        and t.tgfoid = 'public.aani_sync_post_counters()'::regproc
    loop
      execute format('drop trigger if exists %I on public.%I', existing, target_table);
    end loop;

    trigger_name := 'aani_' || target_table || '_counter';

    execute format(
      'create trigger %I after insert or delete on public.%I for each row execute function public.aani_sync_post_counters()',
      trigger_name,
      target_table
    );
  end loop;
end;
$$;

-- 3. إعادة بناء العدّادات من الصفوف الحقيقية (تصحيح أي أرقام متراكمة)
update public.posts p set
  likes_count = greatest(0, coalesce((select count(*) from public.likes l where l.post_id = p.id), 0)),
  comments_count = greatest(0, coalesce((select count(*) from public.comments c where c.post_id = p.id), 0)),
  reposts_count = greatest(0, coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0)),
  shares_count = greatest(0, coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0));

commit;

-- =====================================================================
-- فحص سريع: يجب ظهور مشغّل واحد لكل جدول
-- =====================================================================
-- select c.relname as table_name, t.tgname
-- from pg_trigger t
-- join pg_class c on c.oid = t.tgrelid
-- where not t.tgisinternal
--   and t.tgfoid = 'public.aani_sync_post_counters()'::regproc
-- order by c.relname;
