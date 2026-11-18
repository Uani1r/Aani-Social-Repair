-- =====================================================================
-- اختبار منطق ترتيب مرشحي الريلز (تدوير الظهور) — PostgreSQL اختباري فقط.
--
-- التشغيل (قاعدة اختبارية فارغة، ليس الإنتاج):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f artifacts/aani-social/supabase/tests/reels_rotation_pool.test.sql
--
-- لا يلمس أي جدول حقيقي: ينشئ جداول مؤقتة تحاكي خرج المحرك (relevance_rank)
-- وسجل الظهور (post_impressions)، ويطبّق نفس تعبير الترتيب المستخدم في طبقة
-- التدوير، ثم يؤكد النتائج بـ assert داخلي (raise exception عند الفشل).
--
-- الحالة المحورية المطلوبة:
--   40 ريلًا ظهرت مؤخرًا في المراتب 1..40 من ترتيب المحرك، وريل واحد لم يظهر
--   قط في المرتبة 41. عند طلب 40 ريلًا يجب أن يدخل غير المشاهد في النتيجة
--   وأن يتقدّم على المراتب الأولى التي ظهرت مؤخرًا.
-- =====================================================================
begin;

create temp table t_relevance (
  post_id uuid primary key,
  relevance_rank integer not null
) on commit drop;

create temp table t_impressions (
  post_id uuid not null,
  last_at timestamptz not null
) on commit drop;

-- 40 ريلًا ظهرت قبل 10 دقائق، مراتب 1..40
insert into t_relevance (post_id, relevance_rank)
select gen_random_uuid(), position
from generate_series(1, 40) as position;

insert into t_impressions (post_id, last_at)
select post_id, now() - interval '10 minutes'
from t_relevance;

-- الريل غير المشاهد: المرتبة 41 في ترتيب المحرك الأصلي (كان يُقصّ قبل أي تدوير)
insert into t_relevance (post_id, relevance_rank)
values ('00000000-0000-4000-8000-000000000041', 41);

-- ريل ظهر قبل 3 ساعات (الدرجة 2) وريل ظهر قبل 8 أيام (الدرجة 1)
insert into t_relevance (post_id, relevance_rank)
values ('00000000-0000-4000-8000-000000000042', 42),
       ('00000000-0000-4000-8000-000000000043', 43);

insert into t_impressions (post_id, last_at)
values ('00000000-0000-4000-8000-000000000042', now() - interval '3 hours'),
       ('00000000-0000-4000-8000-000000000043', now() - interval '8 days');

-- نفس تعبير طبقة التدوير: LEFT JOIN بالسجل، درجة الظهور، الترتيب، ثم الحد.
create temp table t_rotated on commit drop as
with reel_impression_history as (
  select
    impression.post_id,
    max(impression.last_at) as last_reel_impression_at
  from t_impressions as impression
  group by impression.post_id
),
rotation_inputs as (
  select
    relevance.post_id,
    relevance.relevance_rank,
    history.last_reel_impression_at,
    case
      when history.last_reel_impression_at is null then 0
      when history.last_reel_impression_at < now() - interval '7 days' then 1
      when history.last_reel_impression_at < now() - interval '24 hours' then 2
      else 3
    end as impression_priority
  from t_relevance as relevance
  left join reel_impression_history as history on history.post_id = relevance.post_id
),
rotated as (
  select
    rotation_inputs.*,
    row_number() over (
      order by
        rotation_inputs.impression_priority asc,
        rotation_inputs.last_reel_impression_at asc nulls first,
        rotation_inputs.relevance_rank asc,
        rotation_inputs.post_id asc
    )::integer as rotation_rank
  from rotation_inputs
)
select rotated.post_id, rotated.rotation_rank, rotated.impression_priority,
       rotated.last_reel_impression_at, rotated.relevance_rank
from rotated
where rotated.rotation_rank <= 40;

