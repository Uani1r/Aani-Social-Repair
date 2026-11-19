-- =====================================================================
-- Aani Stories — فحص audience فعلي في aani_can_view_story + تقوية story_likes
--
-- الحالة: لم يُنفَّذ على أي قاعدة بيانات. يُطبَّق يدويًا بعد المراجعة.
--
-- 1) aani_can_view_story: يُعاد تعريفه بنفس منطق النسخة المنشورة (هوية
--    المستدعي، انتهاء القصة، سلسلة إعادة المشاركة، خصوصية الحساب، الحظر عبر
--    user_blocks.blocker_id/blocked_id) مع فحص audience فعلي:
--      * public        → مسموح (مع بقاء قيود الحساب الخاص والحظر)
--      * close_friends → عضو close_friends فقط
--      * followers     → متابعة معتمدة فقط
--      * أي قيمة أخرى → يُرفض
--    التوافق مع القصص القديمة: يُقرأ audience عبر to_jsonb(story) فلا يفشل
--    الترحيل إن غاب العمود، وأي قيمة غائبة/فارغة تُشتق من is_close_friends:
--    true → close_friends، false → public.
--
-- 2) story_likes:
--      * حذف السياسة المتساهلة القديمة "Users like stories as themselves"
--        التي كانت تسمح بالإدخال دون فحص رؤية القصة.
--      * حذف سياسة القراءة العامة "Signed-in users read story likes" لتبقى
--        القراءة لصاحب الإعجاب وصاحب القصة فقط.
--      * إعادة إنشاء الإدخال المتساهل بشرط aani_can_view_story، مع سياسة
--        restrictive إضافية بنفس الشرط.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0) شروط مسبقة
-- ---------------------------------------------------------------------
do $$
declare
  v_story_columns text[] := array['id', 'user_id', 'is_close_friends', 'created_at', 'expires_at', 'original_story_id', 'share_type', 'media_url', 'media_type'];
  v_like_columns text[] := array['story_id', 'user_id'];
  v_column text;
  v_story_function regprocedure := to_regprocedure('public.aani_can_view_story(uuid, uuid)');
  v_mutual_follow_function regprocedure := to_regprocedure('public.aani_is_mutual_follow(uuid, uuid)');
  v_story_function_owner oid;
begin
  if to_regclass('public.stories') is null then
    raise exception 'public.stories غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if to_regclass('public.story_likes') is null then
    raise exception 'public.story_likes غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if to_regclass('public.close_friends') is null then
    raise exception 'public.close_friends غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if to_regclass('public.user_blocks') is null then
    raise exception 'public.user_blocks غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if to_regclass('public.follows') is null then
    raise exception 'public.follows غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles غير موجود. أوقف الترحيل.' using errcode = '42P01';
  end if;
  if v_story_function is null then
    raise exception 'public.aani_can_view_story(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;
  if v_mutual_follow_function is null then
    raise exception 'public.aani_is_mutual_follow(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;
  select proc.proowner
    into v_story_function_owner
  from pg_proc as proc
  where proc.oid = v_story_function;
  if v_story_function_owner is null
     or not has_function_privilege(
       v_story_function_owner,
       v_mutual_follow_function,
       'EXECUTE'
     ) then
    raise exception 'مالك aani_can_view_story لا يملك EXECUTE على aani_is_mutual_follow. أوقف الترحيل.'
      using errcode = '42501';
  end if;
  if to_regprocedure('public.aani_is_user_blocked(uuid,uuid)') is null then
    raise exception 'public.aani_is_user_blocked(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  foreach v_column in array array['blocker_id', 'blocked_id']
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.user_blocks'::regclass
        and attname = v_column and attnum > 0 and not attisdropped
    ) then
      raise exception 'العمود public.user_blocks.% غير موجود (المتوقع blocker_id/blocked_id). أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;

  foreach v_column in array v_story_columns
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.stories'::regclass
        and attname = v_column and attnum > 0 and not attisdropped
    ) then
      raise exception 'العمود public.stories.% غير موجود. أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;

  foreach v_column in array v_like_columns
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.story_likes'::regclass
        and attname = v_column and attnum > 0 and not attisdropped
    ) then
      raise exception 'العمود public.story_likes.% غير موجود. أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1) إعادة تعريف aani_can_view_story مع فحص audience
