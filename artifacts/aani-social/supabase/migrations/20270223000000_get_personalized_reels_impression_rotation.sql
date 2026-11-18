-- =====================================================================
-- Aani Reels — تدوير واعٍ بالظهور السابق فوق محرك V2-B
-- public.get_personalized_reels(p_limit, p_candidate_limit) — التوقيع نفسه دون تغيير.
--
-- الحالة: لم يُنفَّذ على أي قاعدة بيانات. يُطبَّق يدويًا بعد المراجعة.
--
-- السبب الجذري لتكرار الريلز:
--   1) محرك V2-B يقرأ الظهور من نافذة 7 أيام فقط ويعاقبه بسقف 0.10، فلا أثر
--      لآخر ظهور بعد أسبوع.
--   2) لا يوجد ترتيب على «آخر ظهور» أصلًا: الترتيب على النقاط ثم التنويع.
--   3) سقف v_limit = 40 داخل المحرك كان يقصّ مجموعة المرشحين نفسها قبل أي تدوير،
--      فلا يصل إلى طبقة التدوير إلا أول 40 مرشحًا حتى مع p_candidate_limit = 200.
--   4) المخزون قليل، والعميل كان يستبدل القائمة المعروضة بكل تحديث صامت.
--
-- الحل:
--   * تُعاد تسمية الدالة المنشورة، ثم يُعاد إنشاء جسمها نفسه باسم
--     aani_get_personalized_reels_relevance مع تغييرين فقط:
--       - سقف مجموع المرشحين صار p_candidate_limit (بحد أقصى 200) لا 40.
--       - القصّ النهائي صار على v_candidates لا v_limit، فيُعاد كامل المرشحين.
--     النقاط والإشارات ومصادر المرشحين وحصص المتابعات/الاكتشاف/إعادة النشر
--     والتنويع بين المؤلفين والأصوات: كلها لم تتغيّر.
--   * get_personalized_reels تصبح طبقة تدوير تقرأ كامل مجموعة المرشحين من
--     المحرك الداخلي (حتى 200)، تربطها بسجل الظهور في post_impressions
--     (surface = 'reels' فقط)، ترتّبها بأولوية الظهور، ثم تُعيد أول p_limit فقط.
--   * غير المعروض > ظهر قبل أكثر من 7 أيام > ظهر قبل أكثر من 24 ساعة > ظهر
--     حديثًا، وداخل كل درجة يبقى ترتيب المحرك (relevance_rank) هو الفاصل، فيُحفظ
--     التنويع بين المؤلفين والأصوات.
--   * LEFT JOIN مع سجل الظهور: منشور لم يظهر قط لا يُسقط، ولا استبعاد نهائي لأي
--     محتوى، فالدرجات الثلاث للتوسع ترتيب لا فلترة.
--   * الظهور لا يمنح أي نقاط إيجابية ولا يُعدّ إعجابًا؛ التدوير ترتيب فقط.
--   * لا تكرار: المحرك يُعيد صفًا واحدًا لكل post_id، والطبقة الجديدة 1:1 معه
--     عبر LEFT JOIN مع سجل ظهور مجمّع بـ group by post_id.
--   * SECURITY INVOKER في الطبقتين، فلا تجاوز لسياسات القراءة أو الخصوصية أو
--     الحظر: كل الصفوف تأتي من المحرك نفسه بعد RLS.
--   * get_personalized_feed لا يُمسّ إطلاقًا.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0) شروط مسبقة: يفشل الترحيل برسالة واضحة إن تغيّرت أي افتراضات
-- ---------------------------------------------------------------------
do $$
declare
  v_function oid := to_regprocedure('public.get_personalized_reels(integer,integer)');
  v_relevance oid := to_regprocedure('public.aani_get_personalized_reels_relevance(integer,integer)');
  v_required_columns text[] := array['user_id', 'post_id', 'surface', 'impression_at'];
  v_column text;
  v_is_security_invoker boolean;
  v_settings text[];
  v_showable boolean;
  v_definition text;
