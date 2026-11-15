-- ترحيل: إغلاق بقية مسارات قراءة محتوى الحساب الخاص.
--
-- 20270203000000 أغلق قراءة public.posts نفسها. هذا الترحيل يُغلق المسارات
-- التي تكشف المنشور أو تفاعله أو قوائم المتابعة، ويحصّن القاعدة ضد إعادة
-- تشغيل schema.sql التي تعيد تعريف السياسات المتساهلة بتعريف لا يعرف is_private:
--
--   1) aani_can_view_post_comments كانت تتحقق من visibility و hide_comments
--      فقط (20261125000000 سطر 98-121، ونفسها في schema.sql سطر 1293)، ولا
--      تعرف profiles.is_private. وهي الحارس restrictive الذي يحمي قراءة
--      comments و likes و comment_likes و comment_dislikes (سطر 180-260)،
--      فتعليقات منشور عام لحساب خاص وإعجاباته كانت مقروءة لغير المتابع المعتمد.
--   2) aani_can_comment_on_post (سطر 123-167) بالثغرة نفسها، فيستطيع غير
--      المتابع التعليق على منشور حساب خاص.
--   3) aani_post_interaction_rows (سطر 389-460) تفلتر visibility فقط، فتُعيد
--      أعداد إعجابات وتعليقات وريبوستات منشورات الحساب الخاص لأي مستدعٍ، وهي
--      SECURITY DEFINER وممنوحة لـ anon. والأهم: get_post_interactions في
--      قاعدة الإنتاج ما زالت بمنطقها القديم الذي لا يفحص is_private، فتُعيد
--      ملخصاً كاملاً لمنشور حساب خاص لغير المتابع المعتمد. هنا:
--        * تُعاد صياغة aani_post_interaction_rows بشرط الخصوصية والحجب.
--        * يُعاد إنشاء الغلافين get_post_interactions و
--          post_interaction_summaries فوقها، فيصبح كل اسم استدعاء محمياً
--          بالمنطق نفسه، بنفس أعمدة الرد التي يقرأها التطبيق.
--        * الصلاحيات وفق الاستدعاء الفعلي: التطبيق ينادي
--          post_interaction_summaries فقط، والثلاث ممنوحة لـauthenticated
--          ومسحوبة من anon و public.
--   4) جدول follows سياسة قراءته using (true) (schema.sql سطر 415-418)، فتكشف
--      قائمتا «المتابعون» و«متابع» لحساب خاص لغير المتابع المعتمد.
--   5) جدول reposts سياسة قراءته using (true) (20261027000000 سطر 10-13) وجدول
--      post_shares مثلها، فيكشفان إعادة النشر والمشاركة لمنشور حساب خاص.
--   6) جداول التفاعل likes و comment_likes و comment_dislikes: سياساتها
--      المتساهلة using (true) (schema.sql سطر 362-378)، فلا شيء يمنع قراءة
--      صفوفها لمنشور لا يحق للمشاهد رؤيته إلا حارس restrictive، وحارس likes
--      الحالي يفحص visibility و hide_likes فقط ولا يعرف profiles.is_private
--      ولا الحظر، وحارسا comment_likes و comment_dislikes يعتمدان على
--      aani_can_view_post_comments وحدها. تعديل الدالة وحده لا يكفي لأن
--      السياسات السارية في القاعدة الحيّة ليست مضمونة المطابقة للملف. هنا
--      تُحذف الحراس الثلاثة وتُعاد إنشاؤها على aani_can_read_post_interactions.
--   7) aani_post_interaction_rows كانت تكرر شرط الخصوصية بنفسها (visibility و
--      is_private فقط، بلا حظر)، فأي تصحيح في قاعدة القراءة لا يصل إليها.
--      صارت تعتمد على aani_can_read_post_interactions: aani_can_read_post
--      (خصوصية الحساب والمنشور) + aani_is_user_blocked (الحظر).
--
-- لا يعدّل جداول ولا بيانات ولا سياسات القصص (aani_can_view_story تتحقق من
-- is_private أصلاً وتُترك كما هي)، ولا واجهة التطبيق، ولا جداول البلاغات.
--
-- يعتمد على 20270203000000 (aani_can_read_post) و20261108000000 و20261115000000.
-- آمن للتكرار.
begin;