--    (نفس النسخة المنشورة + audience؛ SECURITY DEFINER و search_path = '')
-- ---------------------------------------------------------------------
create or replace function public.aani_can_view_story(p_story_id uuid, p_viewer_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_result boolean;
begin
  -- لا يُسمح بفحص الصلاحية إلا لهوية المستدعي نفسه
  if p_viewer_id is not null and p_viewer_id is distinct from v_actor then
    raise exception 'Story visibility can only be evaluated for the authenticated viewer'
      using errcode = '42501';
  end if;

  with recursive story_chain (
    id,
    user_id,
    is_close_friends,
    original_story_id,
    media_url,
    media_type,
    created_at,
    expires_at,
    share_type,
    parent_link_valid,
    audience
  ) as (
    select
      story.id,
      story.user_id,
      story.is_close_friends,
      story.original_story_id,
      story.media_url,
      story.media_type,
      story.created_at,
      story.expires_at,
      story.share_type,
      true,
      -- audience من العمود إن وُجد، وإلا تُشتق من is_close_friends (توافق قديم)
      coalesce(
        nullif(to_jsonb(story) ->> 'audience', ''),
        case when story.is_close_friends then 'close_friends' else 'all' end
      )
    from public.stories as story
    where story.id = p_story_id

    union all

    select
      original.id,
      original.user_id,
      original.is_close_friends,
      original.original_story_id,
      original.media_url,
      original.media_type,
      original.created_at,
      original.expires_at,
      original.share_type,
      -- سلامة إعادة المشاركة: النوع reshare AND نفس الوسائط تمامًا (لا نوع ولا رابط مختلف)
      (
        child.share_type = 'reshare'
        and child.media_url is not distinct from original.media_url
        and child.media_type = original.media_type
      ),
      coalesce(
        nullif(to_jsonb(original) ->> 'audience', ''),
        case when original.is_close_friends then 'close_friends' else 'all' end
      )
    from public.stories as original
    join story_chain as child on child.original_story_id = original.id
  )
  select
    p_viewer_id is not null
    and exists (select 1 from story_chain where id = p_story_id)
    and not exists (
      select 1
      from story_chain as story
      join public.profiles as owner on owner.id = story.user_id
      where story.created_at < now() - interval '24 hours'
        or story.created_at > now() + interval '5 minutes'
        or story.expires_at <= now()
        or story.expires_at > story.created_at + interval '24 hours'
        or not story.parent_link_valid
        or (
          story.user_id <> p_viewer_id
          and (
            -- الحظر في أي اتجاه (blocker_id/blocked_id)
            exists (
              select 1 from public.user_blocks as blocked
              where (blocked.blocker_id = story.user_id and blocked.blocked_id = p_viewer_id)
                 or (blocked.blocker_id = p_viewer_id and blocked.blocked_id = story.user_id)
            )
            -- الحساب الخاص: متابعة معتمدة فقط
            or (owner.is_private and not exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = story.user_id
            ))
            -- جمهور القصة: is_close_friends=true قيد أمني دائم لا يُتجاوَز
            -- بقيمة audience، ويشترط العضوية والمتابعة المعتمدة.
            or (
              story.is_close_friends
              and not exists (
                select 1
                from public.close_friends as listed
                where listed.user_id = story.user_id
                  and listed.friend_id = p_viewer_id
                  and public.aani_is_mutual_follow(story.user_id, p_viewer_id)
              )
            )
            -- وفي غير قصة Close Friends: القيمة الفعلية all تعني قصة عامة.
            or (
              not story.is_close_friends
              and case lower(coalesce(story.audience, 'all'))
                when 'all' then false
                when 'public' then false
                when 'close_friends' then not exists (
                  select 1
                  from public.close_friends as listed
                  where listed.user_id = story.user_id
                    and listed.friend_id = p_viewer_id
                    and public.aani_is_mutual_follow(story.user_id, p_viewer_id)
                )
                when 'followers' then not exists (
                  select 1
                  from public.follows as accepted
                  where accepted.follower_id = p_viewer_id
                    and accepted.following_id = story.user_id
                )
                else true -- أي جمهور غير معروف: يُرفض
              end
            )
          )
        )
    )
  into v_result;

  return coalesce(v_result, false);
end;
$$;

