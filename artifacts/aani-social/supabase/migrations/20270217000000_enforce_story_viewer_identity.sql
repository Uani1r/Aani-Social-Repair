-- ============================================================================
-- aani_can_view_story: إلزام أن p_viewer_id يطابق auth.uid()
-- نسخة متوافقة مع المنطق المنشور فعلاً في قاعدة البيانات (بلا story_hidden_users)
--
-- الخلفية التي بُني عليها التعديل:
--   * النسخة العاملة في الإنتاج هي المعرَّفة في
--     supabase/APPLY_MANUALLY_story_views_likes.sql (سطر 53): سلسلة إعادة النشر
--     + التحقق من الانتهاء + الحظر عبر public.user_blocks(blocked_id) +
--     الحساب الخاص عبر follows + الأصدقاء المقربون عبر close_friends.
--   * النسخة الموجودة في 20261115000000_story_viewer_actions.sql تضيف
--     public.story_hidden_users وaani_is_mutual_follow وتستخدم
--     user_blocks.blocked_user_id، وهذا الترحيل غير مطبَّق لا في قاعدة الاختبار
--     ولا في الإنتاج، وجدول story_hidden_users غير موجود فيهما. الاعتماد عليه
--     هنا كان سيُسقط الفحص وقت التشغيل.
--
-- ما يفعله هذا الترحيل فقط:
--   1) لا ينشئ أي جدول ولا يطبّق أي ترحيل آخر.
--   2) يعيد تعريف الدالة بمنطق النسخة المنشورة نفسها (blocked_id، بلا
--      story_hidden_users، بلا aani_is_mutual_follow، بلا أعمدة وسائط).
--   3) يضيف حارس الهوية فقط: يُرفض p_viewer_id إن لم يطابق auth.uid().
--
-- لا تعديل على صلاحيات أي دالة أخرى ولا على أي سياسة أو جدول.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) شروط مسبقة
-- ============================================================================
do $$
declare
  v_function regprocedure := to_regprocedure('public.aani_can_view_story(uuid, uuid)');
  v_secdef boolean;
  v_dep text;
  v_deps text[] := array[
    'public.stories',
    'public.profiles',
    'public.user_blocks',
    'public.follows',
    'public.close_friends'
  ];
begin
  if v_function is null then
    raise exception 'aani: public.aani_can_view_story(uuid, uuid) غير موجودة بهذا التوقيع. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  select proc.prosecdef into v_secdef
  from pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_secdef, false) then
    raise exception 'aani: aani_can_view_story موجودة لكنها ليست SECURITY DEFINER. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  foreach v_dep in array v_deps
  loop
    if to_regclass(v_dep) is null then
      raise exception 'aani: الجدول % مطلوب لهذا التعديل وغير موجود. أوقف الترحيل.', v_dep
        using errcode = '42P01';
    end if;
  end loop;

  -- العمود المنشور فعلاً في سجل الحظر: blocked_id
  if not exists (
    select 1
    from pg_attribute as att
    where att.attrelid = to_regclass('public.user_blocks')
      and att.attname = 'blocked_id'
      and att.attnum > 0
      and not att.attisdropped
  ) then
    raise exception 'aani: public.user_blocks لا يحتوي العمود blocked_id الذي تعتمد عليه النسخة المنشورة من aani_can_view_story. أوقف الترحيل بدل تغيير المنطق.'
      using errcode = '42703';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) إعادة التعريف: منطق النسخة المنشورة + حارس الهوية
