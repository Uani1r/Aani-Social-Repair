-- =====================================================================
-- المرحلة الخامسة — 5-B1: محرك ترتيب الريلز المستقل
-- public.get_personalized_reels(p_limit, p_candidate_limit)
--
-- حالة الملف: مسودة مراجعة فقط.
-- لم يُطبّق على Supabase أو Production، ولم تُعدّل ملفات التطبيق.
-- لا ينشئ جداول أو فهارس أو سياسات، ولا يغيّر get_personalized_feed.
--
-- يعيد ترتيباً فقط، ولا يعيد صفوف posts أو حقول الوسائط أو روابط ImageKit.
-- المخرجات أربعة أعمدة متوافقة مع إسناد إعادة النشر في واجهة التطبيق:
--   post_id, reposter_id, reposted_at, rank_position
--
-- reposter_id / reposted_at: أحدث إعادة نشر **للمستخدم الحالي** لكل post_id،
-- سواء وصل المنشور إلى المرشحين من المتابعات أو الاستكشاف أو إعادة النشر.
--
-- قيد RLS الحالي على public.reposts:
--   * aani_reposts_select_own هي سياسة SELECT المتساهلة الوحيدة، وشرطها
--     auth.uid() = user_id.
--   * aani_reposts_private_read_guard سياسة RESTRICTIVE تُضاف إليها بـAND.
--   لذلك لا يقرأ المستخدم إلا سجلات إعادة نشره هو، ولا يستطيع قراءة إعادة
--   نشر المستخدمين الآخرين. يعتمد المصدر الثالث (repost_slice) وإسناد
--   reposter_id / reposted_at على هذا القيد صراحةً، ويُصفّى كل منهما بـ
--   repost.user_id = v_viewer بدل الاعتماد على RLS وحده.
--   هذا الملف لا يوسّع السياسات ولا يمنح أي صلاحية جديدة على reposts.
--
-- إزالة التكرار: تُدمج المصادر الثلاثة ثم يُختار صف واحد لكل post_id
-- قبل تطبيق الحصص والإشارات والترتيب النهائي.
--
-- الفيديو والصورة المصحوبة بالموسيقى لهما مسارا تقييم منفصلان:
--   * video: played_duration, completion, replay, early_skip.
--   * image: visible dwell فقط؛ لا completion ولا played ولا skip penalty.
-- غياب أي إشارة لا يستبعد المرشح ولا يتحول إلى عقوبة.
--
-- SECURITY INVOKER + search_path فارغ: كل قراءة تخضع لصلاحيات وRLS
-- للمستخدم المستدعي. لا SECURITY DEFINER ولا تجاوز لسياسات الخصوصية والحظر.
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
  -- ---------------------------------------------------------------
  follow_slice as (
    select
      post.id as post_id,
      post.created_at as post_created_at,
      post.created_at as candidate_at,
      post.user_id as author_id,
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
        -- الشرط صريح هنا بدل الاعتماد على RLS وحده، ولا يوسّع أي صلاحية.
        and repost.user_id = v_viewer
        and (post.type = 'reel' or post.destination = 'reels')
        -- لا تستهلك إعادة النشر حصة مستقلة إذا كان المنشور مؤهلاً
        -- بالفعل لمصدر المتابعات أو الاكتشاف وفق قواعد الأهلية نفسها.
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
      selected.candidate_at, selected.author_id, selected.from_follow,
      selected.likes_count, selected.comments_count, selected.reposts_count,
      selected.shares_count, selected.media_kind
    from quota_selected as selected
    union all
    select
      overflow.post_id, overflow.source_rank, overflow.post_created_at,
      overflow.candidate_at, overflow.author_id, overflow.from_follow,
      overflow.likes_count, overflow.comments_count, overflow.reposts_count,
      overflow.shares_count, overflow.media_kind
    from quota_overflow as overflow
    where overflow.overflow_position <= greatest(
      0, v_candidates - (select count(*)::integer from quota_selected)
    )
  ),
  -- ---------------------------------------------------------------
  -- 2) الإشارات: كل CTE مجمّع مسبقاً إلى صف واحد لكل post_id.
  --    LEFT JOIN لاحقاً يمنع إسقاط المرشح عند غياب أي سجل.
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
  signal_likes as (
    select interaction.post_id, true as liked
    from public.likes as interaction
    where interaction.user_id = v_viewer
      and interaction.post_id in (select candidate.post_id from candidates as candidate)
    group by interaction.post_id
  ),
  signal_bookmarks as (
    select interaction.post_id, true as bookmarked
    from public.bookmarks as interaction
    where interaction.user_id = v_viewer
      and interaction.post_id in (select candidate.post_id from candidates as candidate)
    group by interaction.post_id
  ),
  signal_reposts as (
    select interaction.post_id, true as reposted_by_viewer
    from public.reposts as interaction
    where interaction.user_id = v_viewer
      and interaction.post_id in (select candidate.post_id from candidates as candidate)
    group by interaction.post_id
  ),
  signal_comments as (
    select interaction.post_id, count(*)::integer as own_comment_count
    from public.comments as interaction
    where interaction.user_id = v_viewer
      and interaction.post_id in (select candidate.post_id from candidates as candidate)
    group by interaction.post_id
  ),
  signal_shares as (
    select interaction.post_id, count(*)::integer as own_share_count
    from public.post_shares as interaction
    where interaction.user_id = v_viewer
      and interaction.post_id in (select candidate.post_id from candidates as candidate)
    group by interaction.post_id
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
  -- مع الحارس restrictive)، ولذلك يُصفّى صراحةً بـ repost.user_id = v_viewer:
  -- فإسناد reposter_id / reposted_at لا يكون إلا لإعادة نشر المستخدم نفسه،
  -- ولا تُقرأ إعادات الآخرين ولا يُمنح أي صلاحية جديدة.
  -- هذا CTE لا يغيّر هوية المنشور ولا يكرر الصفوف.
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
  scored as (
    select
      candidate.post_id,
      candidate.author_id,
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
      coalesce(likes.liked, false) as liked,
      coalesce(bookmarks.bookmarked, false) as bookmarked,
      coalesce(reposts.reposted_by_viewer, false) as reposted_by_viewer,
      coalesce(comments.own_comment_count, 0) as own_comment_count,
      coalesce(shares.own_share_count, 0) as own_share_count,
      coalesce(feedback.interested, false) as interested,
      coalesce(feedback.not_interested, false) as not_interested,
      coalesce(candidate.likes_count, 0) as likes_count,
      coalesce(candidate.comments_count, 0) as comments_count,
      coalesce(candidate.reposts_count, 0) as reposts_count,
      coalesce(candidate.shares_count, 0) as shares_count,
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
    left join signal_likes as likes on likes.post_id = candidate.post_id
    left join signal_bookmarks as bookmarks on bookmarks.post_id = candidate.post_id
    left join signal_reposts as reposts on reposts.post_id = candidate.post_id
    left join signal_comments as comments on comments.post_id = candidate.post_id
    left join signal_shares as shares on shares.post_id = candidate.post_id
    left join signal_feedback as feedback on feedback.post_id = candidate.post_id
  ),
  weighted as (
    select
      scored.post_id,
      scored.author_id,
      scored.post_created_at,
      (
        scored.recency_score
        + case when scored.from_follow then 0.30::numeric else 0::numeric end
        + case when scored.interested then 0.50::numeric else 0::numeric end
        + case when scored.not_interested then -1.00::numeric else 0::numeric end
        + least(0.15::numeric, scored.engagement_raw * 0.02::numeric)
        + case when scored.liked then 0.08::numeric else 0::numeric end
        + case when scored.bookmarked then 0.12::numeric else 0::numeric end
        + case when scored.reposted_by_viewer then 0.10::numeric else 0::numeric end
        + least(0.08::numeric, ln(1::numeric + scored.own_comment_count::numeric) * 0.03::numeric)
        + least(0.08::numeric, ln(1::numeric + scored.own_share_count::numeric) * 0.03::numeric)
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
        -- غياب حدث الصورة يعطي صفراً محايداً، ولا ينتج أي خصم.
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
      author_ranked.post_created_at,
      (
        author_ranked.base_score
        - least(0.20::numeric, 0.04::numeric * (author_ranked.author_position - 1)::numeric)
      )::numeric as final_score
    from author_ranked
  ),
  final_ranking as (
    select
      diversified.post_id,
      row_number() over (
        order by diversified.final_score desc,
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
-- 2) لا تكرار في post_id:
-- select post_id, count(*)
-- from public.get_personalized_reels(40, 200)
-- group by post_id having count(*) > 1;
--
-- 3) لا تنفيذ مجهول أو بلا هوية:
-- select * from public.get_personalized_reels(20, 100);
-- عند غياب JWT صالح يجب ألا تُعاد نتائج.
-- =====================================================================
