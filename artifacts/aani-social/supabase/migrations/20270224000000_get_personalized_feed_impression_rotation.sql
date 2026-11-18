-- =====================================================================
-- Aani Feed — تدوير واعٍ بالظهور السابق فوق محرك الرئيسية الحالي
-- public.get_personalized_feed(p_limit, p_candidate_limit)
--
-- الحالة: لم يُنفَّذ على أي قاعدة بيانات. يُطبَّق يدويًا بعد المراجعة.
--
-- المشكلة: محرك 20270210000000 يقرأ الظهور من post_impressions لسطح 'feed'
-- (إشارة تشبّع صغيرة) لكنه لا يرتّب على «آخر ظهور»، ويقصّ نتيجة الترتيب على
-- v_limit = 40 قبل أي طبقة أعلى، فلا يمكن إعادة منشور قديم بعيد المدى أو
-- إظهار ما لم يُشاهد إن لم يكن في أول 40.
--
-- الحل (بنفس مبدأ تدوير الريلز في 20270223000000، وبمسار مستقل تمامًا):
--   * تُعاد تسمية محرك Feed المنشور إلى aani_get_personalized_feed_relevance
--     ويُغيَّر فيه شيء واحد فقط: القصّ النهائي على v_candidates (سقف المرشحين
--     من p_candidate_limit بحد 160) بدل v_limit. كل النقاط والوزنات والحصص
--     والتنويع وإشارات الإعجاب والحفظ والمشاركة والمشاهدة والإكمال والتخطي
--     والتفاعل تبقى كما هي حرفيًا.
--   * تصبح get_personalized_feed طبقة تدوير تقرأ كامل المرشحين، تربطهم بسجل
--     الظهور في post_impressions بشرط surface = 'feed' **فقط**، وترتّب:
--     لم يظهر قط ← ظهر قبل أكثر من 7 أيام ← ظهر قبل أكثر من 24 ساعة ← ظهر
--     حديثًا، مع الحفاظ على ترتيب المحرك (relevance_rank) داخل كل درجة،
--     وتُعيد أول p_limit فقط.
--   * الظهور لا يمنح أي نقاط إيجابية: التدوير ترتيب فقط.
--   * LEFT JOIN مع سجل الظهور: منشور لم يظهر قط لا يُسقط.
--   * إعادة تسمية المحرك والحفاظ على شرط فصل الوجهات
--     coalesce(post.destination, 'feed') = 'feed' في مصادره الثلاثة.
--   * الأمان: الطبقتان SECURITY INVOKER و search_path = ''، و EXECUTE إلى
--     authenticated فقط. لا SECURITY DEFINER ولا تجاوز لـ RLS.
--   * لا تغيير في Reels ولا في التصميم ولا جداول/سياسات/فهارس القاعدة.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0) شروط مسبقة: يفشل الترحيل إن تغيّرت افتراضات أساسية
-- ---------------------------------------------------------------------
do $$
declare
  v_function oid := to_regprocedure('public.get_personalized_feed(integer,integer)');
  v_relevance oid := to_regprocedure('public.aani_get_personalized_feed_relevance(integer,integer)');
  v_required_columns text[] := array['user_id', 'post_id', 'surface', 'impression_at'];
  v_column text;
  v_is_security_invoker boolean;
  v_settings text[];
  v_surface_allows_feed boolean;
  v_definition text;
begin
  if v_function is null then
    raise exception 'public.get_personalized_feed(integer, integer) غير موجودة. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  if v_relevance is not null then
    raise exception 'aani_get_personalized_feed_relevance موجودة سابقًا؛ يبدو أن هذا الترحيل طُبّق من قبل. أوقف الترحيل.'
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

  -- السطح 'feed' مسموح في قيد الجدول.
  select exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.post_impressions'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) ilike '%surface%'
      and pg_get_constraintdef(constraint_row.oid) ilike '%feed%'
  ) into v_surface_allows_feed;

  if not v_surface_allows_feed then
    raise exception 'قيد surface على public.post_impressions لا يسمح بـ ''feed''. أوقف الترحيل.'
      using errcode = '23514';
  end if;

  -- المحرك الحالي SECURITY INVOKER وبـ search_path فارغ.
  select not proc.prosecdef, proc.proconfig
  into v_is_security_invoker, v_settings
  from pg_catalog.pg_proc as proc
  where proc.oid = v_function;

  if not coalesce(v_is_security_invoker, false) then
    raise exception 'get_personalized_feed ليست SECURITY INVOKER؛ لا يُغلَّف محرك يتجاوز RLS. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_settings is null
     or not exists (
       select 1
       from unnest(v_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'get_personalized_feed لا تضبط search_path فارغًا. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  -- الافتراض الأساسي: القصّ النهائي على v_limit، وشرط فصل الوجهات موجود.
  v_definition := pg_get_functiondef(v_function);
  if position('where final_ranking.rank_position <= v_limit' in v_definition) = 0 then
    raise exception 'جسم get_personalized_feed لا يطابق المحرك المتوقع (القصّ على v_limit). أوقف الترحيل.'
      using errcode = '42804';
  end if;

  if position('coalesce(post.destination, ''feed'') = ''feed''' in v_definition) = 0 then
    raise exception 'شرط فصل الوجهات coalesce(post.destination, ''feed'') = ''feed'' غير موجود في المحرك. أوقف الترحيل.'
      using errcode = '42804';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) إعادة تسمية المحرك المنشور (تُحفظ الصلاحيات و search_path و INVOKER).
-- ---------------------------------------------------------------------
alter function public.get_personalized_feed(integer, integer)
  rename to aani_get_personalized_feed_relevance;

-- ---------------------------------------------------------------------
-- 2) توسيع سقف المحرك الداخلي: القصّ على v_candidates (سقف المرشحين من
--    p_candidate_limit، بحد 160 كما في المحرك الأصلي) بدل v_limit (40).
--    تغيير واحد في الجسم، مع تحقق قبل التنفيذ وبعده.
-- ---------------------------------------------------------------------
do $$
declare
  v_relevance oid := to_regprocedure('public.aani_get_personalized_feed_relevance(integer,integer)');
  v_definition text;
  v_old_filter constant text := 'where final_ranking.rank_position <= v_limit';
  v_new_filter constant text := 'where final_ranking.rank_position <= v_candidates';