-- ---------------------------------------------------------------------
-- 0) التحقق من المتطلبات المسبقة
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.posts') is null
     or to_regclass('public.follows') is null
     or to_regclass('public.profiles') is null then
    raise exception 'الجداول الأساسية (posts, follows, profiles) غير مكتملة — لا يمكن تطبيق هذا الترحيل';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_private'
  ) then
    raise exception 'العمود profiles.is_private مفقود — طبّق 20261108000000 أولاً';
  end if;

  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_can_read_post'
  ) then
    raise exception 'الدالة public.aani_can_read_post مفقودة — طبّق 20270203000000 أولاً';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) دالة واحدة لمعنى «متابع معتمد»
--    SECURITY DEFINER لأنها تقرأ follows بغض النظر عن RLS (وقراءة follows صارت
--    محمية بحارس في القسم 6، فأي استعلام مباشر عليها داخل سياستها يعاود نفسه).
--    محدودة الصلاحيات: تُعيد boolean فقط، ولا تُجيب إلا عن المشاهد نفسه،
--    فلا يمكن استخدامها لاستنتاج علاقات مستخدمين آخرين.
-- ---------------------------------------------------------------------
create or replace function public.aani_is_approved_follower(
  p_owner_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_owner_id is not null
    and p_viewer_id is not null
    and p_viewer_id = auth.uid()
    and p_viewer_id <> p_owner_id
    and exists (
      select 1
      from public.follows as accepted
      where accepted.follower_id = p_viewer_id
        and accepted.following_id = p_owner_id
    ),
    false
  );
$$;

revoke all on function public.aani_is_approved_follower(uuid, uuid) from public, anon;
grant execute on function public.aani_is_approved_follower(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2) حارس قراءة التعليقات: يحمي comments و likes و comment_likes و comment_dislikes
-- ---------------------------------------------------------------------
create or replace function public.aani_can_view_post_comments(
  p_post_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.posts as post
    join public.profiles as owner on owner.id = post.user_id
    where post.id = p_post_id
      and p_viewer_id = auth.uid()
      and (
        post.user_id = p_viewer_id
        or (
          not post.hide_comments
          and coalesce(post.visibility, 'public') <> 'private'
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = post.user_id
            )
          )
        )
      )
  );
$$;

revoke all on function public.aani_can_view_post_comments(uuid, uuid) from public, anon;
grant execute on function public.aani_can_view_post_comments(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3) حارس كتابة التعليق: لا تعليق على محتوى حساب خاص بلا متابعة معتمدة
-- ---------------------------------------------------------------------
create or replace function public.aani_can_comment_on_post(
  p_post_id uuid,
  p_commenter_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.posts as post
    join public.profiles as owner on owner.id = post.user_id
    where post.id = p_post_id
      and coalesce(post.comments_disabled, false) = false
      and (p_commenter_id = auth.uid() or auth.role() = 'service_role')
      and (
        post.user_id = p_commenter_id
        or (
          coalesce(post.visibility, 'public') <> 'private'
          and not post.hide_comments
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_commenter_id
                and accepted.following_id = post.user_id
            )
          )
          and case post.comment_privacy
            when 'followers' then exists (
              select 1
              from public.follows as follower
              where follower.follower_id = p_commenter_id
                and follower.following_id = post.user_id
            )
            when 'custom' then
              post.allowed_commenters @> array[p_commenter_id]
              and exists (
                select 1
                from public.follows as outgoing
                join public.follows as incoming
                  on incoming.follower_id = outgoing.following_id
                 and incoming.following_id = outgoing.follower_id
                where outgoing.follower_id = post.user_id
                  and outgoing.following_id = p_commenter_id
              )
            else true
          end
        )
      )
  );
$$;

