-- =====================================================================
-- جداول مشاهدات وإعجابات القصص (story_views + story_likes) — مستقل وقابل
-- لإعادة التشغيل. قواعد مبنية من fresh_schema_cloudflare_r2.sql لا تحتوي
-- هذين الجدولين إطلاقاً، فيفشل استعلام لوحة المشاهدين بالإشعار:
--   "تعذر تحميل المشاهدين والإعجابات الفعلية"
-- يتضمن: الجداول + المفاتيح الأجنبية (شرط الضميمة viewer:profiles) + RLS
-- + دالة تسجيل المشاهدة (aani_record_story_view) + حظر/إخفاء مساندان
-- + تفعيل Realtime + NOTIFY pgrst, 'reload schema'.
-- =====================================================================

begin;

-- =====================================================================
-- 1) جدول مشاهدات القصص — فريد لكل (قصة، مستخدم) مع مفاتيح أجنبية
--    المفتاح الأجنبي إلى profiles إلزامي لعمل الضميمة viewer:profiles(...)
-- =====================================================================

create table if not exists public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create index if not exists aani_story_views_story_viewed_idx
  on public.story_views (story_id, viewed_at desc);

-- =====================================================================
-- 2) جدول إعجابات القصص — فريد لكل (قصة، مستخدم) مع مفتاح أجنبي للملف
-- =====================================================================

create table if not exists public.story_likes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (story_id, user_id)
);

create index if not exists aani_story_likes_story_idx
  on public.story_likes (story_id, created_at desc);

-- =====================================================================
-- 3) الجداول المساندة للحظر/الإخفاء/البلاغ (تستخدمها سياسات RLS وأزرار
--    لوحة المشاهدين: حظر الحساب، إخفاء قصصي عنه، بلاغ حساب)
-- =====================================================================

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_user_id),
  constraint aani_user_blocks_not_self check (blocker_id <> blocked_user_id)
);

create table if not exists public.story_hidden_users (
  story_owner_id uuid not null references public.profiles(id) on delete cascade,
  hidden_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_owner_id, hidden_user_id),
  constraint aani_story_hidden_users_not_self check (story_owner_id <> hidden_user_id)
);

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in ('spam', 'harassment', 'hate', 'fake_account', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint aani_user_reports_not_self check (reporter_id <> reported_user_id),
  constraint aani_user_reports_reporter_target_unique unique (reporter_id, reported_user_id)
);

create index if not exists aani_user_blocks_blocked_user_idx
  on public.user_blocks (blocked_user_id, blocker_id);
create index if not exists aani_story_hidden_users_hidden_idx
  on public.story_hidden_users (hidden_user_id, story_owner_id);
create index if not exists aani_user_reports_target_created_idx
  on public.user_reports (reported_user_id, created_at desc);

-- =====================================================================
-- 4) RLS: تفعيل + صلاحيات + سياسات
--    story_views: يقرأ المالك فقط (باستثناء المحظورين) — يكتب المشاهد نفسه
--    story_likes: يقرأ صاحب الإعجاب أو مالك القصة — يكتب من يستطيع المشاهدة
-- =====================================================================

alter table public.story_views enable row level security;
alter table public.story_likes enable row level security;
alter table public.user_blocks enable row level security;
alter table public.story_hidden_users enable row level security;
alter table public.user_reports enable row level security;

revoke all on public.user_blocks from public, anon, authenticated;
revoke all on public.story_hidden_users from public, anon, authenticated;
revoke all on public.user_reports from public, anon, authenticated;
grant select, insert on public.story_views to authenticated;
grant select, insert, delete on public.story_likes to authenticated;
grant select on public.user_blocks, public.story_hidden_users, public.user_reports to authenticated;
grant insert (reporter_id, reported_user_id, category, details) on public.user_reports to authenticated;

-- قراءة المشاهدين: مالك القصة فقط، مع استثناء الحسابات المحظورة
drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not coalesce(public.aani_is_user_blocked(story.user_id, story_views.user_id), false)
    )
  );
drop policy if exists aani_story_views_owner_guard on public.story_views;
create policy aani_story_views_owner_guard on public.story_views
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
        and not coalesce(public.aani_is_user_blocked(story.user_id, story_views.user_id), false)
    )
  );

-- تسجيل المشاهدة: المشاهد نفسه، على قصة يستطيع مشاهدتها وليست قصته
drop policy if exists aani_story_views_insert_viewer on public.story_views;
create policy aani_story_views_insert_viewer on public.story_views
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );
drop policy if exists aani_story_views_insert_guard on public.story_views;
create policy aani_story_views_insert_guard on public.story_views
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

-- الإعجابات: قراءتها لصاحب الإعجاب أو مالك القصة (باستثناء المحظورين)
drop policy if exists aani_story_likes_select_own on public.story_likes;
create policy aani_story_likes_select_own on public.story_likes
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not coalesce(public.aani_is_user_blocked(story.user_id, story_likes.user_id), false)
    )
  );
drop policy if exists aani_story_likes_owner_guard on public.story_likes;
create policy aani_story_likes_owner_guard on public.story_likes
  as restrictive for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not coalesce(public.aani_is_user_blocked(story.user_id, story_likes.user_id), false)
    )
  );