begin
  if v_function is null then
    raise exception 'public.get_personalized_reels(integer, integer) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  if v_relevance is not null then
    raise exception 'aani_get_personalized_reels_relevance موجودة سابقًا؛ يبدو أن هذا الترحيل طُبّق من قبل. أوقف الترحيل.'
      using errcode = '42723';
  end if;

  if to_regclass('public.post_impressions') is null then
    raise exception 'public.post_impressions غير موجود. أوقف الترحيل.'
      using errcode = '42P01';
  end if;

  if to_regclass('public.posts') is null then
    raise exception 'public.posts غير موجود. أوقف الترحيل.'
      using errcode = '42P01';
  end if;

  foreach v_column in array v_required_columns
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.post_impressions'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception 'العمود public.post_impressions.% غير موجود. أوقف الترحيل.', v_column
        using errcode = '42703';
    end if;
  end loop;

  -- سطح 'reels' مسموح في قيد الجدول؛ بدونه لا معنى لهذا الترحيل.
  select exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.post_impressions'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) ilike '%surface%'
      and pg_get_constraintdef(constraint_row.oid) ilike '%reels%'
  ) into v_showable;

  if not v_showable then
    raise exception 'قيد surface على public.post_impressions لا يسمح بـ ''reels''. أوقف الترحيل.'
      using errcode = '23514';
  end if;

  -- المحرك الحالي يجب أن يكون SECURITY INVOKER وبـ search_path فارغ قبل تغليفه.
  select not proc.prosecdef, proc.proconfig
  into v_is_security_invoker, v_settings
  from pg_catalog.pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_is_security_invoker, false) then
    raise exception 'get_personalized_reels ليست SECURITY INVOKER؛ لا يُغلَّف محرك يتجاوز RLS. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_settings is null
     or not exists (
       select 1
       from unnest(v_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'get_personalized_reels لا تضبط search_path فارغًا. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  -- الافتراض الأساسي: المحرك المتوقع هو V2-B بقصّ على v_limit. إن كان الجسم
  -- مختلفًا فهذا محرك غير معروف، فلا نلمسه.
  v_definition := pg_get_functiondef(v_function);
  if position('v_limit' in v_definition) = 0
     or position('final_ranking.rank_position' in v_definition) = 0 then
    raise exception 'جسم get_personalized_reels لا يطابق محرك V2-B المتوقع (v_limit / final_ranking). أوقف الترحيل.'
      using errcode = '42804';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) إعادة تسمية المحرك المنشور؛ تُحفظ الصلاحيات و search_path و
--    SECURITY INVOKER مع الكائن نفسه.
-- ---------------------------------------------------------------------
alter function public.get_personalized_reels(integer, integer)
  rename to aani_get_personalized_reels_relevance;

-- ---------------------------------------------------------------------
-- 2) المحرك الداخلي: نفس الجسم والنقاط والإشارات والتنويع، مع تغيير واحد:
--    سقف مجموع المرشحين صار p_candidate_limit (200 كحد أقصى) بدل 40،
--    والقصّ النهائي على v_candidates بدل v_limit، فيصل كامل المرشحين إلى
--    طبقة التدوير بدل أول 40 فقط.
-- ---------------------------------------------------------------------
create or replace function public.aani_get_personalized_reels_relevance(
  p_limit integer default 20,
  p_candidate_limit integer default 100
)
returns table (
  post_id uuid,
  reposter_id uuid,
  reposted_at timestamptz,
  rank_position integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
  -- الحد المطلوب عرضًا (يبقى حدًّا أدنى لعدد المرشحين فقط).
  v_requested_limit integer := least(greatest(coalesce(p_limit, 20), 1), 40);
  -- سقف مجموعة المرشحين كاملة: p_candidate_limit بحد أقصى 200.
  v_candidates integer := least(
    greatest(coalesce(p_candidate_limit, 100), coalesce(p_limit, 20), 1),
    200
  );
  v_quota_follow integer;
  v_quota_discovery integer;
  v_quota_reposts integer;
  v_bound_follow integer;
  v_bound_discovery integer;
  v_bound_reposts integer;
begin
  if v_viewer is null then
    return;
  end if;
  v_candidates := greatest(v_candidates, v_requested_limit);
  -- حصص مستقلة عن محرك الرئيسية: 40% متابعات، 40% اكتشاف، والباقي
  -- إعادات نشر. كل حصة تُقصّ على السقف المتبقي، فلا يتجاوز المجموع الحد.
  v_quota_follow := least(
    v_candidates,
    greatest(1, ceil(v_candidates::numeric * 0.40)::integer)
  );
  v_quota_discovery := least(
    v_candidates - v_quota_follow,
    greatest(0, ceil(v_candidates::numeric * 0.40)::integer)
  );
  v_quota_reposts := v_candidates - v_quota_follow - v_quota_discovery;
  v_bound_follow := least(300, greatest(v_quota_follow * 3, v_quota_follow + 20));
  v_bound_discovery := least(300, greatest(v_quota_discovery * 3, v_quota_discovery + 20));
  v_bound_reposts := least(300, greatest(v_quota_reposts * 3, v_quota_reposts + 20));
  return query
  with followed_authors as (
    select relation.following_id as author_id
    from public.follows as relation
    where relation.follower_id = v_viewer
  ),
  -- ---------------------------------------------------------------
  -- 1) المرشحون: نفس تعريف الريل في واجهة التطبيق:
  --    type = 'reel' أو destination = 'reels'.
  --    كل قراءة من posts/reposts تخضع إلى RLS بسبب SECURITY INVOKER.
  -- ---------------------------------------------------------------
  follow_slice as (
    select
      post.id as post_id,
      post.created_at as post_created_at,
      post.created_at as candidate_at,
      post.user_id as author_id,
      post.sound_id as sound_id,
      coalesce(post.likes_count, 0) as likes_count,
      coalesce(post.comments_count, 0) as comments_count,
      coalesce(post.reposts_count, 0) as reposts_count,
      coalesce(post.shares_count, 0) as shares_count,
      case
        when post.type = 'photo'
          or coalesce(post.media_url, post.media_urls[1], '') ~* '[.](jpe?g|png|webp|gif|avif)([?#]|$)'
          then 'image'
        else 'video'
      end as media_kind
    from public.posts as post
    join followed_authors as followed on followed.author_id = post.user_id
    where post.created_at >= now() - interval '30 days'
      and (post.type = 'reel' or post.destination = 'reels')
    order by post.created_at desc, post.id asc
    limit v_bound_follow
  ),
  discovery_slice as (
    select
      post.id as post_id,
      post.created_at as post_created_at,
      post.created_at as candidate_at,
      post.user_id as author_id,
      post.sound_id as sound_id,
      coalesce(post.likes_count, 0) as likes_count,
      coalesce(post.comments_count, 0) as comments_count,
      coalesce(post.reposts_count, 0) as reposts_count,
      coalesce(post.shares_count, 0) as shares_count,
      case
        when post.type = 'photo'
          or coalesce(post.media_url, post.media_urls[1], '') ~* '[.](jpe?g|png|webp|gif|avif)([?#]|$)'
          then 'image'
        else 'video'
      end as media_kind
    from public.posts as post
    join public.profiles as owner on owner.id = post.user_id
    where coalesce(post.visibility, 'public') <> 'private'
      and owner.is_private = false
      and owner.is_deactivated = false
      and post.created_at >= now() - interval '14 days'
      and (post.type = 'reel' or post.destination = 'reels')
      and not exists (
        select 1
        from followed_authors as followed
        where followed.author_id = post.user_id
      )
    order by post.created_at desc, post.id asc
    limit v_bound_discovery
  ),
  repost_slice as (
    select
      latest.post_id,
      latest.post_created_at,
      latest.reposted_at as candidate_at,
      latest.author_id,
      latest.sound_id,
      latest.likes_count,
      latest.comments_count,
      latest.reposts_count,
      latest.shares_count,
      latest.media_kind
    from (
      select
        repost.post_id,
        post.created_at as post_created_at,
        repost.created_at as reposted_at,
        post.user_id as author_id,
        post.sound_id as sound_id,
        coalesce(post.likes_count, 0) as likes_count,
        coalesce(post.comments_count, 0) as comments_count,
        coalesce(post.reposts_count, 0) as reposts_count,
        coalesce(post.shares_count, 0) as shares_count,
        case
          when post.type = 'photo'
            or coalesce(post.media_url, post.media_urls[1], '') ~* '[.](jpe?g|png|webp|gif|avif)([?#]|$)'
            then 'image'
          else 'video'
        end as media_kind,
        row_number() over (
          partition by repost.post_id
          order by repost.created_at desc, repost.user_id asc, repost.post_id asc
        ) as repost_position
      from public.reposts as repost
      join public.posts as post on post.id = repost.post_id
      where repost.created_at >= now() - interval '30 days'
        -- إعادة نشر المستخدم الحالي فقط: aani_reposts_select_own هي سياسة
        -- SELECT المتساهلة الوحيدة على reposts، فلا تُقرأ إعادات الآخرين.
        and repost.user_id = v_viewer
        and (post.type = 'reel' or post.destination = 'reels')
        and not (
          post.created_at >= now() - interval '30 days'
          and exists (
            select 1 from followed_authors as followed
            where followed.author_id = post.user_id
          )
        )
        and not (
          post.created_at >= now() - interval '14 days'
          and coalesce(post.visibility, 'public') <> 'private'
          and exists (
            select 1 from public.profiles as owner
            where owner.id = post.user_id
              and owner.is_private = false
              and owner.is_deactivated = false
          )
          and not exists (
            select 1 from followed_authors as followed
            where followed.author_id = post.user_id
          )
        )
    ) as latest
    where latest.repost_position = 1
    order by latest.reposted_at desc, latest.post_id asc
    limit v_bound_reposts
  ),
  raw_candidates as (
    select 1 as source_rank, follow_slice.* from follow_slice
    union all
    select 2 as source_rank, discovery_slice.* from discovery_slice
    union all
    select 3 as source_rank, repost_slice.* from repost_slice
  ),
  -- شبكة أمان تمنع تكرار post_id بين المصادر؛ الأولوية للمتابعات
  -- ثم الاكتشاف ثم إعادة النشر. tie-breakers ثابتة.
  assigned as (
    select
      candidate.*,
      row_number() over (
        partition by candidate.post_id
        order by candidate.source_rank asc, candidate.candidate_at desc,
                 candidate.post_id asc
      ) as assignment_position
    from raw_candidates as candidate
  ),
  one_per_post as (
    select
      assigned.post_id,
      assigned.source_rank,
      assigned.post_created_at,
      assigned.candidate_at,
      assigned.author_id,
      assigned.sound_id,
      assigned.likes_count,
      assigned.comments_count,
      assigned.reposts_count,
      assigned.shares_count,
      assigned.media_kind,
      exists (
        select 1 from followed_authors as followed
        where followed.author_id = assigned.author_id
      ) as from_follow
    from assigned
    where assigned.assignment_position = 1
  ),
  quota_ranked as (
    select
      candidate.*,
      row_number() over (
        partition by candidate.source_rank
        order by candidate.candidate_at desc, candidate.post_id asc
      ) as source_position
    from one_per_post as candidate
  ),
  quota_selected as (
    select *
    from quota_ranked
    where source_position <= case source_rank
      when 1 then v_quota_follow
      when 2 then v_quota_discovery
      else v_quota_reposts
    end
  ),
  quota_overflow as (
    select
      candidate.*,
      row_number() over (
        order by candidate.source_rank asc, candidate.candidate_at desc,
                 candidate.post_id asc
      ) as overflow_position
    from quota_ranked as candidate
    where not exists (
      select 1 from quota_selected as selected
      where selected.post_id = candidate.post_id
    )
  ),
  candidates as (
    select
      selected.post_id, selected.source_rank, selected.post_created_at,
      selected.candidate_at, selected.author_id, selected.sound_id,
      selected.from_follow, selected.likes_count, selected.comments_count,
      selected.reposts_count, selected.shares_count, selected.media_kind
    from quota_selected as selected
    union all
    select
      overflow.post_id, overflow.source_rank, overflow.post_created_at,
      overflow.candidate_at, overflow.author_id, overflow.sound_id,
      overflow.from_follow, overflow.likes_count, overflow.comments_count,
      overflow.reposts_count, overflow.shares_count, overflow.media_kind
    from quota_overflow as overflow
    where overflow.overflow_position <= greatest(
      0, v_candidates - (select count(*)::integer from quota_selected)
    )
  ),
  -- ---------------------------------------------------------------
  -- 2) الإشارات العامة على المرشح: مجمّعة مسبقاً إلى صف واحد لكل post_id،
  --    ومقروءة تحت RLS. LEFT JOIN لاحقاً يمنع إسقاط المرشح عند غياب أي سجل،
  --    وغياب إشارة المشاهدة يبقى صفراً محايداً لا عقوبة.
  -- ---------------------------------------------------------------
  signal_impressions as (
    select impression.post_id, count(*)::integer as impression_count
    from public.post_impressions as impression
    where impression.user_id = v_viewer
      and impression.surface = 'reels'
      and impression.post_id in (select candidate.post_id from candidates as candidate)
      and impression.impression_at >= now() - interval '7 days'
    group by impression.post_id
  ),
  signal_video_views as (
    select
      view_event.post_id,
      count(*)::integer as view_count,
      count(view_event.completion_ratio)::integer as completion_known_count,
      avg(view_event.completion_ratio)::numeric as avg_completion,
      avg(view_event.played_duration_ms)::numeric as avg_played_ms,
      count(*) filter (where view_event.early_skip)::integer as early_skip_count,
      coalesce(sum(view_event.replay_count), 0)::bigint as replay_total
    from public.post_view_events as view_event
    where view_event.user_id = v_viewer
      and view_event.surface = 'reels'
      and view_event.content_type = 'video'
      and view_event.post_id in (select candidate.post_id from candidates as candidate)
      and view_event.event_at >= now() - interval '14 days'
    group by view_event.post_id
  ),
  signal_image_views as (
    select
      view_event.post_id,
      count(*)::integer as view_count,
      avg(view_event.visible_duration_ms)::numeric as avg_visible_ms
    from public.post_view_events as view_event
    where view_event.user_id = v_viewer
      and view_event.surface = 'reels'
      and view_event.content_type = 'image'
      and view_event.post_id in (select candidate.post_id from candidates as candidate)
      and view_event.event_at >= now() - interval '14 days'
    group by view_event.post_id
  ),
  signal_feedback as (
    select
      feedback.post_id,
      bool_or(feedback.feedback = 'interested') as interested,
      bool_or(feedback.feedback = 'not_interested') as not_interested
    from public.post_feedback as feedback
    where feedback.user_id = v_viewer
      and feedback.post_id in (select candidate.post_id from candidates as candidate)
    group by feedback.post_id
  ),
  -- أحدث إسناد إعادة نشر **للمستخدم الحالي** لكل منشور مرشح.
  repost_latest as (
    select ranked.post_id, ranked.reposter_id, ranked.reposted_at
    from (
      select
        repost.post_id,
        repost.user_id as reposter_id,
        repost.created_at as reposted_at,
        row_number() over (
          partition by repost.post_id
          order by repost.created_at desc, repost.user_id asc, repost.post_id asc
        ) as repost_position
      from public.reposts as repost
      where repost.user_id = v_viewer
        and repost.post_id in (select candidate.post_id from candidates as candidate)
    ) as ranked
    where ranked.repost_position = 1
  ),
  -- ---------------------------------------------------------------
  -- 3) V2-B: كبح التكرار — أحدث تفاعل شخصي لكل منشور مرشح.
  --    المصادر الخمسة كلها مقيدة بـ user_id = v_viewer وتحت RLS.
  --    النافذة 72 ساعة فقط لأن الخصم يصبح صفراً بعدها.
  -- ---------------------------------------------------------------
  interaction_times as (
    select
      activity.post_id,
      max(activity.interacted_at) as last_interaction_at
    from (
      select view_event.post_id, view_event.event_at as interacted_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.event_at >= now() - interval '72 hours'
      union all
      select interaction.post_id, interaction.created_at
      from public.likes as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '72 hours'
      union all
      select interaction.post_id, interaction.created_at
      from public.bookmarks as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '72 hours'
      union all
      select interaction.post_id, interaction.created_at
      from public.post_shares as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '72 hours'
      union all
      select interaction.post_id, interaction.created_at
      from public.reposts as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '72 hours'
    ) as activity
    group by activity.post_id
  ),
  -- V2-B (1-ب): إشارة مستقلة «هل سبق للمستخدم مشاهدة هذا المنشور أو التفاعل
  -- معه؟» بلا نافذة زمنية، منفصلة تماماً عن interaction_times ذات الـ72 ساعة.
  prior_interactions as (
    select distinct activity.post_id
    from (
      select view_event.post_id
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.post_id in (select candidate.post_id from candidates as candidate)
      union
      select interaction.post_id
      from public.likes as interaction
      where interaction.user_id = v_viewer
        and interaction.post_id in (select candidate.post_id from candidates as candidate)
      union
      select interaction.post_id
      from public.bookmarks as interaction
      where interaction.user_id = v_viewer
        and interaction.post_id in (select candidate.post_id from candidates as candidate)
      union
      select interaction.post_id
      from public.post_shares as interaction
      where interaction.user_id = v_viewer
        and interaction.post_id in (select candidate.post_id from candidates as candidate)
      union
      select interaction.post_id
      from public.reposts as interaction
      where interaction.user_id = v_viewer
        and interaction.post_id in (select candidate.post_id from candidates as candidate)
      union
      select feedback.post_id
      from public.post_feedback as feedback
      where feedback.user_id = v_viewer
        and feedback.post_id in (select candidate.post_id from candidates as candidate)
    ) as activity
  ),
  -- ---------------------------------------------------------------
  -- 4) V2-B: إشارات الذوق — كل سجل شخصي للمستخدم مع وزنه، مربوطاً بجدول
  --    posts لاستخراج صاحب الحساب (user_id) والصوت (sound_id).
  --    join داخلي: أي سجل لا يُقرأ بسبب RLS يُهمل، بلا تجاوز للسياسة.
  --    التناقص الزمني بنصف عمر 7 أيام: weight * 0.5^(age_days / 7).
  -- ---------------------------------------------------------------
  taste_signals as (
    select
      signal.post_id as source_post_id,
      post.user_id as author_id,
      post.sound_id as sound_id,
      signal.weight * power(
        0.5::numeric,
        greatest(
          extract(epoch from (now() - signal.signal_at))::numeric / 86400.0,
          0::numeric
        ) / 7.0::numeric
      ) as decayed_weight
    from (
      select
        0.30::numeric as weight,
        interaction.user_id,
        interaction.post_id,
        interaction.created_at as signal_at
      from public.likes as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      select 0.45::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.bookmarks as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      select 0.35::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.post_shares as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      select 0.40::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.reposts as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      select 0.15::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.content_type = 'video'
        and view_event.completion_ratio is not null
        and view_event.completion_ratio >= 0.90
        and view_event.event_at >= now() - interval '60 days'
      union all
      select 0.10::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and coalesce(view_event.replay_count, 0) > 0
        and view_event.event_at >= now() - interval '60 days'
      union all
      select (-0.25)::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.early_skip
        and view_event.event_at >= now() - interval '60 days'
      union all
      select
        (-0.60)::numeric,
        feedback.user_id,
        feedback.post_id,
        coalesce(feedback.updated_at, feedback.created_at)
      from public.post_feedback as feedback
      where feedback.user_id = v_viewer
        and feedback.feedback = 'not_interested'
        and coalesce(feedback.updated_at, feedback.created_at) >= now() - interval '60 days'
    ) as signal
    join public.posts as post on post.id = signal.post_id
  ),
  -- ربط الاهتمام بصاحب الحساب: يُستبعد المنشور المصدر نفسه صراحةً حتى لا
  -- يرفع نقاط المنشور الذي تفاعل معه المستخدم.
  author_affinity as (
    select
      candidate.post_id,
      sum(signal.decayed_weight) as affinity
    from candidates as candidate
    join taste_signals as signal
      on signal.author_id = candidate.author_id
     and signal.source_post_id <> candidate.post_id
    group by candidate.post_id
  ),
  -- ربط الاهتمام بالصوت نفسه، بالاستبعاد نفسه، وفقط للأصوات غير الفارغة.
  sound_affinity as (
    select
      candidate.post_id,
      sum(signal.decayed_weight) as affinity
    from candidates as candidate
    join taste_signals as signal
      on candidate.sound_id is not null
     and signal.sound_id = candidate.sound_id
     and signal.source_post_id <> candidate.post_id
    group by candidate.post_id
  ),
  scored as (
    select
      candidate.post_id,
      candidate.author_id,
      candidate.sound_id,
      candidate.post_created_at,
      candidate.from_follow,
      candidate.media_kind,
      coalesce(impressions.impression_count, 0) as impression_count,
      coalesce(video_views.view_count, 0) as video_view_count,
      video_views.completion_known_count,
      video_views.avg_completion,
      video_views.avg_played_ms,
      video_views.early_skip_count,
      video_views.replay_total,
      coalesce(image_views.view_count, 0) as image_view_count,
      image_views.avg_visible_ms,
      coalesce(feedback.interested, false) as interested,
      coalesce(feedback.not_interested, false) as not_interested,
      coalesce(candidate.likes_count, 0) as likes_count,
      coalesce(candidate.comments_count, 0) as comments_count,
      coalesce(candidate.reposts_count, 0) as reposts_count,
      coalesce(candidate.shares_count, 0) as shares_count,
      interaction_times.last_interaction_at,
      (prior_interactions.post_id is not null) as has_prior_interaction,
      coalesce(author_affinity.affinity, 0) as author_affinity,
      coalesce(sound_affinity.affinity, 0) as sound_affinity,
      1.0::numeric / (
        1.0::numeric + greatest(
          extract(epoch from (now() - candidate.candidate_at))::numeric / 3600.0,
          0::numeric
        ) / 48.0::numeric
      ) as recency_score,
      ln(
        1::numeric
        + greatest(coalesce(candidate.likes_count, 0), 0)::numeric
        + 2::numeric * greatest(coalesce(candidate.comments_count, 0), 0)::numeric
        + 2::numeric * greatest(coalesce(candidate.reposts_count, 0), 0)::numeric
        + 2::numeric * greatest(coalesce(candidate.shares_count, 0), 0)::numeric
      ) as engagement_raw
    from candidates as candidate
    left join signal_impressions as impressions on impressions.post_id = candidate.post_id
    left join signal_video_views as video_views on video_views.post_id = candidate.post_id
    left join signal_image_views as image_views on image_views.post_id = candidate.post_id
    left join signal_feedback as feedback on feedback.post_id = candidate.post_id
    left join interaction_times on interaction_times.post_id = candidate.post_id
    left join prior_interactions on prior_interactions.post_id = candidate.post_id
    left join author_affinity on author_affinity.post_id = candidate.post_id
    left join sound_affinity on sound_affinity.post_id = candidate.post_id
  ),
  weighted as (
    select
      scored.post_id,
      scored.author_id,
      scored.post_created_at,
      (
        scored.recency_score
        + case when scored.from_follow then 0.30::numeric else 0::numeric end
        + case when scored.not_interested then -1.00::numeric else 0::numeric end
        + least(0.15::numeric, scored.engagement_raw * 0.02::numeric)
        + case
            when scored.media_kind = 'video'
             and coalesce(scored.completion_known_count, 0) > 0
             and scored.avg_completion is not null
              then (scored.avg_completion - 0.5::numeric) * 0.12::numeric
            else 0::numeric
          end
        + case
            when scored.media_kind = 'video'
             and coalesce(scored.replay_total, 0) > 0
              then 0.05::numeric
            else 0::numeric
          end
        + case
            when scored.media_kind = 'video'
             and coalesce(scored.avg_played_ms, 0) > 0
              then least(0.08::numeric, ln(1::numeric + scored.avg_played_ms / 1000.0) * 0.02::numeric)
            else 0::numeric
          end
        - case
            when scored.media_kind = 'video'
             and coalesce(scored.video_view_count, 0) > 0
              then least(
                0.08::numeric,
                (coalesce(scored.early_skip_count, 0)::numeric
                  / scored.video_view_count::numeric) * 0.08::numeric
              )
            else 0::numeric
          end
        + case
            when scored.media_kind = 'image'
             and coalesce(scored.image_view_count, 0) > 0
             and scored.avg_visible_ms is not null
              then least(0.08::numeric, ln(1::numeric + greatest(scored.avg_visible_ms, 0) / 1000.0) * 0.02::numeric)
            else 0::numeric
          end
        - case
            when scored.impression_count > 0
              then least(0.10::numeric, ln(1::numeric + scored.impression_count::numeric) * 0.02::numeric)
            else 0::numeric
          end
        - case
            when scored.last_interaction_at is null then 0::numeric
            when extract(epoch from (now() - scored.last_interaction_at))::numeric / 3600.0 <= 6.0
              then 0.90::numeric
            when extract(epoch from (now() - scored.last_interaction_at))::numeric / 3600.0 < 72.0
              then 0.90::numeric * (
                72.0::numeric
                - extract(epoch from (now() - scored.last_interaction_at))::numeric / 3600.0
              ) / 66.0::numeric
            else 0::numeric
          end
        + case
            when not scored.has_prior_interaction
              then least(0.30::numeric, greatest(0::numeric, scored.author_affinity * 0.35::numeric))
            else 0::numeric
          end
        + case
            when not scored.has_prior_interaction
              then least(0.20::numeric, greatest(0::numeric, scored.sound_affinity * 0.30::numeric))
            else 0::numeric
          end
        + greatest(-0.30::numeric, least(0::numeric, scored.author_affinity * 0.35::numeric))
        + greatest(-0.20::numeric, least(0::numeric, scored.sound_affinity * 0.30::numeric))
      )::numeric as base_score
    from scored
  ),
  author_ranked as (
    select
      weighted.*,
      row_number() over (
        partition by weighted.author_id
        order by weighted.base_score desc, weighted.post_created_at desc,
                 weighted.post_id asc
      ) as author_position
    from weighted
  ),
  diversified as (
    select
      author_ranked.post_id,
      author_ranked.author_id,
      author_ranked.post_created_at,
      author_ranked.author_position,
      (
        author_ranked.base_score
        - least(0.20::numeric, 0.04::numeric * (author_ranked.author_position - 1)::numeric)
      )::numeric as final_score
    from author_ranked
  ),
  -- V2-B (3): ترتيب متناوب: أول منشور من كل صاحب حساب، ثم الثاني، ثم الثالث...
  -- ولا يُسقَط أي مرشح؛ إن كان صاحب واحد فقط تبقى قائمته كاملة.
  final_ranking as (
    select
      diversified.post_id,
      row_number() over (
        order by diversified.author_position asc,
                 diversified.final_score desc,
                 diversified.post_created_at desc,
                 diversified.post_id asc
      )::integer as rank_position
    from diversified
  )
  select
    final_ranking.post_id,
    repost_latest.reposter_id,
    repost_latest.reposted_at,
    final_ranking.rank_position
  from final_ranking
  left join repost_latest on repost_latest.post_id = final_ranking.post_id
  -- القصّ على كامل مجموعة المرشحين (حتى 200) لا على حد العرض. طبقة التدوير
  -- هي التي تختار أول p_limit بعد تطبيق أولوية الظهور.
  where final_ranking.rank_position <= v_candidates
  order by final_ranking.rank_position asc;
