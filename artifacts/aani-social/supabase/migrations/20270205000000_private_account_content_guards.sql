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
--      SECURITY DEFINER وممنوحة لـ anon.
--   4) جدول follows سياسة قراءته using (true) (schema.sql سطر 415-418)، فتكشف
--      قائمتا «المتابعون» و«متابع» لحساب خاص لغير المتابع المعتمد.
--   5) جدول reposts سياسة قراءته using (true) (20261027000000 سطر 10-13) وجدول
--      post_shares مثلها، فيكشفان إعادة النشر والمشاركة لمنشور حساب خاص.
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
-- 4) ملخصات التفاعل: لا صفوف لمنشور حساب خاص لغير المتابع المعتمد
--    (وإلا كشفت الدالة SECURITY DEFINER أعداد إعجابات وتعليقات وريبوستات)
--    نفس الأعمدة ونفس الدلالات السابقة مع شرط الخصوصية فقط.
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
      and (
        p.user_id = auth.uid()
        or (
          coalesce(p.visibility, 'public') <> 'private'
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = auth.uid()
                and accepted.following_id = p.user_id
            )
          )
        )
      )
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

revoke all on function public.aani_post_interaction_rows(uuid[]) from public, anon, authenticated;

-- الزائر غير المسجل لا يحتاج ملخصات التفاعل؛ سحب التنفيذ منه يمنع استدعاءً
-- مباشراً بمفتاح anon يكشف أعداد التفاعل.
do $$
begin
  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'get_post_interactions'
  ) then
    execute 'revoke all on function public.get_post_interactions(uuid[]) from anon';
    execute 'grant execute on function public.get_post_interactions(uuid[]) to authenticated';
  end if;

  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'post_interaction_summaries'
  ) then
    execute 'revoke all on function public.post_interaction_summaries(uuid[]) from anon';
    execute 'grant execute on function public.post_interaction_summaries(uuid[]) to authenticated';
  end if;
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
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) الحُرّاس موجودون كـRESTRICTIVE
--    select tablename, policyname, permissive, cmd
--    from pg_policies
--    where schemaname = 'public'
--      and tablename in ('posts', 'follows', 'reposts', 'post_shares')
--    order by tablename, permissive, policyname;
--
-- 2) الزائر لا يستطيع استدعاء ملخصات التفاعل (المتوقع: false)
--    select has_function_privilege('anon', 'public.post_interaction_summaries(uuid[])', 'execute');
--
-- 3) بصفتك حساباً غير متابع لحساب خاص A:
--    select count(*) from public.comments where post_id = '<post_of_A>';   -- 0
--    select count(*) from public.likes where post_id = '<post_of_A>';      -- 0
--    select count(*) from public.reposts where post_id = '<post_of_A>';    -- 0
--    select count(*) from public.follows where following_id = '<A>';       -- 0
--    select count(*) from public.post_interaction_summaries(array['<post_of_A>'::uuid]); -- 0
--    insert into public.comments (post_id, user_id, content) values ('<post_of_A>', auth.uid(), 'test'); -- يفشل
--
-- 4) بصفتك متابعاً معتمداً لـA: كل ما سبق يُعيد قيمه الطبيعية.
