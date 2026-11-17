-- =====================================================================
-- Aani Reels Ranking Engine — المرحلة V2-B
-- public.get_personalized_reels(p_limit, p_candidate_limit)
--
-- حالة الملف: مسودة مراجعة فقط.
-- لم يُطبَّق على Supabase أو Production، ولا يُنفَّذ ضمن إعداد هذا الملف.
--
-- نطاق V2-B (ثلاث إضافات فوق 20270211000000):
--   1) كبح تكرار ذكي (Cooldown / Demotion) لآخر تفاعل شخصي للمستخدم مع
--      المنشور نفسه: مشاهدة، إعجاب، حفظ، مشاركة، إعادة نشر.
--   2) نقل الاهتمام (Taste Transfer) من المنشورات التي تفاعل معها المستخدم
--      إلى **منشورات أخرى** لصاحب الحساب نفسه أو تستخدم الصوت نفسه.
--   3) تنويع: ترتيب متناوب حسب ترتيب المنشور داخل مجموعة صاحبه (الأول من كل
--      صاحب، ثم الثاني، ثم الثالث...) بدل تتابع نفس الصاحب في القمة.
--
-- ما لا يتغيّر في هذا الملف:
--   * التوقيع نفسه: (p_limit integer, p_candidate_limit integer).
--   * أعمدة الإرجاع نفسها: post_id, reposter_id, reposted_at, rank_position.
--   * مصادر المرشحين وحصص المتابعات والاكتشاف وإعادة النشر، وإزالة تكرار post_id.
--   * إسناد إعادة النشر للمستخدم الحالي وحده.
--   * الفصل بين إشارات الصور والفيديو، وعدم معاقبة غياب إشارة المشاهدة.
--   * SECURITY INVOKER و search_path = '' ولا SECURITY DEFINER ولا صلاحيات جديدة.
--   * لا يمسّ get_personalized_feed ولا محرك الرئيسية.
--
-- ما أُزيل من V1 عن قصد: النقاط المباشرة للإعجاب (0.08) والحفظ (0.12)
-- وإعادة النشر (0.10) وتعليق/مشاركة المستخدم، والمؤشر «interested» (0.50).
-- صار أثر التفاعل الشخصي محصوراً في كبح التكرار ونقل الاهتمام، مع بقاء عقوبة
-- «not_interested» المباشرة (-1.00) كما هي.
--
-- حقول الإنتاج المؤكدة والمستخدمة هنا:
--   * posts.user_id (لا يوجد author_id في الجدول؛ يُشتق داخلياً كـ author_id).
--   * posts.sound_id (uuid) لربط الاهتمام بالصوت.
--   * post_view_events: user_id, post_id, surface, content_type,
--     visible_duration_ms, played_duration_ms, media_duration_ms,
--     completion_ratio, replay_count, early_skip, event_at.
--   * post_impressions: user_id, post_id, surface, content_type, impression_at.
--   * post_feedback: user_id, post_id, feedback, created_at, updated_at.
--   * likes / bookmarks / post_shares / reposts: user_id, post_id, created_at.
--
-- كل الإشارات الشخصية تُقرأ بشرط user_id = المستخدم الحالي فقط، وتحت RLS.
-- أي سجل لا يُقرأ بسبب RLS يُهمل تلقائياً (join داخلي مع posts)، ولا يوجد أي
-- تجاوز للسياسة هنا.
-- =====================================================================
begin;

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
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_viewer uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_candidates integer := least(greatest(coalesce(p_candidate_limit, 100), 1), 200);
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
  v_candidates := greatest(v_candidates, v_limit);
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
  --    sound_id مطلوب فقط لنقل الاهتمام بالصوت في V2-B.
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
  -- مقروء تحت سياسة reposts الحالية (aani_reposts_select_own وحدها متساهلة،
  -- مع الحارس restrictive)، ولذلك يُصفّى صراحةً بـ repost.user_id = v_viewer.
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
      -- الإعجاب
      select
        0.30::numeric as weight,
        interaction.user_id,
        interaction.post_id,
        interaction.created_at as signal_at
      from public.likes as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      -- الحفظ
      select 0.45::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.bookmarks as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      -- المشاركة
      select 0.35::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.post_shares as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      -- إعادة النشر
      select 0.40::numeric, interaction.user_id, interaction.post_id, interaction.created_at
      from public.reposts as interaction
      where interaction.user_id = v_viewer
        and interaction.created_at >= now() - interval '60 days'
      union all
      -- مشاهدة كاملة أو قريبة من الاكتمال (مسار الفيديو فقط)
      select 0.15::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.content_type = 'video'
        and view_event.completion_ratio is not null
        and view_event.completion_ratio >= 0.90
        and view_event.event_at >= now() - interval '60 days'
      union all
      -- إعادة المشاهدة
      select 0.10::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and coalesce(view_event.replay_count, 0) > 0
        and view_event.event_at >= now() - interval '60 days'
      union all
      -- تخطٍّ سريع (سلبي)
      select (-0.25)::numeric, view_event.user_id, view_event.post_id, view_event.event_at
      from public.post_view_events as view_event
      where view_event.user_id = v_viewer
        and view_event.surface = 'reels'
        and view_event.early_skip
        and view_event.event_at >= now() - interval '60 days'
      union all
      -- «غير مهتم» (سلبي)
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
        -- مسار الفيديو فقط: لا يُحسب الإكمال إن كانت كل النسب NULL.
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
        -- مسار الصورة فقط: مدة الظهور مؤشر مستقل، وليست نسبة إكمال فيديو.
        + case
            when scored.media_kind = 'image'
             and coalesce(scored.image_view_count, 0) > 0
             and scored.avg_visible_ms is not null
              then least(0.08::numeric, ln(1::numeric + greatest(scored.avg_visible_ms, 0) / 1000.0) * 0.02::numeric)
            else 0::numeric
          end
        -- تشبّع الظهور مشترك ومحدود؛ لا يحوّل عدم وجود impression إلى skip.
        - case
            when scored.impression_count > 0
              then least(0.10::numeric, ln(1::numeric + scored.impression_count::numeric) * 0.02::numeric)
            else 0::numeric
          end
        -- V2-B (1): كبح التكرار. خصم قوي ثابت 0.90 في أول 6 ساعات، ثم تناقص
        -- خطي حتى الصفر عند 72 ساعة. لا استبعاد ولا عقوبة دائمة.
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
        -- V2-B (2): نقل الاهتمام. الإيجابي يُمنح فقط للمنشورات التي لم يتفاعل
        -- معها المستخدم بعد (وإلا بقيت تحت كبح التكرار وحده)؛ السلبي يُطبَّق
        -- دائماً بحد أدنى محدود.
        + case
            when scored.last_interaction_at is null
              then least(0.30::numeric, greatest(0::numeric, scored.author_affinity * 0.35::numeric))
            else 0::numeric
          end
        + case
            when scored.last_interaction_at is null
              then least(0.20::numeric, greatest(0::numeric, scored.sound_affinity * 0.30::numeric))
            else 0::numeric
          end
        + greatest(-0.30::numeric, least(0::numeric, scored.author_affinity * 0.35::numeric))
        + greatest(-0.20::numeric, least(0::numeric, scored.sound_affinity * 0.30::numeric))
      )::numeric as base_score
    from scored
  ),
  -- ترتيب كل منشور داخل مجموعة صاحبه بحسب النقاط، ثم يُستخدم للتنويع.
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
  where final_ranking.rank_position <= v_limit
  order by final_ranking.rank_position asc;
