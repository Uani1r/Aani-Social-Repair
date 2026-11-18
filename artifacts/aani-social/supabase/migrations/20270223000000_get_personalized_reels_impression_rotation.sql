-- =====================================================================
-- Aani Reels — تدوير واعٍ بالظهور السابق فوق محرك V2-B
-- public.get_personalized_reels(p_limit, p_topn?) — التوقيع نفسه دون تغيير.
--
-- الحالة: لم يُنفَّذ على أي قاعدة بيانات. يُطبَّق يدويًا بعد المراجعة.
--
-- السبب الجذري لتكرار الريلز (ثلاثة أسباب مجتمعة):
--   1) محرك V2-B يعاقب الظهور فقط بسقف صغير (0.10) وبإشارة لا تُقرأ بعد
--      7 أيام (signal_impressions)، فلا يوجد أي أثر لآخر ظهور بعد أسبوع،
--      ويعود المنشور إلى القمة إن كان مناسبًا للذوق.
--   2) لا يوجد ترتيب على «آخر ظهور» أصلًا: الترتيب مبني على النقاط ثم
--      التنويع، فمنشور شوهد قبل دقائق قد يسبق منشورًا لم يُشاهد أبدًا.
--   3) المخزون قليل، فلا توجد بدائل كافية ليتراجع المحرك عن تكراره.
--
-- الحل هنا: **لا يُعاد كتابة محرك التوصيات**. تُعاد تسمية الدالة المنشورة
-- الحالية إلى aani_get_personalized_reels_relevance كما هي بلا أي تعديل على
-- نقاطها أو إشاراتها أو مصادر مرشحيها، ثم تصبح get_personalized_reels طبقة
-- تدوير رقيقة فوقها:
--   * تقرأ سجل الظهور من public.post_impressions بشرط surface = 'reels' فقط
--     (ظهور الـFeed لا يُحسب ظهورًا في الريلز).
--   * LEFT JOIN مع سجل الظهور دائمًا: المنشور الذي لم يظهر قط لا يُسقط.
--   * ترتّب: غير المعروض > ظهر قبل أكثر من 7 أيام > ظهر قبل أكثر من 24 ساعة
--     > ظهر حديثًا، وداخل كل درجة يبقى ترتيب المحرك (relevance_rank) هو
--     الفاصل، فيُحفظ التنويع بين المؤلفين والأصوات الذي يبنيه المحرك.
--   * لا استبعاد نهائي لأي محتوى: الدرجات الثلاث للتوسع ليست فلاتر بل ترتيبًا،
--     فعند قلة المخزون يعود الأقدم ظهورًا تدريجيًا بدل قائمة فارغة.
--   * الظهور لا يمنح أي نقاط إيجابية ولا يُعدّ إعجابًا؛ التدوير ترتيب فقط،
--     وكل إشارات الذوق تبقى كما يقرأها المحرك الأصلي.
--   * لا تكرار: المحرك يُعيد صفًا واحدًا لكل post_id (row_number على
--     final_ranking)، والطبقة الجديدة تحافظ على ذلك 1:1 عبر LEFT JOIN مع سجل
--     ظهور مجمّع بـ group by post_id — فلا DISTINCT ON ولا ROW_NUMBER إضافي.
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
  v_is_security_definer boolean;
  v_settings text[];
  v_surface_allows_reels boolean;
begin
  if v_function is null then
    raise exception 'aani: public.get_personalized_reels(integer, integer) غير موجودة — أوقف الترحيل.'
      using errcode = '42883';
  end if;

  if v_relevance is not null then
    raise exception 'aani: aani_get_personalized_reels_relevance موجودة سابقًا — يبدو أن هذا الترحيل طُبّق من قبل. أوقف الترحيل.'
      using errcode = '42723';
  end if;

  if to_regclass('public.post_impressions') is null then
    raise exception 'aani: public.post_impressions غير موجود — أوقف الترحيل.'
      using errcode = '42P01';
  end if;

  if to_regclass('public.posts') is null then
    raise exception 'aani: public.posts غير موجود — أوقف الترحيل.'
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
      raise exception 'aani: العمود public.post_impressions.% غير موجود — أوقف الترحيل.', v_column
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
  ) into v_surface_allows_reels;

  if not v_surface_allows_reels then
    raise exception 'aani: قيد surface على public.post_impressions لا يسمح بـ ''reels'' — أوقف الترحيل.'
      using errcode = '23514';
  end if;

  -- المحرك الحالي يجب أن يبقى SECURITY INVOKER وبـ search_path فارغ قبل تغليفه.
  select proc.prosecdef, proc.proconfig
  into v_is_security_definer, v_settings
  from pg_catalog.pg_proc as proc
  where proc.oid = v_function;

  if v_is_security_definer then
    raise exception 'aani: get_personalized_reels ليست SECURITY INVOKER — لا يُغلَّف محرك يتجاوز RLS. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_settings is null
     or not exists (
       select 1
       from unnest(v_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'aani: get_personalized_reels لا تضبط search_path فارغًا — أوقف الترحيل.'
      using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) إعادة تسمية المحرك المنشور بلا أي تغيير في جسمه أو نقاطه أو إشاراته.
--    الصلاحيات و search_path و SECURITY INVOKER تُحفظ مع الكائن نفسه.
-- ---------------------------------------------------------------------
alter function public.get_personalized_reels(integer, integer)
  rename to aani_get_personalized_reels_relevance;

-- ---------------------------------------------------------------------
-- 2) طبقة التدوير: نفس التوقيع ونفس أعمدة الإرجاع تمامًا.
--    ترتيب فقط، بلا أي احتساب نقاط جديد ولا أي استبعاد.
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
    -- نفس مجموعة المرشحين ونفس النقاط والتنويع التي ينتجها محرك V2-B.
    -- صف واحد لكل post_id (المحرك يحسب rank_position بـ row_number).
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
-- 3) الصلاحيات: الطبقتان لـ authenticated فقط، بلا PUBLIC ولا anon ولا تجاوز.
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
-- 4) تحقق بعد التعديل
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
  v_public_or_anon_execute boolean;
  v_authenticated_execute_count integer;