-- ============================================================================
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
  -- aani-guard:viewer-identity — لا يُسمح بفحص الصلاحية إلا لهوية المستدعي نفسه
  if p_viewer_id is not null and p_viewer_id is distinct from v_actor then
    raise exception 'Story visibility can only be evaluated for the authenticated viewer'
      using errcode = '42501';
  end if;

  with recursive story_chain (
    id,
    user_id,
    is_close_friends,
    original_story_id,
    created_at,
    expires_at,
    share_type,
    parent_link_valid
  ) as (
    select
      story.id,
      story.user_id,
      story.is_close_friends,
      story.original_story_id,
      story.created_at,
      story.expires_at,
      story.share_type,
      true
    from public.stories as story
    where story.id = p_story_id

    union all

    select
      original.id,
      original.user_id,
      original.is_close_friends,
      original.original_story_id,
      original.created_at,
      original.expires_at,
      original.share_type,
      child.share_type = 'reshare'
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
            exists (
              select 1 from public.user_blocks as blocked
              where (blocked.blocker_id = story.user_id and blocked.blocked_id = p_viewer_id)
                 or (blocked.blocker_id = p_viewer_id and blocked.blocked_id = story.user_id)
            )
            or (owner.is_private and not exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = story.user_id
            ))
            or (
              story.is_close_friends
              and not exists (
                select 1
                from public.close_friends as listed
                where listed.user_id = story.user_id
                  and listed.friend_id = p_viewer_id
              )
            )
          )
        )
    )
  into v_result;

  return coalesce(v_result, false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) الصلاحيات: anon مسحوبة، authenticated وservice_role محفوظة
-- ============================================================================
revoke execute on function public.aani_can_view_story(uuid, uuid) from public;
revoke execute on function public.aani_can_view_story(uuid, uuid) from anon;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;
grant execute on function public.aani_can_view_story(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 3) تحقق بعد التعديل
-- ============================================================================
do $$
declare
  v_function regprocedure := 'public.aani_can_view_story(uuid, uuid)'::regprocedure;
  v_definition text;
  v_secdef boolean;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_actor uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_probe uuid := gen_random_uuid();
  v_rejected boolean := false;
  v_allowed boolean;
begin
  -- (أ) الحارس مثبت، ولا اعتماد على story_hidden_users
  select pg_get_functiondef(v_function) into v_definition;

  if v_definition is null or position('aani-guard:viewer-identity' in v_definition) = 0 then
    raise exception 'aani: حارس الهوية غير مثبت في aani_can_view_story.'
      using errcode = '42501';
  end if;

  if position('story_hidden_users' in v_definition) > 0 then
    raise exception 'aani: تعريف aani_can_view_story ما زال يعتمد على story_hidden_users.'
      using errcode = '42501';
  end if;

  -- (ب) ما زالت SECURITY DEFINER
  select proc.prosecdef into v_secdef
  from pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_secdef, false) then
    raise exception 'aani: aani_can_view_story فقدت SECURITY DEFINER بعد التعديل.'
      using errcode = '42501';
  end if;

  -- (ج) الصلاحيات
  if has_function_privilege('anon', v_function, 'EXECUTE') then
    raise exception 'aani: anon يملك EXECUTE على aani_can_view_story.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
    raise exception 'aani: authenticated لا يملك EXECUTE على aani_can_view_story.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('service_role', v_function, 'EXECUTE') then
    raise exception 'aani: service_role لا يملك EXECUTE على aani_can_view_story.'
      using errcode = '42501';
  end if;

  -- (د) اختبار سلوكي بهوية مُحاكاة (يُتخطى إن لم يدعم المخطط claims)
  perform set_config('request.jwt.claims', json_build_object('sub', v_actor)::text, true);
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  if (select auth.uid()) is distinct from v_actor then
    raise notice 'aani: اختبار حارس الهوية مُتخطَّى — auth.uid() لا يتبع request.jwt.claims في هذا المخطط.';
  else
    begin
      perform public.aani_can_view_story(v_probe, v_other);
    exception
      when insufficient_privilege then
        v_rejected := true;
    end;

    if not v_rejected then
      raise exception 'aani: aani_can_view_story قبلت p_viewer_id مختلفاً عن هوية المستدعي.'
        using errcode = '42501';
    end if;

    v_allowed := public.aani_can_view_story(v_probe, v_actor);

    if v_allowed is distinct from false then
      raise exception 'aani: aani_can_view_story لم تُعِد false لمعرّف قصة غير موجود بهوية مطابقة (أعادت %).', v_allowed
        using errcode = '42501';
    end if;
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;