end;
$$;
-- PostgreSQL يمنح EXECUTE إلى PUBLIC افتراضياً، كما قد يمنح service_role
-- عبر Default Privileges في المشروع؛ نسحب الجميع ثم نمنح authenticated فقط.
revoke all on function public.get_personalized_reels(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_personalized_reels(integer, integer)
  to authenticated;
-- فحوص أمان داخل الترحيل: يفشل الترحيل إن لم تتحقق الصلاحيات المطلوبة.
do $$
declare
  target_function oid := to_regprocedure('public.get_personalized_reels(integer,integer)');
  is_security_definer boolean;
  function_settings text[];
  function_owner oid;
  public_or_anon_execute boolean;
  authenticated_execute boolean;
  unexpected_grantees text;
begin
  if target_function is null then
    raise exception 'public.get_personalized_reels(integer, integer) غير موجودة';
  end if;
  select proc.prosecdef, proc.proconfig, proc.proowner
  into is_security_definer, function_settings, function_owner
  from pg_catalog.pg_proc as proc
  where proc.oid = target_function;
  if is_security_definer then
    raise exception 'get_personalized_reels يجب أن تكون SECURITY INVOKER';
  end if;
  if function_settings is null
     or not exists (
       select 1
       from unnest(function_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'get_personalized_reels يجب أن تضبط search_path فارغاً';
  end if;
  select exists (
    select 1
    from aclexplode(coalesce(
      (select proc.proacl from pg_catalog.pg_proc as proc where proc.oid = target_function),
      acldefault('f', function_owner)
    )) as acl
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee in (
        0,
        (select role.oid from pg_catalog.pg_roles as role where role.rolname = 'anon')
      )
  ) into public_or_anon_execute;
  if public_or_anon_execute then
    raise exception 'get_personalized_reels لا يجوز منح EXECUTE إلى PUBLIC أو anon';
  end if;
  select exists (
    select 1
    from aclexplode(coalesce(
      (select proc.proacl from pg_catalog.pg_proc as proc where proc.oid = target_function),
      acldefault('f', function_owner)
    )) as acl
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee = (
        select role.oid from pg_catalog.pg_roles as role where role.rolname = 'authenticated'
      )
  ) into authenticated_execute;
  if not authenticated_execute then
    raise exception 'get_personalized_reels يجب منح EXECUTE إلى authenticated';
  end if;
  select string_agg(unexpected.grantee_name, ', ' order by unexpected.grantee_name)
  into unexpected_grantees
  from (
    select distinct coalesce(role.rolname, 'PUBLIC') as grantee_name
    from aclexplode(coalesce(
      (select proc.proacl from pg_catalog.pg_proc as proc where proc.oid = target_function),
      acldefault('f', function_owner)
    )) as acl
    left join pg_catalog.pg_roles as role on role.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee <> function_owner
      and acl.grantee <> (
        select role_authenticated.oid
        from pg_catalog.pg_roles as role_authenticated
        where role_authenticated.rolname = 'authenticated'
      )
  ) as unexpected;
  if unexpected_grantees is not null then
    raise exception
      'get_personalized_reels مُنحت EXECUTE إلى أدوار غير مسموحة: %. المسموح: المالك و authenticated فقط.',
      unexpected_grantees;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
-- =====================================================================
-- استعلامات تحقق يدوية بعد المراجعة والموافقة — ليست جزءاً من الترحيل.
-- لا تُنفَّذ ضمن إعداد هذا الملف أو مراجعته.
--
-- 1) التوقيع والأمان:
-- select p.proname, p.prosecdef, p.proconfig, p.proacl
-- from pg_catalog.pg_proc p
-- where p.oid = to_regprocedure('public.get_personalized_reels(integer,integer)');
--
-- 2) لا تكرار في post_id وبعدد لا يتجاوز الحد:
-- select post_id, count(*)
-- from public.get_personalized_reels(40, 200)
-- group by post_id having count(*) > 1;
--
-- 3) لا تنفيذ مجهول أو بلا هوية:
-- select * from public.get_personalized_reels(20, 100);
-- عند غياب JWT صالح يجب ألا تُعاد نتائج.
-- =====================================================================