begin
  if v_wrapper is null or v_relevance is null then
    raise exception 'aani: إحدى الدالتين غائبة بعد الترحيل — أوقف الترحيل.'
      using errcode = '42883';
  end if;

  select proc.prosecdef, proc.proconfig
  into v_wrapper_definer, v_wrapper_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_wrapper;

  select proc.prosecdef, proc.proconfig
  into v_relevance_definer, v_relevance_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_relevance;

  if v_wrapper_definer or v_relevance_definer then
    raise exception 'aani: إحدى دالتي الريلز صارت SECURITY DEFINER — أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_wrapper_settings is null
     or not exists (
       select 1 from unnest(v_wrapper_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'aani: get_personalized_reels لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  if v_relevance_settings is null
     or not exists (
       select 1 from unnest(v_relevance_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'aani: aani_get_personalized_reels_relevance لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  -- الطبقة الجديدة تقرأ سجل الظهور بالريلز فقط.
  v_wrapper_definition := pg_get_functiondef(v_wrapper);
  if position('post_impressions' in v_wrapper_definition) = 0
     or position('''reels''' in v_wrapper_definition) = 0 then
    raise exception 'aani: طبقة التدوير لا تقرأ post_impressions بـ surface = ''reels''.'
      using errcode = '42501';
  end if;

  if position('aani_get_personalized_reels_relevance' in v_wrapper_definition) = 0 then
    raise exception 'aani: طبقة التدوير لا تستدعي محرك التوصيات الأصلي.'
      using errcode = '42501';
  end if;

  -- الاستبعاد ممنوع: يجب ألا يوجد استبعاد صريح للريلز في الطبقة الجديدة.
  if position('not exists' in lower(v_wrapper_definition)) > 0
     or position('not in' in lower(v_wrapper_definition)) > 0 then
    raise exception 'aani: طبقة التدوير تحتوي استبعادًا صريحًا — التدوير يجب أن يبقى ترتيبًا فقط.'
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
    raise exception 'aani: إحدى دالتي الريلز ممنوحة لـ PUBLIC أو anon — أوقف الترحيل.'
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
    raise exception 'aani: authenticated لا تملك EXECUTE على دالتي الريلز (% من 2).', v_authenticated_execute_count
      using errcode = '42501';
  end if;

  if to_regprocedure('public.get_personalized_feed(integer,integer)') is null then
    raise notice 'aani: get_personalized_feed(integer, integer) غير موجودة في هذه القاعدة — لم يُمَس أي شيء يخصّها.';
  else
    raise notice 'aani: get_personalized_feed لم تُمسّ بهذا الترحيل.';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- =====================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط، لا يُنفَّذ هنا):
--
-- 1) الطبقة الجديدة وسمات الأمان:
-- select p.proname, p.prosecdef, p.proconfig, p.proacl
-- from pg_catalog.pg_proc p
-- where p.oid in (
--   to_regprocedure('public.get_personalized_reels(integer,integer)'),
--   to_regprocedure('public.aani_get_personalized_reels_relevance(integer,integer)')
-- );
--
-- 2) لا تكرار داخل النتيجة الواحدة:
-- select post_id, count(*) from public.get_personalized_reels(40, 200)
-- group by post_id having count(*) > 1;
--
-- 3) منشور ظهر في الريلز قبل أقل من 24 ساعة لا يسبق منشورًا لم يظهر أبدًا
--    عند تساوي الترتيب المنطقي (تحقق يدوي ببيانات حقيقية):
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