-- ---------------------------------------------------------------------
-- 1) المرشح غير المشاهد (المرتبة 41) يدخل النتيجة ويتصدّرها
-- =====================================================================
do $$
declare
  v_first uuid;
  v_unseen_rank integer;
  v_count integer;
begin
  select count(*) into v_count from t_rotated;
  if v_count <> 40 then
    raise exception 'assert: النتيجة يجب أن تكون 40 ريلًا، وجدنا %', v_count;
  end if;

  select post_id into v_first
  from t_rotated
  where rotation_rank = 1;

  if v_first is distinct from '00000000-0000-4000-8000-000000000041'::uuid then
    raise exception 'assert: غير المشاهد (المرتبة 41 في المحرك) يجب أن يتصدّر النتيجة، وجدنا %', v_first;
  end if;

  select relevance_rank into v_unseen_rank
  from t_rotated
  where post_id = '00000000-0000-4000-8000-000000000041'::uuid;

  if v_unseen_rank is null or v_unseen_rank <> 41 then
    raise exception 'assert: سجل غير المشاهد مفقود من النتيجة (relevance_rank=%).', v_unseen_rank;
  end if;

  if exists (
    select 1 from t_rotated
    where post_id <> '00000000-0000-4000-8000-000000000041'::uuid
      and rotation_rank <= 1
  ) then
    raise exception 'assert: غير المشاهد لم يتصدّر فعليًا.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) درجات التوسع: غير المشاهد (0) ثم الأقدم ظهورًا (1) ثم (2) ثم الحديث (3)
-- =====================================================================
do $$
declare
  v_priority_unseen integer;
  v_priority_old integer;
  v_priority_mid integer;
  v_priority_recent integer;
begin
  select impression_priority into v_priority_unseen
  from t_rotated where post_id = '00000000-0000-4000-8000-000000000041'::uuid;
  select impression_priority into v_priority_old
  from t_rotated where post_id = '00000000-0000-4000-8000-000000000043'::uuid;
  select impression_priority into v_priority_mid
  from t_rotated where post_id = '00000000-0000-4000-8000-000000000042'::uuid;
  select impression_priority into v_priority_recent
  from t_rotated where relevance_rank = 1;

  if v_priority_unseen <> 0 then
    raise exception 'assert: غير المشاهد يجب أن يكون priority=0 (وجدنا %).', v_priority_unseen;
  end if;
  if v_priority_old is not null and v_priority_old <> 1 then
    raise exception 'assert: ظهور قبل 8 أيام يجب أن يكون priority=1 (وجدنا %).', v_priority_old;
  end if;
  if v_priority_mid is not null and v_priority_mid <> 2 then
    raise exception 'assert: ظهور قبل 3 ساعات يجب أن يكون priority=2 (وجدنا %).', v_priority_mid;
  end if;
  if v_priority_recent <> 3 then
    raise exception 'assert: ظهور قبل 10 دقائق يجب أن يكون priority=3 (وجدنا %).', v_priority_recent;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) الحالة المعاكسة: قصّ المرشحين إلى 40 قبل التدوير (الخطأ الأصلي)
--    يجعل الريل غير المشاهد غائبًا تمامًا.
-- =====================================================================
do $$
declare
  v_old_behaviour_count integer;
begin
  select count(*) into v_old_behaviour_count
  from t_relevance
  where relevance_rank <= 40
    and post_id = '00000000-0000-4000-8000-000000000041'::uuid;

  if v_old_behaviour_count <> 0 then
    raise exception 'assert: القصّ على 40 كان يجب أن يُسقط غير المشاهد.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) لا تكرار في معرفات المنشورات داخل النتيجة
-- =====================================================================
do $$
declare
  v_duplicates integer;
begin
  select count(*) into v_duplicates
  from (
    select post_id from t_rotated group by post_id having count(*) > 1
  ) as duplicated;

  if v_duplicates <> 0 then
    raise exception 'assert: النتيجة تحتوي % معرفًا مكررًا.', v_duplicates;
  end if;
end $$;

raise notice 'reels rotation pool test: OK';
rollback;