revoke all on function public.aani_can_comment_on_post(uuid, uuid) from public, anon;
grant execute on function public.aani_can_comment_on_post(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3ب) قاعدة واحدة لقراءة تفاعلات منشور: هل يحق للمشاهد رؤية هذا المنشور؟
--
--     aani_can_read_post (20270203000000) تحسم خصوصية المنشور وخصوصية الحساب
--     والمتابعة المعتمدة، لكنها لا تعرف الحظر — الحظر حارس restrictive منفصل
--     على posts (aani_posts_block_guard). الدالة SECURITY DEFINER لا تخضع لتلك
--     السياسة، فلو اعتمدت عليها وحدها لقرأت تفاعلات منشور مستخدم حاجبها.
--
--     لذلك تُجمع القاعدتان هنا في دالة واحدة صغيرة، وتُستدعى من:
--       * aani_post_interaction_rows (القسم 4)،
--       * حراس قراءة likes و comment_likes و comment_dislikes (القسم 7ب).
--
--     تُنشأ أولاً بلا فحص الحظر (aani_is_user_blocked قد تكون غائبة في قاعدة
--     بُنيت من schema.sql)، ثم تُستبدل بنسخة تفحص الحظر إن كانت موجودة.
--     SECURITY DEFINER لأنها تقرأ posts و follows و user_blocks بغض النظر عن
--     RLS، ومحدودة الصلاحيات: تُعيد boolean فقط ولا تكشف أي صف.
-- ---------------------------------------------------------------------
create or replace function public.aani_can_read_post_interactions(
  p_post_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.aani_can_read_post(p_post_id, p_viewer_id), false);
$$;

revoke all on function public.aani_can_read_post_interactions(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.aani_can_read_post_interactions(uuid, uuid)
  to authenticated, anon;

do $$
begin
  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_is_user_blocked'
  ) then
    raise warning
      'الدالة aani_is_user_blocked غائبة — حُرّاس التفاعل تعتمد على aani_can_read_post بلا فحص حظر. طبّق 20270204000000 ثم أعد تشغيل هذا الترحيل.';
    return;
  end if;

  execute $fn$
    create or replace function public.aani_can_read_post_interactions(
      p_post_id uuid,
      p_viewer_id uuid
    )
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      select public.aani_can_read_post(p_post_id, p_viewer_id)
        and not public.aani_is_user_blocked(
          p_viewer_id,
          (select post.user_id from public.posts as post where post.id = p_post_id)
        );
    $body$;
  $fn$;

  execute 'revoke all on function public.aani_can_read_post_interactions(uuid, uuid) from public, anon, authenticated';
  execute 'grant execute on function public.aani_can_read_post_interactions(uuid, uuid) to authenticated, anon';
end $$;

