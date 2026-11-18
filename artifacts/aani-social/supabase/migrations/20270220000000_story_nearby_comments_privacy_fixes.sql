-- ============================================================================
-- إصلاحات خصوصية مركزة: قراءة القصص، الأشخاص القريبون، دالة التقييد
--
-- 1) public.stories:
--    سياسة قديمة permissive باسم «Signed-in users can read active stories»
--    تسمح لأي مستخدم مسجَّل بقراءة كل قصة نشطة. في PostgreSQL تُجمع سياسات
--    SELECT الـ permissive بمنطق OR، فتبقى هذه السياسة تتجاوز شروط الخصوصية.
--    يُزال أي اسم معروف من هذه الأسماء، ثم يُعاد إنشاء السياسة permissive
--    الوحيدة المصرَّح بها (صاحب القصة أو aani_can_view_story) والحارس
--    restrictive المطابق. ولا تُمس سياسة الإدخال/الحذف ولا صلاحيات الجدول.
--
-- 2) public.aani_nearby_people(integer):
--    تُعاد بنفس المنطق والترتيب والحدود، مضافاً إليها استبعاد كل حساب يوجد
--    بينه وبين المستخدم الحالي حظر في أي اتجاه. الدالة لا تقبل هوية مستخدم:
--    المشاهد دائماً auth.uid().
--
-- 3) public.aani_comment_visible_under_restriction + سياسة
--    aani_comments_restriction_read_guard:
--    كانت السياسة تمرّر (post_id, user_id, (select auth.uid()))، والدالة
--    تقبل p_viewer_id من المستدعي وتسمح بتمرير p_author_id اعتباطياً، فيمكن
--    استعمالها لاستكشاف علاقات التقييد بين حسابات أخرى. تُضاف نسخة من الدالة
--    لا تقبل المشاهد (auth.uid() داخلياً) وتشترط أن الزوج (post_id, author_id)
--    تعليقٌ حقيقي، وتُوجَّه السياسة إليها. النسخة القديمة تبقى بنفس التوقيع
--    (حتى لا تنكسر أي سياسة أخرى) لكنها تُقيَّد بنفس الشرطين، فلا تُستعمل
--    لمعرّفات اعتباطية.
--
-- آمن لإعادة التطبيق. لا يغيّر بيانات المستخدمين ولا المنشورات ولا القصص
-- ولا التعليقات، ولا صلاحيات Storage أو روابط الوسائط.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة
-- ============================================================================
do $$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.stories') is null then
    v_missing := v_missing || 'public.stories';
  end if;
  if to_regclass('public.profiles') is null then
    v_missing := v_missing || 'public.profiles';
  end if;
  if to_regclass('public.user_blocks') is null then
    v_missing := v_missing || 'public.user_blocks';
  end if;
  if to_regclass('public.comments') is null then
    v_missing := v_missing || 'public.comments';
  end if;
  if to_regprocedure('public.aani_can_view_story(uuid, uuid)') is null then
    v_missing := v_missing || 'public.aani_can_view_story(uuid, uuid)';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'aani: كائنات مطلوبة غير موجودة: %. أوقف الترحيل.', array_to_string(v_missing, ', ')
      using errcode = '42P01';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.user_blocks'::regclass
      and attname = 'blocker_id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'aani: public.user_blocks.blocker_id غير موجود. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.user_blocks'::regclass
      and attname in ('blocked_user_id', 'blocked_id') and attnum > 0 and not attisdropped
  ) then
    raise exception 'aani: public.user_blocks لا يحتوي blocked_user_id ولا blocked_id. أوقف الترحيل.'
      using errcode = '42703';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass
      and attname = 'city_key' and attnum > 0 and not attisdropped
  ) then
    raise exception 'aani: public.profiles.city_key غير موجود (مطلوب لـ aani_nearby_people). أوقف الترحيل.'
      using errcode = '42703';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) سياسات قراءة القصص
-- ============================================================================

-- 1.1 إزالة الأسماء القديمة permissive التي تتجاوز شروط الخصوصية.
--     تُحذف بالاسم فقط، وIF EXISTS يجعلها آمنة على البيئات التي لا تحتويها.
drop policy if exists "Signed-in users can read active stories" on public.stories;
drop policy if exists "Users can view active stories" on public.stories;
drop policy if exists "Anyone can view stories" on public.stories;
drop policy if exists "Public stories are viewable by everyone" on public.stories;
drop policy if exists "Enable read access for all users" on public.stories;

-- 1.2 السياسة permissive الوحيدة: صاحب القصة (نشطة) أو من يجيز له المنطق.
drop policy if exists aani_stories_select_visible on public.stories;
create policy aani_stories_select_visible on public.stories
  as permissive
  for select to authenticated
  using (
    (
      user_id = (select auth.uid())
      and created_at >= now() - interval '24 hours'
      and created_at <= now() + interval '5 minutes'
      and expires_at > now()
      and expires_at <= created_at + interval '24 hours'
    )
    or public.aani_can_view_story(id, (select auth.uid()))
  );