revoke execute on function public.aani_can_view_story(uuid, uuid) from public;
revoke execute on function public.aani_can_view_story(uuid, uuid) from anon;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;
grant execute on function public.aani_can_view_story(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 2) story_likes: إزالة السياسات المتساهلة القديمة وتقوية الإدخال والقراءة
-- ---------------------------------------------------------------------
-- السياسة القديمة التي كانت تسمح بالإدخال بلا فحص رؤية القصة
drop policy if exists "Users like stories as themselves" on public.story_likes;
-- سياسة القراءة العامة: تُحذف لتبقى القراءة لصاحب الإعجاب وصاحب القصة فقط
drop policy if exists "Signed-in users read story likes" on public.story_likes;

-- قراءة permissive: صاحب الإعجاب أو صاحب القصة (مع احترام الحظر)
drop policy if exists aani_story_likes_select_own on public.story_likes;
create policy aani_story_likes_select_own on public.story_likes
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_likes.user_id)
    )
  );

-- قيد restrictive على القراءة بنفس الشرطين (حماية مضاعفة)
drop policy if exists aani_story_likes_owner_guard on public.story_likes;
create policy aani_story_likes_owner_guard on public.story_likes
  as restrictive for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.stories as story
      where story.id = story_likes.story_id
        and story.user_id = (select auth.uid())
        and not public.aani_is_user_blocked(story.user_id, story_likes.user_id)
    )
  );

-- إدخال permissive: صاحب الإعجاب نفسه وقصة يملك حق رؤيتها
drop policy if exists aani_story_likes_insert_own on public.story_likes;
create policy aani_story_likes_insert_own on public.story_likes
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

-- حماية restrictive للإدخال: نفس الشرط تمامًا
drop policy if exists aani_story_likes_insert_guard on public.story_likes;
create policy aani_story_likes_insert_guard on public.story_likes
  as restrictive for insert to authenticated with check (
    user_id = (select auth.uid())
    and public.aani_can_view_story(story_id, (select auth.uid()))
  );

-- حذف الإعجاب: صاحبه فقط
drop policy if exists aani_story_likes_delete_own on public.story_likes;
create policy aani_story_likes_delete_own on public.story_likes
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 3) تحقق بعد التعديل
-- ---------------------------------------------------------------------
do $$
declare
  v_definition text;
  v_policy_count integer;
begin
  -- الدالة ما زالت SECURITY DEFINER وبـ search_path فارغ وذات audience
  select pg_get_functiondef('public.aani_can_view_story(uuid,uuid)'::regprocedure)
  into v_definition;

  if position('audience' in v_definition) = 0 then
    raise exception 'aani_can_view_story لا تفحص audience. أوقف الترحيل.'
      using errcode = '42501';
  end if;
  if position('blocked.blocker_id' in v_definition) = 0
     or position('blocked.blocked_id' in v_definition) = 0 then
    raise exception 'aani_can_view_story لا تفحص الحظر عبر blocker_id/blocked_id.'
      using errcode = '42501';
  end if;
  if position('is_close_friends' in v_definition) = 0 then
    raise exception 'aani_can_view_story فقدت توافق is_close_friends.'
      using errcode = '42501';
  end if;
  if position('aani_is_mutual_follow' in v_definition) = 0 then
    raise exception 'aani_can_view_story لا تفرض المتابعة المتبادلة لقصص Close Friends.'
      using errcode = '42501';
  end if;
  if position('media_type' in v_definition) = 0
     or position('is not distinct from' in lower(v_definition)) = 0 then
    raise exception 'تحقق سلامة إعادة المشاركة (media_url/media_type) غائب. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_likes'
      and policyname in ('Users like stories as themselves', 'Signed-in users read story likes')
  ) then
    raise exception 'سياسات story_likes القديمة المتساهلة ما زالت موجودة.'
      using errcode = '42501';
  end if;

  select count(*) into v_policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'story_likes'
    and policyname in ('aani_story_likes_insert_own', 'aani_story_likes_insert_guard');
  if v_policy_count <> 2 then
    raise exception 'حماية إدخال story_likes غير مثبتة (% من 2).', v_policy_count
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_likes'
      and policyname = 'aani_story_likes_insert_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'aani_story_likes_insert_guard ليست restrictive.'
      using errcode = '42501';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