-- ---------------------------------------------------------------------
-- 4) ملخصات التفاعل: لا صفوف لمنشور لا يحق للمشاهد رؤيته
--    (وإلا كشفت الدالة SECURITY DEFINER أعداد إعجابات وتعليقات وريبوستات)
--    نفس الأعمدة ونفس الدلالات السابقة، والشرط الوحيد هو
--    aani_can_read_post_interactions: خصوصية المنشور + خصوصية الحساب +
--    المتابعة المعتمدة + الحظر، بدل تكرار الشرط هنا بنسخة ناقصة.
-- ---------------------------------------------------------------------
create or replace function public.aani_post_interaction_rows(p_post_ids uuid[])
returns table (
  post_id uuid,
  likes_count bigint,
  comments_count bigint,
  reposts_count bigint,
  shares_count bigint,
  liked_by_me boolean,
  reposted_by_me boolean,
  saved_by_me boolean,
  feedback_by_me text,
  shared_by_me boolean,
  like_count integer,
  comment_count integer,
  repost_count integer,
  share_count integer,
  liked boolean,
  bookmarked boolean,
  reposted boolean,
  shared boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with summaries as (
    select
      p.id as post_id,
      case
        when p.hide_likes and p.user_id is distinct from auth.uid() then 0::bigint
        else (select count(*) from public.likes l where l.post_id = p.id)::bigint
      end as likes_count,
      case
        when p.hide_comments and p.user_id is distinct from auth.uid() then 0::bigint
        else (select count(*) from public.comments c where c.post_id = p.id)::bigint
      end as comments_count,
      (select count(*) from public.reposts r where r.post_id = p.id)::bigint as reposts_count,
      (select count(*) from public.post_shares s where s.post_id = p.id)::bigint as shares_count,
      exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked_by_me,
      exists (select 1 from public.reposts r where r.post_id = p.id and r.user_id = auth.uid()) as reposted_by_me,
      exists (select 1 from public.bookmarks b where b.post_id = p.id and b.user_id = auth.uid()) as saved_by_me,
      (select f.feedback from public.post_feedback f where f.post_id = p.id and f.user_id = auth.uid() limit 1) as feedback_by_me,
      exists (select 1 from public.post_shares s where s.post_id = p.id and s.user_id = auth.uid()) as shared_by_me
    from public.posts as p
    join public.profiles as owner on owner.id = p.user_id
    where p.id = any(coalesce(p_post_ids, '{}'::uuid[]))
      and public.aani_can_read_post_interactions(p.id, auth.uid())
  )
  select
    s.post_id,
    s.likes_count,
    s.comments_count,
    s.reposts_count,
    s.shares_count,
    s.liked_by_me,
    s.reposted_by_me,
    s.saved_by_me,
    s.feedback_by_me,
    s.shared_by_me,
    s.likes_count::integer as like_count,
    s.comments_count::integer as comment_count,
    s.reposts_count::integer as repost_count,
    s.shares_count::integer as share_count,
    s.liked_by_me as liked,
    s.saved_by_me as bookmarked,
    s.reposted_by_me as reposted,
    s.shared_by_me as shared
  from summaries s;
$$;

-- الصلاحيات وفق الاستدعاء الفعلي:
--   التطبيق ينادي public.post_interaction_summaries(post_ids uuid[]) فقط
--   (src/lib/interactions/hydration.ts سطر 156)، ولا ينادي
--   aani_post_interaction_rows ولا get_post_interactions مباشرة.
--   الغلافان SECURITY DEFINER ويعملان بصلاحيات المالك، فسحب التنفيذ من
--   authenticated عن الدالة الداخلية لا يعطّلهما. ومع ذلك تُمنح الدالة الداخلية
--   لـauthenticated أيضاً: هي نفسها التي تُطبّق شرط الخصوصية، فأي استدعاء
--   مباشر لها يُعيد صفوف المشاهد المسموح له بها فقط، ولا يوجد مسار مكسور مهما
--   كان ترتيب التطبيق أو حالة الأغلفة. anon و public مسحوبان من الجميع.
revoke all on function public.aani_post_interaction_rows(uuid[]) from public, anon;
grant execute on function public.aani_post_interaction_rows(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 4ب) إعادة تعريف غلافي الملخصات فوق الدالة المحمية
--
--    قاعدة الإنتاج تحمل get_post_interactions(uuid[]) بمنطقها القديم الذي لا
--    يفحص is_private، والترحيل السابق كان يمنح الصلاحية فقط ولا يستبدل الجسم —
--    فيبقى التسريب قائماً عبر ذلك الاسم. هنا يُعاد إنشاء الغلافين فوق
--    aani_post_interaction_rows، فتصبح الخصوصية مطبقة على كل أسماء الاستدعاء.
--
--    الأعمدة وأنواعها مطابقة تماماً لما يقرأه العميل (mapSummaryRow في
--    hydration.ts): post_id, likes_count, comments_count, reposts_count,
--    shares_count, liked_by_me, reposted_by_me, saved_by_me, feedback_by_me,
--    shared_by_me، ثم الأسماء المختصرة like_count/comment_count/repost_count/
--    share_count/liked/bookmarked/reposted/shared.
-- ---------------------------------------------------------------------
do $$
declare
  has_inner boolean;
begin
  select exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_post_interaction_rows'
  ) into has_inner;

  if not has_inner then
    raise exception 'الدالة public.aani_post_interaction_rows مفقودة — لا يمكن إعادة تعريف غلافي الملخصات';
  end if;

  -- الحذف قبل الإنشاء: نسخة الإنتاج قد تحمل أعمدة مختلفة، و`create or replace`
  -- لا يغيّر قائمة الأعمدة المرجعة.
  execute 'drop function if exists public.get_post_interactions(uuid[])';
  execute 'drop function if exists public.post_interaction_summaries(uuid[])';

  execute $fn$
    create function public.get_post_interactions(p_post_ids uuid[])
    returns table (
      post_id uuid,
      likes_count bigint,
      comments_count bigint,
      reposts_count bigint,
      shares_count bigint,
      liked_by_me boolean,
      reposted_by_me boolean,
      saved_by_me boolean,
      feedback_by_me text,
      shared_by_me boolean,
      like_count integer,
      comment_count integer,
      repost_count integer,
      share_count integer,
      liked boolean,
      bookmarked boolean,
      reposted boolean,
      shared boolean
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      select * from public.aani_post_interaction_rows(p_post_ids);
    $body$;
  $fn$;

  execute $fn$
    create function public.post_interaction_summaries(post_ids uuid[])
    returns table (
      post_id uuid,
      likes_count bigint,
      comments_count bigint,
      reposts_count bigint,
      shares_count bigint,
      liked_by_me boolean,
      reposted_by_me boolean,
      saved_by_me boolean,
      feedback_by_me text,
      shared_by_me boolean,
      like_count integer,
      comment_count integer,
      repost_count integer,
      share_count integer,
      liked boolean,
      bookmarked boolean,
      reposted boolean,
      shared boolean
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      select * from public.aani_post_interaction_rows(post_ids);
    $body$;
  $fn$;

  execute 'revoke all on function public.get_post_interactions(uuid[]) from public, anon';
  execute 'revoke all on function public.post_interaction_summaries(uuid[]) from public, anon';
  execute 'grant execute on function public.get_post_interactions(uuid[]) to authenticated';
  execute 'grant execute on function public.post_interaction_summaries(uuid[]) to authenticated';
end $$;

-- ---------------------------------------------------------------------
-- 5) حارس قراءة restrictive على posts
--    السياسة المتساهلة تحمل اسماً معروفاً لـ schema.sql، فهو يحذفها ويعيد
--    إنشاءها بشرط لا يعرف is_private عند إعادة التشغيل. الحارس restrictive
--    يُجمع بـ AND ولا يمكن توسيعه بسياسة متساهلة، فيبقى هو المرجع.
-- ---------------------------------------------------------------------
drop policy if exists aani_posts_private_read_guard on public.posts;
create policy aani_posts_private_read_guard on public.posts
  as restrictive for select to authenticated
  using (public.aani_can_read_post(id, (select auth.uid())));

drop policy if exists aani_posts_private_read_guard_anon on public.posts;
create policy aani_posts_private_read_guard_anon on public.posts
  as restrictive for select to anon
  using (public.aani_can_read_post(id, null::uuid));

-- ---------------------------------------------------------------------
-- 6) حارس قراءة restrictive على follows
--    قائمتا «المتابعون» و«متابع» لحساب خاص لا تُقرآن إلا من صاحب الحساب أو
--    متابعه المعتمد، أو للصف الخاص بالمشاهد نفسه (لازم لعرض حالة المتابعة).
-- ---------------------------------------------------------------------
drop policy if exists aani_follows_private_read_guard on public.follows;
create policy aani_follows_private_read_guard on public.follows
  as restrictive for select to authenticated
  using (
    follower_id = (select auth.uid())
    or following_id = (select auth.uid())
    or not exists (
      select 1
      from public.profiles as owner
      where owner.id = following_id
        and owner.is_private
    )
    or public.aani_is_approved_follower(following_id, (select auth.uid()))
  );