-- الإعجاب: من يستطيع مشاهدة القصة
drop policy if exists aani_story_likes_insert_own on public.story_likes;
create policy aani_story_likes_insert_own on public.story_likes
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );
drop policy if exists aani_story_likes_insert_guard on public.story_likes;
create policy aani_story_likes_insert_guard on public.story_likes
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

-- إلغاء الإعجاب: صاحب الإعجاب وحده
drop policy if exists aani_story_likes_delete_own on public.story_likes;
create policy aani_story_likes_delete_own on public.story_likes
  for delete to authenticated using (user_id = (select auth.uid()));

-- جداول الحظر/الإخفاء/البلاغ: يقرأ كل مستخدم صفوفه فقط
drop policy if exists aani_user_blocks_select_own on public.user_blocks;
create policy aani_user_blocks_select_own on public.user_blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

drop policy if exists aani_story_hidden_users_select_own on public.story_hidden_users;
create policy aani_story_hidden_users_select_own on public.story_hidden_users
  for select to authenticated using (story_owner_id = (select auth.uid()));

drop policy if exists aani_user_reports_select_own on public.user_reports;
create policy aani_user_reports_select_own on public.user_reports
  for select to authenticated using (reporter_id = (select auth.uid()));
drop policy if exists aani_user_reports_insert_own on public.user_reports;
create policy aani_user_reports_insert_own on public.user_reports
  for insert to authenticated with check (
    reporter_id = (select auth.uid())
    and reporter_id <> reported_user_id
    and status = 'pending'
  );

-- =====================================================================
-- 5) الدوال المساندة: الحظر، الإخفاء، البلاغ، تسجيل المشاهدة
-- =====================================================================

-- هل الحسابان محظوران بينهما؟ (تُستدعى داخل سياسات RLS — security definer)
create or replace function public.aani_is_user_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and auth.uid() in (p_user_a, p_user_b)
    and exists (
      select 1
      from public.user_blocks as blocked
      where (blocked.blocker_id = p_user_a and blocked.blocked_user_id = p_user_b)
         or (blocked.blocker_id = p_user_b and blocked.blocked_user_id = p_user_a)
    ),
    false
  );
$$;
revoke all on function public.aani_is_user_blocked(uuid, uuid) from public;
grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated;

create or replace function public.aani_block_user(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_blocked_user_id is null or p_blocked_user_id = actor_id then
    raise exception 'Invalid user to block' using errcode = '22023';
  end if;

  insert into public.user_blocks (blocker_id, blocked_user_id)
  values (actor_id, p_blocked_user_id)
  on conflict (blocker_id, blocked_user_id) do nothing;

  delete from public.follows
  where (follower_id = actor_id and following_id = p_blocked_user_id)
     or (follower_id = p_blocked_user_id and following_id = actor_id);

  delete from public.follow_requests
  where (requester_id = actor_id and recipient_id = p_blocked_user_id)
     or (requester_id = p_blocked_user_id and recipient_id = actor_id);

  delete from public.close_friends
  where (user_id = actor_id and friend_id = p_blocked_user_id)
     or (user_id = p_blocked_user_id and friend_id = actor_id);
end;
$$;
revoke all on function public.aani_block_user(uuid) from public;
grant execute on function public.aani_block_user(uuid) to authenticated;

create or replace function public.aani_hide_story_from_user(p_hidden_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_hidden_user_id is null or p_hidden_user_id = owner_id then
    raise exception 'Invalid user to hide stories from' using errcode = '22023';
  end if;

  insert into public.story_hidden_users (story_owner_id, hidden_user_id)
  values (owner_id, p_hidden_user_id)
  on conflict (story_owner_id, hidden_user_id) do nothing;
end;
$$;
revoke all on function public.aani_hide_story_from_user(uuid) from public;
grant execute on function public.aani_hide_story_from_user(uuid) to authenticated;

-- تسجيل مشاهدة حقيقية (idempotent) — يُستدعى عند عرض كل قصة لغير صاحبها
create or replace function public.aani_record_story_view(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.stories as story
    where story.id = p_story_id
      and story.user_id <> viewer_id
      and public.aani_can_view_story(story.id, viewer_id)
  ) then
    raise exception 'Story is not available to this viewer' using errcode = '42501';
  end if;

  insert into public.story_views (story_id, user_id)
  values (p_story_id, viewer_id)
  on conflict (story_id, user_id) do nothing;
end;
$$;
revoke all on function public.aani_record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid) to authenticated;

-- =====================================================================
-- 6) Realtime: تحديث قائمة المشاهدين لحظياً (أحداث INSERT على الجدولين)
-- =====================================================================

alter table public.story_views replica identity full;
alter table public.story_likes replica identity full;
do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['story_views', 'story_likes'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', target_table);
      exception
        when duplicate_object then null;
        when undefined_object then null;
        when others then null;
      end;
    end loop;
  end if;
end $$;

-- =====================================================================
-- 7) تحديث كاش PostgREST فوراً
-- =====================================================================

notify pgrst, 'reload schema';

commit;
