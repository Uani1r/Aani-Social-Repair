# 🗄️ سكربت إصلاح قاعدة البيانات — آني سوشيال

> **تنبيه:** الخطأ السابق `42601: trailing junk after numeric literal` حدث لأنه تم لصق **اسم الملف** `20261030000000_comment_reactions_fix.sql` في المحرر بدلاً من **محتوى السكربت**. الحل: انسخ محتوى الكود أدناه كاملاً (زر النسخ أعلى الكتلة) والصقه في Supabase SQL Editor ثم اضغط Run.

**خطوات التنفيذ:**
1. افتح Supabase Dashboard → **SQL Editor**
2. انسخ السكربت كاملاً من الكتلة أدناه (بضغطة واحدة من أيقونة النسخ)
3. الصقه في المحرر واضغط **Run**
4. لا تشغّل الترحيلات من Replit — هذا السكربت يغنيك عنها

```sql
-- =====================================================================
-- Aani: سكربت إصلاح شامل (تفاعلات التعليقات + عدّادات المنشورات)
-- انسخ كامل المحتوى والصقه في Supabase Dashboard → SQL Editor ثم Run
-- آمن للتشغيل عدة مرات (Idempotent)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. التأكد من وجود جدولي التفاعل
-- ---------------------------------------------------------------------
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.comment_dislikes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create unique index if not exists comment_likes_comment_user_uidx
  on public.comment_likes (comment_id, user_id);

-- ---------------------------------------------------------------------
-- 2. تفعيل RLS وسياسات الصلاحيات
-- ---------------------------------------------------------------------
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_dislikes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comments'
      and policyname = 'Signed-in users can read comments'
  ) then
    create policy "Signed-in users can read comments"
      on public.comments for select to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comments'
      and policyname = 'Users can create comments as themselves'
  ) then
    create policy "Users can create comments as themselves"
      on public.comments for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comments'
      and policyname = 'Users can delete their own comments'
  ) then
    create policy "Users can delete their own comments"
      on public.comments for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_likes'
      and policyname = 'Signed-in users can read comment likes'
  ) then
    create policy "Signed-in users can read comment likes"
      on public.comment_likes for select to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_likes'
      and policyname = 'Users can like comments as themselves'
  ) then
    create policy "Users can like comments as themselves"
      on public.comment_likes for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_likes'
      and policyname = 'Users can remove their own comment likes'
  ) then
    create policy "Users can remove their own comment likes"
      on public.comment_likes for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_dislikes'
      and policyname = 'Signed-in users can read comment dislikes'
  ) then
    create policy "Signed-in users can read comment dislikes"
      on public.comment_dislikes for select to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_dislikes'
      and policyname = 'Users can dislike comments as themselves'
  ) then
    create policy "Users can dislike comments as themselves"
      on public.comment_dislikes for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'comment_dislikes'
      and policyname = 'Users can remove their own comment dislikes'
  ) then
    create policy "Users can remove their own comment dislikes"
      on public.comment_dislikes for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. منح الصلاحيات المباشرة
-- ---------------------------------------------------------------------
grant select, insert, delete on public.comments to authenticated;
grant select, insert, delete on public.comment_likes to authenticated;
grant select, insert, delete on public.comment_dislikes to authenticated;

-- ---------------------------------------------------------------------
-- 4. منع تعارض الإعجاب/عدم الإعجاب (سطر واحد لكل مستخدم)
-- ---------------------------------------------------------------------
create or replace function public.aani_clear_opposite_comment_reaction()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'comment_likes' then
    delete from public.comment_dislikes
    where comment_id = new.comment_id and user_id = new.user_id;
  else
    delete from public.comment_likes
    where comment_id = new.comment_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_comment_likes_exclusive on public.comment_likes;
create trigger aani_comment_likes_exclusive
  after insert on public.comment_likes
  for each row execute function public.aani_clear_opposite_comment_reaction();

drop trigger if exists aani_comment_dislikes_exclusive on public.comment_dislikes;
create trigger aani_comment_dislikes_exclusive
  after insert on public.comment_dislikes
  for each row execute function public.aani_clear_opposite_comment_reaction();

-- ---------------------------------------------------------------------
-- 5. البث الفوري (Realtime)
-- ---------------------------------------------------------------------
alter table public.comments replica identity full;
alter table public.comment_likes replica identity full;
alter table public.comment_dislikes replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.comment_likes;
    exception
      when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.comment_dislikes;
    exception
      when duplicate_object then null;
    end;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 6. تهيئة جدول الإشعارات (لإشعار "قام بالإعجاب بتعليقك")
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  actor_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  content text,
  entity_id uuid,
  comment_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications add column if not exists content text;
alter table public.notifications add column if not exists comment_id uuid;

-- إزالة قيد CHECK قديم يمنع أنواع إشعارات يحتاجها التطبيق
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%type%'
      and pg_get_constraintdef(oid) not ilike '%reply%'
  loop
    execute format('alter table public.notifications drop constraint %I', con.conname);
  end loop;
end;
$$;

alter table public.notifications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications'
      and policyname = 'Users can view their own notifications'
  ) then
    create policy "Users can view their own notifications"
      on public.notifications for select
      using (auth.uid() = user_id);
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

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.notifications;
    exception
      when duplicate_object then null;
    end;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 7. عدّادات المنشور: أعمدة + مشغّلات مزامنة تلقائية
--    (أي تعليق/إعجاب/إعادة نشر/مشاركة يحدّث الأرقام للجميع فوراً)
-- ---------------------------------------------------------------------
alter table public.posts
  add column if not exists likes_count integer not null default 0,
  add column if not exists comments_count integer not null default 0,
  add column if not exists reposts_count integer not null default 0,
  add column if not exists shares_count integer not null default 0;

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

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'aani_likes_counter' and tgrelid = 'public.likes'::regclass
  ) then
    create trigger aani_likes_counter
      after insert or delete on public.likes
      for each row execute function public.aani_sync_post_counters();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'aani_comments_counter' and tgrelid = 'public.comments'::regclass
  ) then
    create trigger aani_comments_counter
      after insert or delete on public.comments
      for each row execute function public.aani_sync_post_counters();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'aani_reposts_counter' and tgrelid = 'public.reposts'::regclass
  ) then
    create trigger aani_reposts_counter
      after insert or delete on public.reposts
      for each row execute function public.aani_sync_post_counters();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'aani_post_shares_counter' and tgrelid = 'public.post_shares'::regclass
  ) then
    create trigger aani_post_shares_counter
      after insert or delete on public.post_shares
      for each row execute function public.aani_sync_post_counters();
  end if;
end;
$$;

-- امتلاء خلفي: موازنة جميع العدّادات مع الصفوف الموجودة فعلاً
update public.posts p set
  likes_count = coalesce((select count(*) from public.likes l where l.post_id = p.id), 0),
  comments_count = coalesce((select count(*) from public.comments c where c.post_id = p.id), 0),
  reposts_count = coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0),
  shares_count = coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0);

-- التأكد النهائي من حساب الأرقام الحقيقية للتعليقات (Backfill)
UPDATE public.posts p
SET comments_count = (
    SELECT COUNT(*)
    FROM public.comments c
    WHERE c.post_id = p.id
);

-- RPC جلب العدّادات في رحلة واحدة للتطبيق
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
    coalesce(p.likes_count, 0) as like_count,
    coalesce(p.comments_count, 0) as comment_count,
    coalesce(p.reposts_count, 0) as repost_count,
    coalesce(p.shares_count, 0) as share_count,
    exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked,
    exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as bookmarked,
    exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted,
    exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared
  from public.posts p
  where p.id = any(post_ids);
$$;

revoke all on function public.post_interaction_summaries(uuid[]) from public;
grant execute on function public.post_interaction_summaries(uuid[]) to authenticated, anon;

-- RPC ثانية تستخدمها الواجهة لجلب العدّادات + أعلام التفاعل
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

commit;
```

---

## 🔍 سكربت التشخيص (اختياري — منفصل)

إذا أردت التحقق من وجود الجداول، شغّل هذا وحده:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('comments','comment_likes','comment_dislikes','notifications');
```

---

## ✅ ماذا يفعل هذا السكربت؟

| القسم | الوظيفة |
|---|---|
| 1-3 | إنشاء جدولي الإعجاب/عدم الإعجاب للتعليقات مع سياسات RLS كاملة |
| 4 | منع تعارض اللايك/الديسلايك (سطر واحد لكل مستخدم) |
| 5 | تفعيل البث الفوري للتحديثات اللحظية |
| 6 | تهيئة جدول الإشعارات لإشعار "قام بالإعجاب بتعليقك" |
| 7 | عدّادات المنشورات: أعمدة + مشغّلات تلقائية + امتلاء خلفي للمنشورات القديمة (يصلح الصفر) |
| RPC | دوال جلب العدّادات التي تستخدمها الواجهة |

بعد التشغيل: افتح Replit واكتب `git pull` ثم شغّل التطبيق.