-- ---------------------------------------------------------------------
-- 7) حارسا قراءة restrictive على reposts و post_shares
--    لا يظهر سجل إعادة النشر أو المشاركة لمنشور لا يملك المشاهد حق قراءته.
-- ---------------------------------------------------------------------
drop policy if exists aani_reposts_private_read_guard on public.reposts;
create policy aani_reposts_private_read_guard on public.reposts
  as restrictive for select to authenticated
  using (public.aani_can_read_post(post_id, (select auth.uid())));

drop policy if exists aani_post_shares_private_read_guard on public.post_shares;
create policy aani_post_shares_private_read_guard on public.post_shares
  as restrictive for select to authenticated
  using (public.aani_can_read_post(post_id, (select auth.uid())));

-- ---------------------------------------------------------------------
-- 7ب) حراس قراءة restrictive فعلية على جداول التفاعل
--     likes و comment_likes و comment_dislikes
--
--     سياسات القراءة المتساهلة على الجداول الثلاثة هي using (true)
--     (schema.sql سطر 362-378)، فكل مستخدم مسجّل يقرأ كل صفوفها، ولا شيء
--     يمنع قراءة تفاعلات منشور لا يحق له رؤيته إلا حارس restrictive. تعديل
--     aani_can_view_post_comments وحده لا يكفي: السياسات السارية في القاعدة
--     الحيّة ليست مضمونة المطابقة للملف، وحارس likes لا يستدعيها أصلاً (يفحص
--     visibility و hide_likes فقط، بلا profiles.is_private).
--
--     لذلك تُحذف الحراس الثلاثة وتُعاد إنشاؤها على
--     aani_can_read_post_interactions، فتصبح القاعدة واحدة على كل الجداول:
--     خصوصية المنشور + خصوصية الحساب + المتابعة المعتمدة + الحظر.
--
--     hide_likes يبقى كما هو: صاحب المنشور يرى كل الإعجابات، وغيره يرى إعجابه
--     فقط. و hide_comments يبقى على تفاعلات التعليقات عبر
--     aani_can_view_post_comments (المعاد تعريفها في القسم 2 لتعرف is_private).
--     الجداول قد تكون غائبة في قاعدة قديمة، فيُتخطى الحارس بتحذير لا بفشل.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.likes') is null then
    raise warning 'الجدول public.likes غير موجود — تم تخطي حارس قراءته';
  else
    execute 'drop policy if exists aani_likes_privacy_read_guard on public.likes';
    execute $policy$
      create policy aani_likes_privacy_read_guard on public.likes
        as restrictive for select to authenticated
        using (
          public.aani_can_read_post_interactions(post_id, (select auth.uid()))
          and (
            likes.user_id = (select auth.uid())
            or not exists (
              select 1
              from public.posts as post
              where post.id = likes.post_id
                and post.hide_likes
                and post.user_id is distinct from (select auth.uid())
            )
          )
        )
    $policy$;
  end if;

  if to_regclass('public.comment_likes') is null then
    raise warning 'الجدول public.comment_likes غير موجود — تم تخطي حارس قراءته';
  else
    execute 'drop policy if exists aani_comment_likes_privacy_read_guard on public.comment_likes';
    execute $policy$
      create policy aani_comment_likes_privacy_read_guard on public.comment_likes
        as restrictive for select to authenticated
        using (
          exists (
            select 1
            from public.comments as c
            where c.id = comment_likes.comment_id
              and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
              and public.aani_can_read_post_interactions(c.post_id, (select auth.uid()))
          )
        )
    $policy$;
  end if;

  if to_regclass('public.comment_dislikes') is null then
    raise warning 'الجدول public.comment_dislikes غير موجود — تم تخطي حارس قراءته';
  else
    execute 'drop policy if exists aani_comment_dislikes_privacy_read_guard on public.comment_dislikes';
    execute $policy$
      create policy aani_comment_dislikes_privacy_read_guard on public.comment_dislikes
        as restrictive for select to authenticated
        using (
          exists (
            select 1
            from public.comments as c
            where c.id = comment_dislikes.comment_id
              and public.aani_can_view_post_comments(c.post_id, (select auth.uid()))
              and public.aani_can_read_post_interactions(c.post_id, (select auth.uid()))
          )
        )
    $policy$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8) تحقق داخل الترحيل
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'aani_posts_private_read_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  ) then
    raise exception 'حارس قراءة المنشورات الخاص غير مفعّل';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'follows'
      and policyname = 'aani_follows_private_read_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  ) then
    raise exception 'حارس قراءة قوائم المتابعة للحساب الخاص غير مفعّل';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'reposts'
      and policyname = 'aani_reposts_private_read_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  ) then
    raise exception 'حارس قراءة إعادة النشر الخاص غير مفعّل';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public' and tablename = 'post_shares'
      and policyname = 'aani_post_shares_private_read_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
  ) then
    raise exception 'حارس قراءة مشاركات المنشور غير مفعّل';
  end if;

  -- -------------------------------------------------------------------
  -- قاعدة القراءة المشتركة للتفاعلات: موجودة، وتعتمد فعلاً على
  -- aani_can_read_post (خصوصية الحساب والمنشور) — لا نسخة محلية ناقصة.
  -- -------------------------------------------------------------------
  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_can_read_post_interactions'
      and proc.prosecdef
      and proc.prosrc like '%aani_can_read_post%'
  ) then
    raise exception 'الدالة aani_can_read_post_interactions مفقودة أو لا تعتمد على aani_can_read_post';
  end if;

  -- aani_post_interaction_rows صارت تستدعي الدالة المشتركة بدل تكرار شرط
  -- خصوصية ناقص بلا حظر.
  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_post_interaction_rows'
      and proc.prosrc not like '%aani_can_read_post_interactions%'
  ) then
    raise exception 'aani_post_interaction_rows ما زالت تفحص الخصوصية بنفسها بدل aani_can_read_post_interactions';
  end if;

  -- -------------------------------------------------------------------
  -- حراس جداول التفاعل: restrictive على SELECT، ونصّها يستدعي الدالة
  -- المشتركة. الفحص على qual يمنع «سياسة موجودة بالاسم لكن بلا فحص».
  -- الجدول الغائب يُتخطى (كما في الإنشاء أعلاه).
  -- -------------------------------------------------------------------
  if exists (
    select 1
    from (values
      ('likes', 'aani_likes_privacy_read_guard'),
      ('comment_likes', 'aani_comment_likes_privacy_read_guard'),
      ('comment_dislikes', 'aani_comment_dislikes_privacy_read_guard')
    ) as expected(tbl, pol)
    where to_regclass('public.' || expected.tbl) is not null
      and not exists (
        select 1
        from pg_policies as existing
        where existing.schemaname = 'public'
          and existing.tablename = expected.tbl
          and existing.policyname = expected.pol
          and existing.permissive = 'RESTRICTIVE'
          and existing.cmd = 'SELECT'
          and coalesce(existing.qual, '') like '%aani_can_read_post_interactions%'
      )
  ) then
    raise exception 'أحد حراس قراءة جداول التفاعل (likes, comment_likes, comment_dislikes) غير مفعّل كـRESTRICTIVE أو لا يستدعي aani_can_read_post_interactions';
  end if;

  -- -------------------------------------------------------------------
  -- الغلافان: موجودان، definer، search_path مغلق، ويعتمد كلاهما على الدالة
  -- المحمية — لا على منطق قديم يعدّ مباشرة بلا فحص خصوصية.
  -- -------------------------------------------------------------------
  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in ('get_post_interactions', 'post_interaction_summaries')
      and (
        not proc.prosecdef
        or proc.prosrc not like '%aani_post_interaction_rows%'
      )
  ) then
    raise exception 'أحد غلافي الملخصات ما زال بمنطق قديم أو بلا SECURITY DEFINER — الخصوصية غير مطبقة عليه';
  end if;

  if (
    select count(*)
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in ('get_post_interactions', 'post_interaction_summaries')
  ) <> 2 then
    raise exception 'غلافا الملخصات get_post_interactions و post_interaction_summaries غير مكتملين';
  end if;

  -- الزائر لا ينفّذ أيّاً منها، والمستخدم المسجّل ينفّذ الثلاثة.
  if has_function_privilege('anon', 'public.post_interaction_summaries(uuid[])', 'execute')
     or has_function_privilege('anon', 'public.get_post_interactions(uuid[])', 'execute')
     or has_function_privilege('anon', 'public.aani_post_interaction_rows(uuid[])', 'execute') then
    raise exception 'دوال ملخصات التفاعل ما زالت ممنوحة لـanon';
  end if;

  if not has_function_privilege('authenticated', 'public.post_interaction_summaries(uuid[])', 'execute')
     or not has_function_privilege('authenticated', 'public.get_post_interactions(uuid[])', 'execute')
     or not has_function_privilege('authenticated', 'public.aani_post_interaction_rows(uuid[])', 'execute') then
    raise exception 'دوال ملخصات التفاعل غير ممنوحة لـauthenticated — الفيد والتفاعلات سيتعطلان';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) الحُرّاس موجودون كـRESTRICTIVE