begin
  if v_relevance is null then
    raise exception 'aani_get_personalized_feed_relevance غير موجودة بعد إعادة التسمية. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  v_definition := pg_get_functiondef(v_relevance);

  if position(v_old_filter in v_definition) = 0 then
    raise exception 'لم يُعثر على نص القصّ المتوقع في المحرك الداخلي. أوقف الترحيل دون تغيير.'
      using errcode = '42804';
  end if;

  v_definition := replace(v_definition, v_old_filter, v_new_filter);

  if position(v_new_filter in v_definition) = 0 then
    raise exception 'فشل استبدال القصّ في المحرك الداخلي. أوقف الترحيل دون تغيير.'
      using errcode = '42804';
  end if;

  -- تنفيذ التعريف المعدّل: CREATE OR REPLACE يحفظ الملكية والصلاحيات.
  execute v_definition;
end $$;

-- ---------------------------------------------------------------------
-- 3) طبقة التدوير: نفس التوقيع وأعمدة الإرجاع الأربعة تمامًا.
--    ترتيب فقط، بلا أي احتساب نقاط جديد ولا أي استبعاد.
-- ---------------------------------------------------------------------
create or replace function public.get_personalized_feed(
  p_limit integer default 20,
  p_candidate_limit integer default 80
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
    -- كامل مجموعة مرشحي Feed من المحرك (حتى 160) بترتيب التوصيات والتنويع.
    select
      ranked.post_id,
      ranked.reposter_id,
      ranked.reposted_at,
      ranked.rank_position as relevance_rank
    from public.aani_get_personalized_feed_relevance(p_limit, p_candidate_limit) as ranked
  ),
  feed_impression_history as (
    -- سجل الظهور في Feed فقط. انطباعات Reels (surface = 'reels') لا تُقرأ هنا
    -- إطلاقًا، فلا تتسرب بين السطحين.
    select
      impression.post_id,
      max(impression.impression_at) as last_feed_impression_at,
      count(*)::integer as feed_impression_count
    from public.post_impressions as impression
    where impression.user_id = auth.uid()
      and impression.surface = 'feed'
      and impression.post_id in (select relevance.post_id from relevance)
    group by impression.post_id
  ),
  rotation_inputs as (
    select
      relevance.post_id,
      relevance.reposter_id,
      relevance.reposted_at,
      relevance.relevance_rank,
      history.last_feed_impression_at,
      coalesce(history.feed_impression_count, 0) as feed_impression_count,
      -- 0 = لم يظهر قط، 1 = ظهر قبل أكثر من 7 أيام، 2 = قبل أكثر من 24 ساعة،
      -- 3 = ظهر خلال آخر 24 ساعة. الظهور ليس إعجابًا ولا إشارة إيجابية.
      case
        when history.last_feed_impression_at is null then 0
        when history.last_feed_impression_at < now() - interval '7 days' then 1
        when history.last_feed_impression_at < now() - interval '24 hours' then 2
        else 3
      end as impression_priority
    from relevance
    -- LEFT JOIN مقصود: منشور لم يظهر قط لا يملك صفًا في السجل ويجب أن يبقى.
    left join feed_impression_history as history on history.post_id = relevance.post_id
  ),
  rotated as (
    select
      rotation_inputs.*,
      row_number() over (
        order by
          rotation_inputs.impression_priority asc,
          rotation_inputs.last_feed_impression_at asc nulls first,
          -- داخل الدرجة نفسها يبقى ترتيب المحرك هو الفاصل، فيُحفظ التنويع
          -- بين المؤلفين وكل أوزان التوصية.
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
-- 4) الصلاحيات: الطبقتان لـ authenticated فقط.
-- ---------------------------------------------------------------------
revoke all on function public.get_personalized_feed(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_personalized_feed(integer, integer)
  to authenticated;

revoke all on function public.aani_get_personalized_feed_relevance(integer, integer)
  from public, anon, service_role;
grant execute on function public.aani_get_personalized_feed_relevance(integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5) تحقق بعد التعديل
-- ---------------------------------------------------------------------
do $$
declare
  v_wrapper oid := to_regprocedure('public.get_personalized_feed(integer,integer)');
  v_relevance oid := to_regprocedure('public.aani_get_personalized_feed_relevance(integer,integer)');
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
    raise exception 'إحدى دالتي Feed غائبة بعد الترحيل. أوقف الترحيل.'
      using errcode = '42883';
  end if;

  select proc.prosecdef, proc.proconfig
  into v_wrapper_definer, v_wrapper_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_wrapper;

  select proc.prosecdef, proc.proconfig
  into v_relevance_definer, v_relevance_settings
  from pg_catalog.pg_proc as proc where proc.oid = v_relevance;

  if v_wrapper_definer or v_relevance_definer then
    raise exception 'إحدى دالتي Feed صارت SECURITY DEFINER. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  if v_wrapper_settings is null
     or not exists (
       select 1 from unnest(v_wrapper_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'get_personalized_feed لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  if v_relevance_settings is null
     or not exists (
       select 1 from unnest(v_relevance_settings) as setting
       where setting like 'search_path=%'
         and btrim(btrim(substr(setting, length('search_path=') + 1)), '"''') = ''
     ) then
    raise exception 'aani_get_personalized_feed_relevance لا تضبط search_path فارغًا.'
      using errcode = '42501';
  end if;

  v_relevance_definition := pg_get_functiondef(v_relevance);
  if position('final_ranking.rank_position <= v_candidates' in v_relevance_definition) = 0 then
    raise exception 'المحرك الداخلي لـ Feed لا يقصّ على v_candidates.'
      using errcode = '42501';
  end if;
  if position('final_ranking.rank_position <= v_limit' in v_relevance_definition) > 0 then
    raise exception 'المحرك الداخلي لـ Feed ما زال يقصّ على v_limit. أوقف الترحيل.'
      using errcode = '42501';
  end if;
  if position('coalesce(post.destination, ''feed'') = ''feed''' in v_relevance_definition) = 0 then
    raise exception 'شرط فصل الوجهات غاب من المحرك الداخلي. أوقف الترحيل.'
      using errcode = '42501';
  end if;

  v_wrapper_definition := pg_get_functiondef(v_wrapper);
  if position('post_impressions' in v_wrapper_definition) = 0
     or position('''feed''' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تقرأ post_impressions بـ surface = ''feed''.'
      using errcode = '42501';
  end if;

  -- حارس عدم التسرب: طبقة Feed لا يجب أن تذكر سطح الريلز إطلاقًا.
  if position('''reels''' in v_wrapper_definition) > 0 then
    raise exception 'طبقة تدوير Feed تشير إلى سطح ''reels'' — تسرب بين السطحين.'
      using errcode = '42501';
  end if;

  if position('aani_get_personalized_feed_relevance' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تستدعي محرك Feed الأصلي.'
      using errcode = '42501';
  end if;

  if position('rotation_inputs.relevance_rank asc' in v_wrapper_definition) = 0 then
    raise exception 'طبقة التدوير لا تحفظ ترتيب المحرك داخل درجات الظهور.'
      using errcode = '42501';
  end if;

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
    raise exception 'إحدى دالتي Feed ممنوحة لـ PUBLIC أو anon. أوقف الترحيل.'
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
    raise exception 'authenticated لا تملك EXECUTE على دالتي Feed (% من 2).', v_authenticated_execute_count
      using errcode = '42501';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- =====================================================================
-- تحقق يدوي اختياري بعد التطبيق (قراءة فقط، لا يُنفَّذ هنا):
--
-- 1) المحرك الداخلي يرى كامل المرشحين (حتى 160) لا 40:
-- select count(*) from public.aani_get_personalized_feed_relevance(40, 160);
--
-- 2) الطبقة تُعيد 40 على الأكثر:
-- select count(*) from public.get_personalized_feed(40, 160);
--
-- 3) لا تكرار:
-- select post_id, count(*) from public.get_personalized_feed(40, 160)
-- group by post_id having count(*) > 1;
--
-- 4) أثر التدوير (feed فقط):
-- select r.rank_position, r.post_id, i.last_feed_impression_at
-- from public.get_personalized_feed(40, 160) as r
-- left join (
--   select post_id, max(impression_at) as last_feed_impression_at
--   from public.post_impressions
--   where user_id = auth.uid() and surface = 'feed'
--   group by post_id
-- ) as i on i.post_id = r.post_id
-- order by r.rank_position;
-- =====================================================================
