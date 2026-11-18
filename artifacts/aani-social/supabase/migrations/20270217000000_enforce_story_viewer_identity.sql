-- ============================================================================
-- إلزام هوية المستدعي داخل public.aani_can_view_story(uuid, uuid)
--
-- المشكلة: الدالة SECURITY DEFINER وتقبل p_viewer_id من العميل، فكان أي مستخدم
-- مسجَّل يستطيع تمرير معرّف مستخدم آخر وفحص صلاحيته على قصة يعرف معرّفها، أي
-- تحويلها إلى أداة استعلام عن خصوصية الآخرين (بلوك/إخفاء/حساب خاص/أصدقاء
-- مقربين/سلسلة إعادة نشر).
--
-- الإصلاح: تُرفض أي هوية لا تطابق auth.uid() برمز 42501 قبل تنفيذ أي استعلام،
-- ويبقى متن الاستعلام نفسه كما هو حرفياً (لا تغيير في قواعد الظهور).
--
-- مراجعة مواضع الاستدعاء في المستودع (كلها تمرّر auth.uid()):
--   * سياسات RLS: aani_stories_followers_guard، aani_story_views_insert_viewer،
--     aani_story_views_insert_guard، سياسات stories في 20261114000000،
--     سياسة story_reports، وسياسات aani_can_reshare_story → (select auth.uid()).
--   * دوال: aani_record_story_view (viewer_id := auth.uid())، وaani_can_reshare_story
--     (تستدعيها السياسات وaani_create_story بـ auth.uid())، ودوال وصول الوسائط
--     aani_media_object_readable في 20270207000000 و20270208000000
--     (v_viewer := auth.uid()).
--   * كود التطبيق: لا يوجد أي استدعاء مباشر (rpc) للدالة في artifacts/aani-social/src.
-- لذلك لا يتأثر مسار قراءة القصص ولا مسار تسجيل المشاهدة.
--
-- لا تُعدَّل صلاحيات أي دالة أخرى، ولا سياسة، ولا جدول. آمن لإعادة التشغيل.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) شروط مسبقة
-- ============================================================================
do $$
declare
  v_function regprocedure := to_regprocedure('public.aani_can_view_story(uuid, uuid)');
  v_secdef boolean;
begin
  if v_function is null then
    raise exception 'aani: public.aani_can_view_story(uuid, uuid) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  select proc.prosecdef into v_secdef
  from pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_secdef, false) then
    raise exception 'aani: public.aani_can_view_story ليست SECURITY DEFINER؛ القواعد الحالية تفترض صلاحيات المالك. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  -- منع التعديل على نسخة متوقفة/غير المستهدفة: التوقيع أعلاه هو الوحيد.
  if to_regprocedure('public.aani_can_view_story(uuid, uuid, text)') is not null then
    raise notice 'aani: توجد نسخة إضافية من aani_can_view_story بتوقيع آخر ولا تُلمس.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) التطبيق: نفس المتن + حارس الهوية قبل أي استعلام
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
    media_url,
    media_type,
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
      story.media_url,
      story.media_type,
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
      original.media_url,
      original.media_type,
      original.share_type,
      child.share_type = 'reshare'
        and child.media_url is not distinct from original.media_url
        and child.media_type = original.media_type
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
              where (blocked.blocker_id = story.user_id and blocked.blocked_user_id = p_viewer_id)
                 or (blocked.blocker_id = p_viewer_id and blocked.blocked_user_id = story.user_id)
            )
            or exists (
              select 1 from public.story_hidden_users as hidden
              where hidden.story_owner_id = story.user_id
                and hidden.hidden_user_id = p_viewer_id
            )
            or (owner.is_private and not exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = story.user_id
            ))
            or (
              story.is_close_friends
              and (
                not exists (
                  select 1
                  from public.close_friends as listed
                  where listed.user_id = story.user_id
                    and listed.friend_id = p_viewer_id
                )
                or not public.aani_is_mutual_follow(story.user_id, p_viewer_id)
              )
            )
          )
        )
    )
  into v_result;

  return coalesce(v_result, false);
end;
$$;

-- الصلاحيات كما هي: authenticated تحتفظ بها، وanon مسحوبة (20270216000000).
revoke execute on function public.aani_can_view_story(uuid, uuid) from public;
revoke execute on function public.aani_can_view_story(uuid, uuid) from anon;
grant execute on function public.aani_can_view_story(uuid, uuid) to authenticated;
grant execute on function public.aani_can_view_story(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 3) اختبارات تحقق داخلية: أي فشل يُفشل الملف كاملاً.
-- ============================================================================
do $$
declare
  v_function regprocedure := 'public.aani_can_view_story(uuid, uuid)'::regprocedure;
  v_definition text;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_actor uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_probe uuid := gen_random_uuid();
  v_rejected boolean := false;
  v_allowed_viewer boolean;
  v_secdef boolean;
begin
  -- (أ) المتن الجديد مثبت فعلاً (حارس الهوية موجود في تعريف الدالة)
  select pg_get_functiondef(v_function) into v_definition;

  if v_definition is null or position('aani-guard:viewer-identity' in v_definition) = 0 then
    raise exception 'aani: متن aani_can_view_story لا يحتوي حارس الهوية؛ التعديل لم يُطبَّق.'
      using errcode = '42501';
  end if;

  select proc.prosecdef into v_secdef
  from pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_secdef, false) then
    raise exception 'aani: aani_can_view_story فقدت SECURITY DEFINER بعد التعديل.'
      using errcode = '42501';
  end if;

  -- (ب) الصلاحيات لم تتغير
  if has_function_privilege('anon', v_function, 'EXECUTE') then
    raise exception 'aani: anon يملك EXECUTE على aani_can_view_story.'
      using errcode = '42501';
  end if;

  if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
    raise exception 'aani: authenticated فقد صلاحية EXECUTE على aani_can_view_story.'
      using errcode = '42501';
  end if;

  -- (ج) اختبار سلوكي محاكى: هوية أخرى تُرفض، وهوية المستدعي تُقبل (تُعيد false لمعرّف غير موجود)
  perform set_config('request.jwt.claims', json_build_object('sub', v_actor)::text, true);
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  if (select auth.uid()) is distinct from v_actor then
    raise notice 'aani: اختبار الهوية المتوقعة تخطّي — auth.uid() لا يتبع request.jwt.claims في هذا المخطط.';
  else
    begin
      perform public.aani_can_view_story(v_probe, v_other);
    exception
      when insufficient_privilege then
        v_rejected := true;
    end;

    if not v_rejected then
      raise exception 'aani: aani_can_view_story لم ترفض p_viewer_id المخالف لهوية المستدعي.'
        using errcode = '42501';
    end if;

    -- هوية المستدعي نفسها تمر: قصة غير موجودة ⇒ false بلا استثناء
    v_allowed_viewer := public.aani_can_view_story(v_probe, v_actor);

    if v_allowed_viewer is distinct from false then
      raise exception 'aani: aani_can_view_story أعادت % لمعرّف قصة غير موجود بهوية المستدعي (المتوقع false).', v_allowed_viewer
        using errcode = '42501';
    end if;
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

-- ============================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط)
-- ============================================================================
-- select pg_get_functiondef('public.aani_can_view_story(uuid, uuid)'::regprocedure);
--
-- select r.rolname,
--        has_function_privilege(r.rolname, 'public.aani_can_view_story(uuid, uuid)'::regprocedure, 'EXECUTE')
--   from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role');