end;
$$;

-- ---------------------------------------------------------------------
-- 3) طبقة التدوير: نفس التوقيع ونفس أعمدة الإرجاع تمامًا.
--    تقرأ كامل المرشحين من المحرك الداخلي، ترتّب بالظهور، ثم تُعيد أول p_limit.
-- ---------------------------------------------------------------------
create or replace function public.get_personalized_reels(
  p_limit integer default 20,
  p_candidate_limit integer default 100
)
returns table (
  post_id uuid,
  reposter_id uuid,
  reposted_at timestamptz,
  rank_position integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with relevance as (
    -- كامل مجموعة المرشحين من المحرك (حتى 200) بترتيب التوصيات والتنويع.
    -- صف واحد لكل post_id (rank_position من row_number داخل المحرك).
    select
      ranked.post_id,
      ranked.reposter_id,
      ranked.reposted_at,
      ranked.rank_position as relevance_rank
    from public.aani_get_personalized_reels_relevance(p_limit, p_candidate_limit) as ranked
  ),
  reel_impression_history as (
    -- سجل الظهور في الريلز فقط. ظهور الـFeed لا يُحسب هنا.
    -- المجموعة 1:1 مع post_id، فلا تُنشئ صفوفًا إضافية عند الربط.
    select
      impression.post_id,
      max(impression.impression_at) as last_reel_impression_at,
      count(*)::integer as reel_impression_count
    from public.post_impressions as impression
    where impression.user_id = auth.uid()
      and impression.surface = 'reels'
      and impression.post_id in (select relevance.post_id from relevance)
    group by impression.post_id
  ),
  rotation_inputs as (
    select
      relevance.post_id,
      relevance.reposter_id,
      relevance.reposted_at,
      relevance.relevance_rank,
      history.last_reel_impression_at,
      coalesce(history.reel_impression_count, 0) as reel_impression_count,
      -- درجات التوسع الثلاث: 0 = لم يظهر قط، 1 = ظهر قبل أكثر من 7 أيام،
      -- 2 = ظهر قبل أكثر من 24 ساعة، 3 = ظهر خلال آخر 24 ساعة.
      case
        when history.last_reel_impression_at is null then 0
        when history.last_reel_impression_at < now() - interval '7 days' then 1
        when history.last_reel_impression_at < now() - interval '24 hours' then 2
        else 3
      end as impression_priority
    from relevance
    -- LEFT JOIN مقصود: منشور لم يظهر سابقًا لا يملك صفًا في السجل ويجب أن يبقى.
    left join reel_impression_history as history on history.post_id = relevance.post_id
  ),
  rotated as (
    select
      rotation_inputs.*,
      row_number() over (
        order by
          rotation_inputs.impression_priority asc,
          rotation_inputs.last_reel_impression_at asc nulls first,
          -- داخل الدرجة نفسها يبقى ترتيب المحرك هو الفاصل، فيُحفظ التنويع
          -- بين المؤلفين والأصوات. الظهور لا يغيّر أي نقاط ولا يلغي أي إشارة.
          rotation_inputs.relevance_rank asc,
          rotation_inputs.post_id asc
      )::integer as rotation_rank
    from rotation_inputs
  )
  select
    rotated.post_id,
    rotated.reposter_id,
    rotated.reposted_at,
    rotated.rotation_rank as rank_position
  from rotated
  where rotated.rotation_rank <= least(greatest(coalesce(p_limit, 20), 1), 40)
  order by rotated.rotation_rank asc;
$$;

-- ---------------------------------------------------------------------
-- 4) الصلاحيات: الطبقتان لـ authenticated فقط، بلا PUBLIC ولا anon ولا تجاوز.
-- ---------------------------------------------------------------------
revoke all on function public.get_personalized_reels(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_personalized_reels(integer, integer)
  to authenticated;

revoke all on function public.aani_get_personalized_reels_relevance(integer, integer)
  from public, anon, service_role;
grant execute on function public.aani_get_personalized_reels_relevance(integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5) تحقق بعد التعديل
-- ---------------------------------------------------------------------
do $$
declare
  v_wrapper oid := to_regprocedure('public.get_personalized_reels(integer,integer)');
  v_relevance oid := to_regprocedure('public.aani_get_personalized_reels_relevance(integer,integer)');
  v_wrapper_definer boolean;
  v_wrapper_settings text[];
  v_relevance_definer boolean;
  v_relevance_settings text[];
  v_wrapper_definition text;
  v_relevance_definition text;
  v_public_or_anon_execute boolean;
  v_authenticated_execute_count integer;
begin
  if v_wrapper is null or v_relevance is null then
    raise exception 'إحدى دالتي الريلز غائبة بعد الترحيل. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  select proc.prosecdef, proc.proconfig
  into v_wrapper_definer, v_wrapper_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_wrapper;

  select proc.prosecdef, proc.proconfig
  into v_relevance_definer, v_relevance_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_relevance;

  if v_wrapper_definer or v_relevance_definer then
    raise exception 'إحدى دالتي الريلز صارت SECURITY DEFINER. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_wrapper_settings is null
     or not exists (
       select 1 from unnest(v_wrapper_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'get_personalized_reels لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  if v_relevance_settings is null
     or not exists (
       select 1 from unnest(v_relevance_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'aani_get_personalized_reels_relevance لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  v_relevance_definition := pg_get_functiondef(v_relevance);
  -- المحرك الداخلي يجب أن يقصّ على v_candidates (كامل المرشحين) لا على v_limit،
  -- وأن يضبط السقف من p_candidate_limit بحد أقصى 200.
  if position('final_ranking.rank_position <= v_candidates' in v_relevance_definition) = 0 then
    raise exception 'المحرك الداخلي لا يقصّ على v_candidates؛ قد يعود إلى سقف 40.'
      using errcode = '42501';
  end if;

  if position('final_ranking.rank_position <= v_limit' in v_relevance_definition) > 0 then
    raise exception 'المحرك الداخلي ما زال يقصّ على v_limit. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if position('coalesce(p_candidate_limit, 100)' in v_relevance_definition) = 0 then
    raise exception 'سقف المرشحين في المحرك الداخلي لا يستند إلى p_candidate_limit.'
      using errcode = '42501';
  end if;

  -- الطبقة الجديدة تقرأ سجل الظهور بالريلز فقط.
  v_wrapper_definition := pg_get_functiondef(v_wrapper);
  if position('post_impressions' in v_wrapper_definition) = 0
     or position('''reels''' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تقرأ post_impressions بـ surface = ''reels''.'
      using errcode = '42501';
  end if;

  if position('aani_get_personalized_reels_relevance' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تستدعي محرك التوصيات الأصلي.'
      using errcode = '42501';
  end if;

  if position('rotation_inputs.relevance_rank asc' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تحفظ ترتيب المحرك داخل درجات الظهور.'
      using errcode = '42501';
  end if;

  -- لا EXECUTE لـ PUBLIC أو anon على أي من الطبقتين.
  select exists (
    select 1
    from pg_catalog.pg_proc as proc,
         aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
    where proc.oid in (v_wrapper, v_relevance)
      and acl.privilege_type = 'EXECUTE'
      and acl.grantee in (
        0,
        (select role.oid from pg_catalog.pg_roles as role where role.rolname = 'anon')
      )
  ) into v_public_or_anon_execute;

  if v_public_or_anon_execute then
    raise exception 'إحدى دالتي الريلز ممنوحة لـ PUBLIC أو anon. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  select count(distinct proc.oid)
  into v_authenticated_execute_count
  from pg_catalog.pg_proc as proc,
       aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as acl
  where proc.oid in (v_wrapper, v_relevance)
    and acl.privilege_type = 'EXECUTE'
    and acl.grantee = (
      select role.oid from pg_catalog.pg_roles as role where role.rolname = 'authenticated'
    );

  if v_authenticated_execute_count <> 2 then
    raise exception 'authenticated لا تملك EXECUTE على دالتي الريلز (% من 2).', v_authenticated_execute_count
      using errcode = '42501';
  end if;

  if to_regprocedure('public.get_personalized_feed(integer,integer)') is null then
    raise notice 'get_personalized_feed(integer, integer) غير موجودة في هذه القاعدة، ولم يُمَس أي شيء يخصّها.';
  else
    raise notice 'get_personalized_feed لم تُمسّ بهذا الترحيل.';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- =====================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط، لا يُنفَّذ هنا):
--
-- 1) المحرك الداخلي يُعيد كامل المرشحين (حتى 200) لا 40:
-- select count(*) from public.aani_get_personalized_reels_relevance(40, 200);
--
-- 2) طبقة التدوير تُعيد 40 على الأكثر:
-- select count(*) from public.get_personalized_reels(40, 200);
--
-- 3) لا تكرار داخل النتيجة الواحدة:
-- select post_id, count(*) from public.get_personalized_reels(40, 200)
-- group by post_id having count(*) > 1;
--
-- 4) أثر التدوير: آخر ظهور لكل صف في النتيجة النهائية:
-- select r.rank_position, r.post_id, i.last_reel_impression_at
-- from public.get_personalized_reels(40, 200) as r
-- left join (
--   select post_id, max(impression_at) as last_reel_impression_at
--   from public.post_impressions
--   where user_id = auth.uid() and surface = 'reels'
--   group by post_id
-- ) as i on i.post_id = r.post_id
-- order by r.rank_position;
-- =====================================================================