-- 1.3 حارس restrictive: يمنع أي مسار آخر من تجاوز شروط الرؤية.
drop policy if exists aani_stories_followers_guard on public.stories;
create policy aani_stories_followers_guard on public.stories
  as restrictive
  for select to authenticated
  using (
    created_at >= now() - interval '24 hours'
    and created_at <= now() + interval '5 minutes'
    and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and (
      user_id = (select auth.uid())
      or public.aani_can_view_story(id, (select auth.uid()))
    )
  );

-- ----------------------------------------------------------------------------
-- 2) الأشخاص القريبون: استبعاد الحظر في أي اتجاه
-- ============================================================================
create or replace function public.aani_nearby_people(p_limit integer default 200)
returns table (
  id uuid,
  username text,
  full_name text,
  display_name text,
  avatar_url text,
  city text
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select profile.id, profile.city_key
    from public.profiles as profile
    where profile.id = (select auth.uid())
      and coalesce(profile.show_city, true)
  )
  select
    other.id,
    other.username,
    other.full_name,
    other.display_name,
    other.avatar_url,
    case when coalesce(other.show_city, true) then other.city else null end
  from public.profiles as other
  cross join me
  where (select auth.uid()) is not null
    and other.id <> me.id
    and me.city_key is not null
    and other.city_key = me.city_key
    and coalesce(other.show_city, true)
    and coalesce(other.is_nearby_visible, true)
    and not coalesce(other.is_deactivated, false)
    -- لا حظر في أي اتجاه بين المستخدم الحالي وهذا الحساب.
    -- العمود الثاني يُقرأ عبر to_jsonb فيعمل مع blocked_user_id وblocked_id.
    and not exists (
      select 1
      from public.user_blocks as blocked
      where (
        blocked.blocker_id = me.id
        and coalesce(to_jsonb(blocked) ->> 'blocked_user_id', to_jsonb(blocked) ->> 'blocked_id') = other.id::text
      ) or (
        blocked.blocker_id = other.id
        and coalesce(to_jsonb(blocked) ->> 'blocked_user_id', to_jsonb(blocked) ->> 'blocked_id') = me.id::text
      )
    )
  order by other.created_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

revoke all on function public.aani_nearby_people(integer) from public, anon;
grant execute on function public.aani_nearby_people(integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 3) دالة التقييد: المشاهد من auth.uid() دائماً، والزوج تعليقٌ حقيقي
-- ============================================================================

