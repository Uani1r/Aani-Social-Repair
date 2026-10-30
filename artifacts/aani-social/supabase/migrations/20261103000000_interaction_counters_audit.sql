-- =====================================================================
-- Aani: تدقيق وضبط عدّادات التفاعل (إعجابات/تعليقات/إعادة نشر/مشاركات)
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent) ولا يحذف أي بيانات
-- =====================================================================

begin;

-- 1. أعمدة العدّادات على جدول المنشورات
alter table public.posts
  add column if not exists likes_count integer not null default 0,
  add column if not exists comments_count integer not null default 0,
  add column if not exists reposts_count integer not null default 0,
  add column if not exists shares_count integer not null default 0;

-- 2. السماح بعدّة عمليات توجيه من نفس المستخدم (كل توجيه = سجل وعدّاد +1)
drop index if exists public.aani_post_shares_post_user_unique;

-- 3. دالة المزامنة الموحدة للعدّادات (+1 عند الإضافة، -1 عند الحذف، بحد أدنى 0)
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

-- 4. ضمان وجود المشغّلات الأربعة (لا تُنشأ مرتين)
do $$
declare
  target_table text;
  target_rel regclass;
  trigger_name text;
begin
  foreach target_table in array array['likes', 'comments', 'reposts', 'post_shares']
  loop
    begin
      target_rel := format('public.%I', target_table)::regclass;
    exception
      when undefined_table then
        continue;
    end;

    trigger_name := 'aani_' || target_table || '_counter';

    if not exists (
      select 1 from pg_trigger
      where tgname = trigger_name and tgrelid = target_rel
    ) then
      execute format(
        'create trigger %I after insert or delete on public.%I for each row execute function public.aani_sync_post_counters()',
        trigger_name,
        target_table
      );
    end if;
  end loop;
end;
$$;

-- 5. امتلاء خلفي: موازنة العدّادات مع الصفوف الحقيقية (لا يقل عن صفر)
update public.posts p set
  likes_count = greatest(0, coalesce((select count(*) from public.likes l where l.post_id = p.id), 0)),
  comments_count = greatest(0, coalesce((select count(*) from public.comments c where c.post_id = p.id), 0)),
  reposts_count = greatest(0, coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0)),
  shares_count = greatest(0, coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0));

-- 6. دوال القراءة الموحدة (مصدر الحقيقة للأرقام والتفاعلات)
create or replace function public.post_interaction_summaries(post_ids uuid[])
returns table (
  post_id uuid,
  like_count integer,
  comment_count integer,
  repost_count integer,
  share_count integer,
  liked boolean,
  bookmarked boolean,
  reposted boolean,
  shared boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id as post_id,
    coalesce((select count(*) from public.likes l where l.post_id = p.id), 0)::integer as like_count,
    coalesce((select count(*) from public.comments c where c.post_id = p.id), 0)::integer as comment_count,
    coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0)::integer as repost_count,
    coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0)::integer as share_count,
    exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked,
    exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as bookmarked,
    exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted,
    exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared
  from public.posts p
  where p.id = any(post_ids);
$$;

revoke all on function public.post_interaction_summaries(uuid[]) from public;
grant execute on function public.post_interaction_summaries(uuid[]) to authenticated, anon;

create or replace function public.get_post_interactions(p_post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    p.id,
    (select count(*) from public.likes l where l.post_id = p.id),
    (select count(*) from public.comments c where c.post_id = p.id),
    (select count(*) from public.reposts r where r.post_id = p.id),
    exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()),
    exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()),
    exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()),
    (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid())
  from public.posts p
  where p.id = any(coalesce(p_post_ids, '{}'::uuid[]));
$$;

grant execute on function public.get_post_interactions(uuid[]) to authenticated;

-- 7. دالة تسجيل التوجيه (تُستدعى بعد كل إرسال في المحادثة)
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

-- 8. البث الفوري للعدادات (يراها كل المستخدمين فورًا دون تحديث الصفحة)
alter table public.posts replica identity full;

do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['posts', 'likes', 'comments', 'reposts', 'post_shares']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = target_table
      ) then
        begin
          execute format('alter publication supabase_realtime add table public.%I', target_table);
        exception
          when duplicate_object then null;
          when undefined_object then null;
        end;
      end if;
    end loop;
  end if;
end;
$$;

commit;

-- =====================================================================
-- فحص سريع (اختياري)
-- =====================================================================
-- select id, likes_count, comments_count, reposts_count, shares_count
-- from public.posts order by created_at desc limit 5;
