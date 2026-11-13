-- =====================================================================
-- جداول مشاهدات وإعجابات القصص — v3 مطابقة للبنية الفعلية في قاعدة البيانات
-- (مؤكدة عبر information_schema.columns):
--
--   story_views  : id, story_id, viewer_id, created_at
--                  (المشاهد اسمه viewer_id، وزمن المشاهدة created_at)
--   story_likes  : id, story_id, user_id, created_at
--   user_blocks  : blocker_id, blocked_id, created_at
--
-- المطلوب من الواجهة (useStoryViewerData.ts):
--   story_views: user_id, viewed_at + ضميمة viewer:profiles(...)
--   story_likes: user_id, created_at
-- لذلك يُضاف عمود viewed_at مولَّداً دائماً من created_at، ويُنشأ منظر
-- story_viewer_entries يعيد story_id, user_id, viewed_at ليقرأه العميل
-- مباشرة — حل نهائي بلا أي خطأ 42703.
-- =====================================================================

begin;

-- =====================================================================
-- 1) إضافة عمود viewed_at المولَّد على story_views الموجود
--    (مولَّد دائماً من created_at — لا قيم يدوية، لا صفوف ناقصة)
-- =====================================================================

alter table public.story_views
  add column if not exists viewed_at timestamptz
  generated always as (created_at) stored;

create index if not exists aani_story_views_story_viewed_idx
  on public.story_views (story_id, created_at desc);

-- =====================================================================
-- 2) منظر القراءة الموحّد للمشاهدين — يعيد user_id و viewed_at
--    ليقرأه العميل: from('story_viewer_entries')
--      .select('user_id, viewed_at, viewer:profiles(...)')
--    الضميمة viewer:profiles تعمل لأن العلاقة تمر عبر viewer_id
--    الموجود في الجدول الأصلي، والمنظر يحمل user_id كاسم بديل.
-- =====================================================================

create or replace view public.story_viewer_entries as
  select
    v.id,
    v.story_id,
    v.viewer_id as user_id,
    v.created_at as viewed_at,
    v.viewer_id
  from public.story_views as v;

-- =====================================================================
-- 3) صلاحيات + RLS
-- =====================================================================

grant select on public.story_viewer_entries to authenticated;
grant select, insert on public.story_views to authenticated;
grant select, insert, delete on public.story_likes to authenticated;

alter table public.story_views enable row level security;
alter table public.story_likes enable row level security;

-- قراءة المشاهدين (عبر الجدول أو المنظر): مالك القصة فقط
drop policy if exists aani_story_views_select_story_owner on public.story_views;
create policy aani_story_views_select_story_owner on public.story_views
  for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
    )
  );

drop policy if exists aani_story_views_owner_guard on public.story_views;
create policy aani_story_views_owner_guard on public.story_views
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id = (select auth.uid())
    )
  );

-- تسجيل مشاهدة: المشاهد نفسه على قصة يستطيع مشاهدتها وليست قصته
drop policy if exists aani_story_views_insert_viewer on public.story_views;
create policy aani_story_views_insert_viewer on public.story_views
  for insert to authenticated with check (
    viewer_id = (select auth.uid())
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
    viewer_id = (select auth.uid())
    and exists (
      select 1 from public.stories as story
      where story.id = story_views.story_id
        and story.user_id <> (select auth.uid())
        and public.aani_can_view_story(story.id, (select auth.uid()))
    )
  );

-- الإعجابات: قراءة صاحبها أو مالك القصة
drop policy if exists aani_story_likes_select_own on public.story_likes;
create policy aani_story_likes_select_own on public.story_likes
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
    )
  );

-- الإعجاب: من يستطيع مشاهدة القصة
drop policy if exists aani_story_likes_insert_own on public.story_likes;
create policy aani_story_likes_insert_own on public.story_likes
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

-- إلغاء الإعجاب: صاحب الإعجاب وحده
drop policy if exists aani_story_likes_delete_own on public.story_likes;
create policy aani_story_likes_delete_own on public.story_likes
  for delete to authenticated using (user_id = (select auth.uid()));

-- =====================================================================
-- 4) دالة تسجيل المشاهدة (idempotent) — بنية الفعلية: viewer_id
--    (viewed_at وuser_id يُشتقان تلقائياً عبر المنظر للقراءة)
-- =====================================================================

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

  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, viewer_id)
  on conflict (story_id, viewer_id) do nothing;
end;
$$;
revoke all on function public.aani_record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid) to authenticated;

-- =====================================================================
-- 5) Realtime على الجدولين (تحديث لحظي لقائمة المشاهدين)
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
-- 6) تحديث كاش PostgREST
-- =====================================================================

notify pgrst, 'reload schema';

commit;