-- 3.1 النسخة الجديدة التي تستخدمها السياسة: لا تقبل هوية المشاهد إطلاقاً.
create or replace function public.aani_comment_visible_under_restriction(
  p_post_id uuid,
  p_author_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    -- لا يكفي تمرير معرّفات اعتباطية: يجب أن يكون الزوج تعليقاً حقيقياً.
    and exists (
      select 1
      from public.comments as comment
      where comment.post_id = p_post_id
        and comment.user_id = p_author_id
    )
    and not exists (
      select 1
      from public.posts as post
      join public.user_restrictions as restriction
        on restriction.restricter_id = post.user_id
       and restriction.restricted_user_id = p_author_id
      where post.id = p_post_id
        and p_author_id <> post.user_id
        and (select auth.uid()) <> post.user_id
        and (select auth.uid()) <> p_author_id
    );
$$;

revoke all on function public.aani_comment_visible_under_restriction(uuid, uuid) from public, anon;
grant execute on function public.aani_comment_visible_under_restriction(uuid, uuid) to authenticated;

-- 3.2 النسخة القديمة (3 معاملات) تُقيَّد بنفس المنطق، حتى لا تُستعمل
--     لاستكشاف علاقات التقييد بمعرّفات اعتباطية. تبقى بنفس التوقيع كي لا
--     تنكسر أي سياسة أخرى تعتمدها، وتُبقي شرط p_viewer_id = auth.uid().
create or replace function public.aani_comment_visible_under_restriction(
  p_post_id uuid,
  p_author_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer_id = (select auth.uid())
    and exists (
      select 1
      from public.comments as comment
      where comment.post_id = p_post_id
        and comment.user_id = p_author_id
    )
    and not exists (
      select 1
      from public.posts as post
      join public.user_restrictions as restriction
        on restriction.restricter_id = post.user_id
       and restriction.restricted_user_id = p_author_id
      where post.id = p_post_id
        and p_author_id <> post.user_id
        and p_viewer_id <> post.user_id
        and p_viewer_id <> p_author_id
    );
$$;

revoke all on function public.aani_comment_visible_under_restriction(uuid, uuid, uuid) from public, anon;
grant execute on function public.aani_comment_visible_under_restriction(uuid, uuid, uuid) to authenticated;

-- 3.3 السياسة تُوجَّه إلى النسخة ذات المعاملين.
drop policy if exists aani_comments_restriction_read_guard on public.comments;
create policy aani_comments_restriction_read_guard on public.comments
  as restrictive for select to authenticated
  using (public.aani_comment_visible_under_restriction(post_id, user_id));

-- ----------------------------------------------------------------------------
-- 4) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_policy record;
  v_definition text;
begin
  -- (أ) لا تبقى سياسة select permissive عامة على القصص (لا تذكر الهوية ولا الدالة)
  for v_policy in
    select policyname, coalesce(qual, '') as qual
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stories'
      and cmd = 'SELECT'
      and permissive = 'PERMISSIVE'
      and coalesce(qual, '') not ilike '%aani_can_view_story%'
      and coalesce(qual, '') not ilike '%user_id%'
  loop
    raise exception 'aani: سياسة قراءة عامة على public.stories تتجاوز الخصوصية: % (%). أوقف الترحيل وحدّدها يدوياً.',
      v_policy.policyname, v_policy.qual
      using errcode = '42501';
  end loop;

  -- (ب) السياسة المسموحة والحارس موجودان ويستندان إلى aani_can_view_story
  select coalesce(qual, '') into v_definition
  from pg_policies
  where schemaname = 'public' and tablename = 'stories'
    and policyname = 'aani_stories_select_visible';

  if v_definition = '' or position('aani_can_view_story' in v_definition) = 0 then
    raise exception 'aani: السياسة aani_stories_select_visible لا تستند إلى aani_can_view_story.'
      using errcode = '42501';
  end if;

  select coalesce(qual, '') into v_definition
  from pg_policies
  where schemaname = 'public' and tablename = 'stories'
    and policyname = 'aani_stories_followers_guard'
    and permissive = 'RESTRICTIVE';

  if v_definition = '' or position('aani_can_view_story' in v_definition) = 0 then
    raise exception 'aani: الحارس aani_stories_followers_guard غائب أو لا يستند إلى aani_can_view_story.'
      using errcode = '42501';
  end if;

  -- (ج) aani_nearby_people: لا معرّف مستخدم، وتستبعد الحظر
  select pg_get_functiondef('public.aani_nearby_people(integer)'::regprocedure) into v_definition;

  if position('user_blocks' in v_definition) = 0 or position('blocker_id' in v_definition) = 0 then
    raise exception 'aani: aani_nearby_people لا تستبعد الحظر.'
      using errcode = '42501';
  end if;

  if position('auth.uid()' in v_definition) = 0 then
    raise exception 'aani: aani_nearby_people لا تعتمد على auth.uid().'
      using errcode = '42501';
  end if;

  -- (د) سياسة التعليقات: restrictive، وتستدعي النسخة ذات المعاملين
  select coalesce(qual, '') into v_definition
  from pg_policies
  where schemaname = 'public' and tablename = 'comments'
    and policyname = 'aani_comments_restriction_read_guard'
    and permissive = 'RESTRICTIVE';

  if v_definition = '' then
    raise exception 'aani: سياسة aani_comments_restriction_read_guard غير موجودة كـ restrictive.'
      using errcode = '42501';
  end if;

  if position('aani_comment_visible_under_restriction' in v_definition) = 0 then
    raise exception 'aani: السياسة لا تستدعي aani_comment_visible_under_restriction.'
      using errcode = '42501';
  end if;

  -- (هـ) الدالتان موجودتان و authenticated تملك EXECUTE (لازمة لتقييم السياسة)
  if to_regprocedure('public.aani_comment_visible_under_restriction(uuid, uuid)') is null then
    raise exception 'aani: النسخة ذات المعاملين من aani_comment_visible_under_restriction غير موجودة.'
      using errcode = '42883';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.aani_comment_visible_under_restriction(uuid, uuid)'::regprocedure,
    'EXECUTE'
  ) then
    raise exception 'aani: authenticated لا تملك EXECUTE على نسخة المعاملين — ستتعطّل السياسة.'
      using errcode = '42501';
  end if;

  if has_function_privilege(
    'anon',
    'public.aani_comment_visible_under_restriction(uuid, uuid)'::regprocedure,
    'EXECUTE'
  ) then
    raise exception 'aani: anon تملك EXECUTE على aani_comment_visible_under_restriction.'
      using errcode = '42501';
  end if;
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط):
-- select policyname, permissive, cmd, qual from pg_policies
--  where schemaname='public' and tablename='stories' and cmd='SELECT';
-- select * from public.aani_nearby_people(50);
-- select policyname, permissive, qual from pg_policies
--  where schemaname='public' and tablename='comments' and policyname='aani_comments_restriction_read_guard';