--    select tablename, policyname, permissive, cmd, qual
--    from pg_policies
--    where schemaname = 'public'
--      and tablename in (
--        'posts', 'follows', 'reposts', 'post_shares',
--        'likes', 'comment_likes', 'comment_dislikes'
--      )
--    order by tablename, permissive, policyname;
--    -- المتوقع: حارس واحد على الأقل لكل جدول بـpermissive = RESTRICTIVE وcmd = SELECT،
--    -- و qual يحتوي aani_can_read_post_interactions في likes و comment_likes
--    -- و comment_dislikes.
--
-- 1ب) قاعدة القراءة المشتركة للتفاعلات (خصوصية + حظر)
--    select p.proname, p.prosecdef, p.proconfig,
--           p.prosrc ~* 'aani_can_read_post' as uses_read_rule,
--           p.prosrc ~* 'aani_is_user_blocked' as checks_blocks
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('aani_can_read_post_interactions', 'aani_post_interaction_rows');
--    -- المتوقع: uses_read_rule = true للصفين، checks_blocks = true للصف الأول
--    -- (وإن ظهر false مع تحذير aani_is_user_blocked فالسبب أن الدالة غائبة).
--
-- 2) الزائر لا يستطيع استدعاء ملخصات التفاعل (المتوقع: false للثلاث)
--    select has_function_privilege('anon', 'public.post_interaction_summaries(uuid[])', 'execute'),
--           has_function_privilege('anon', 'public.get_post_interactions(uuid[])', 'execute'),
--           has_function_privilege('anon', 'public.aani_post_interaction_rows(uuid[])', 'execute');
--
-- 2ب) المستخدم المسجّل ينفّذها (المتوقع: true للثلاث)
--    select has_function_privilege('authenticated', 'public.post_interaction_summaries(uuid[])', 'execute'),
--           has_function_privilege('authenticated', 'public.get_post_interactions(uuid[])', 'execute'),
--           has_function_privilege('authenticated', 'public.aani_post_interaction_rows(uuid[])', 'execute');
--
-- 2ج) الغلافان بمنطق جديد: definer، search_path مغلق، ويستدعيان الدالة المحمية
--    select p.proname, p.prosecdef, p.proconfig,
--           p.prosrc ~* 'aani_post_interaction_rows' as uses_protected_impl
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('get_post_interactions', 'post_interaction_summaries')
--    order by p.proname;
--    -- المتوقع: prosecdef = true، uses_protected_impl = true للصفين
--
-- 2د) شكل الأعمدة كما يتوقعه العميل (mapSummaryRow في hydration.ts)
--    select string_agg(a.attname, ', ' order by a.attnum) as columns
--    from pg_proc p
--    join pg_namespace n on n.oid = p.pronamespace
--    cross join lateral unnest(p.proargnames) with ordinality as a(attname, attnum)
--    where n.nspname = 'public' and p.proname = 'post_interaction_summaries';
--
-- 3) بصفتك حساباً غير متابع لحساب خاص A:
--    select count(*) from public.comments where post_id = '<post_of_A>';   -- 0
--    select count(*) from public.likes where post_id = '<post_of_A>';      -- 0
--    select count(*) from public.reposts where post_id = '<post_of_A>';    -- 0
--    select count(*) from public.follows where following_id = '<A>';       -- 0
--    select count(*) from public.comment_likes
--      where comment_id in (select id from public.comments where post_id = '<post_of_A>');   -- 0
--    select count(*) from public.comment_dislikes
--      where comment_id in (select id from public.comments where post_id = '<post_of_A>');   -- 0
--    select count(*) from public.post_interaction_summaries(array['<post_of_A>'::uuid]); -- 0
--    select count(*) from public.get_post_interactions(array['<post_of_A>'::uuid]);      -- 0 (الاسم القديم محمي أيضاً)
--    select count(*) from public.aani_post_interaction_rows(array['<post_of_A>'::uuid]); -- 0 (الدالة الداخلية محمية أيضاً)
--    insert into public.comments (post_id, user_id, content) values ('<post_of_A>', auth.uid(), 'test'); -- يفشل
--
-- 3ب) بصفتك مستخدماً حجبك صاحب منشور عام (أو حجبته أنت): كل ما سبق يُعيد 0
--    للحساب المحجوب رغم أن المنشور غير خاص ورغم أن الحساب غير خاص — هذا هو
--    فحص الحظر الذي كان غائباً عن aani_post_interaction_rows.
--
-- 4) بصفتك متابعاً معتمداً لـA: كل ما سبق يُعيد قيمه الطبيعية، ومنشور A
--    بـvisibility = 'private' يبقى بصفر صفوف للمتابع أيضاً.
