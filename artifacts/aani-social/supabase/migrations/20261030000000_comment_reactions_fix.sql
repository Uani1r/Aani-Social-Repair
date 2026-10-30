-- =====================================================================
-- Aani: تشخيص وإصلاح تفاعلات التعليقات (إعجاب / عدم إعجاب)
-- =====================================================================
-- عالج هذا الملف مشكلة الخطأ "تعذر تحديث التفاعل" عند الضغط على إعجاب
-- أو عدم إعجاب في التعليقات. السبب غالبًا: جداول comment_likes /
-- comment_dislikes أو سياساتها غير موجودة في المشروع المستهدف.
--
-- آمن للتشغيل عدة مرات (Idempotent) — الصقه وشغّله في:
-- Supabase Dashboard → SQL Editor → Run
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
-- 4. إلغاء تعارض الإعجاب/عدم الإعجاب (سطر واحد لكل مستخدم)
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
-- 5. البث الفوري (Realtime) لتفادي إعادة الجلب اليدوي
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

-- توسيع أنواع الإشعارات: إزالة قيد CHECK القديم الذي يمنع أنواعًا مثل 'reply'
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

commit;

-- =====================================================================
-- 7. تشخيص سريع (اختياري) — شغّل هذا السطر وحده لمعرفة ما كان ناقصًا:
--
-- select table_name from information_schema.tables
-- where table_schema = 'public'
--   and table_name in ('comments','comment_likes','comment_dislikes','notifications');
--
-- إذا أظهر النتيجة الجداول الأربعة فكل شيء سليم.
-- =====================================================================
