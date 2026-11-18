-- =====================================================================
-- اختبار تكامل حقيقي لطبقة تدوير Feed — قاعدة PostgreSQL اختبارية فقط.
--
-- يُشغّل الترحيلين الفعليين على مخطط اختباري مصغّر ثم يستدعي الدوال الحقيقية:
--   20270210000000_get_personalized_feed.sql                  (المحرك الأصلي)
--   20270224000000_get_personalized_feed_impression_rotation.sql (التدوير)
--
-- التشغيل (قاعدة اختبارية فارغة، ليس الإنتاج ولا Supabase):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f artifacts/aani-social/supabase/tests/feed_rotation_integration.test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- 1) الأدوار التي يتوقعها الترحيلان
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- 2) مخطط auth المصغّر
create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;

-- 3) المخطط المصغّر الذي يقرأه محرك Feed
create table if not exists public.profiles (
  id uuid primary key,
  is_private boolean not null default false,
  is_deactivated boolean not null default false
);

create table if not exists public.posts (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  type text,
  destination text,
  visibility text,
  media_url text,
  media_urls text[],
  sound_id uuid,
  likes_count integer,
  comments_count integer,
  reposts_count integer,
  shares_count integer
);

create table if not exists public.follows (follower_id uuid not null, following_id uuid not null);
create table if not exists public.reposts (post_id uuid not null, user_id uuid not null, created_at timestamptz not null default now());
create table if not exists public.likes (post_id uuid not null, user_id uuid not null, created_at timestamptz not null default now());
create table if not exists public.bookmarks (post_id uuid not null, user_id uuid not null, created_at timestamptz not null default now());
create table if not exists public.post_shares (post_id uuid not null, user_id uuid not null, created_at timestamptz not null default now());

create table if not exists public.post_feedback (
  post_id uuid not null,
  user_id uuid not null,
  feedback text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.post_impressions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  user_id uuid not null,
  post_id uuid not null,
  surface text not null check (surface in ('feed', 'reels')),
  content_type text not null check (content_type in ('text', 'image', 'video')),
  session_id uuid not null,
  impression_at timestamptz not null default now()
);

create table if not exists public.post_view_events (
  event_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  post_id uuid not null,
  surface text not null,
  content_type text not null,
  session_id uuid,
  visible_duration_ms integer default 0,
  played_duration_ms integer default 0,
  media_duration_ms integer,
  completion_ratio numeric(6,5),
  replay_count integer default 0,
  early_skip boolean default false,
  event_at timestamptz not null default now()
);

grant select on public.profiles, public.posts, public.follows, public.reposts,
  public.likes, public.bookmarks, public.post_shares, public.post_feedback,
  public.post_impressions, public.post_view_events
  to authenticated;

-- 4) RLS مبسّطة: المنشورات الخاصة لا تُقرأ
alter table public.posts enable row level security;
drop policy if exists posts_test_select on public.posts;
create policy posts_test_select
  on public.posts for select to authenticated
  using (coalesce(visibility, 'public') <> 'private');

-- 5) تطبيق الترحيلين الفعليين
\ir ../migrations/20270210000000_get_personalized_feed.sql
\ir ../migrations/20270224000000_get_personalized_feed_impression_rotation.sql

-- 6) بيانات الاختبار — موزّعة على مصادر Feed الثلاثة (50% متابعات، 35% اكتشاف، 15% إعادات نشر)
insert into public.profiles (id, is_private, is_deactivated) values
  ('00000000-0000-4000-8000-0000000000aa', false, false),  -- author A (متابَع)
  ('00000000-0000-4000-8000-0000000000bb', false, false),  -- author B (اكتشاف)
  ('00000000-0000-4000-8000-0000000000dd', true, false);   -- author D (حساب خاص)

insert into public.follows (follower_id, following_id) values
  ('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000aa');

-- المتابعات: 8 منشورات حديثة من A
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
select
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000aa',
  now() - (g * interval '1 hour'),
  'photo', 'feed', 'public', 'https://example.test/feed-a-' || g || '.jpg'
from generate_series(1, 8) as g;

-- الاكتشاف: 44 حديثة من B + واحدة قديمة (قبل 100 يوم) هي المنشور غير المشاهد (101)
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
select
  ('00000000-0000-4000-8000-' || lpad((100 + g)::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000bb',
  case when g = 1 then now() - interval '100 days' else now() - (g * interval '1 hour') end,
  'photo', 'feed', 'public', 'https://example.test/feed-b-' || g || '.jpg'
from generate_series(1, 45) as g;

-- إعادة النشر: منشوران قبل 200+ يوم أعادهما المستخدم الحالي
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
values
  ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000bb',
   now() - interval '200 days', 'photo', 'feed', 'public', 'https://example.test/repost-1.jpg'),
  ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-0000000000aa',
   now() - interval '210 days', 'photo', 'feed', 'public', 'https://example.test/repost-2.jpg');

insert into public.reposts (post_id, user_id, created_at) values
  ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000ff', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-0000000000ff', now() - interval '2 hours');

-- انطباعات Feed: كل المرشحين عدا غير المشاهد (101)
insert into public.post_impressions (event_id, user_id, post_id, surface, content_type, session_id, impression_at)
select gen_random_uuid(), '00000000-0000-4000-8000-0000000000ff', seen.post_id,
       'feed', 'image', gen_random_uuid(), now() - interval '10 minutes'
from (
  select post_id from public.posts
  where user_id in ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb')
    and id <> '00000000-0000-4000-8000-000000000101'::uuid
) as seen;

-- تسرّب السطح: للمنشور غير المشاهد انطباع Reels فقط. لو تسرّب إلى Feed
-- لصار priority=3 ولما تصدّر النتيجة.
insert into public.post_impressions (event_id, user_id, post_id, surface, content_type, session_id, impression_at)
values (gen_random_uuid(), '00000000-0000-4000-8000-0000000000ff',
        '00000000-0000-4000-8000-000000000101', 'reels', 'video', gen_random_uuid(),
        now() - interval '5 minutes');

-- منشور خاص من حساب خاص: يجب ألا يصل إلى أي نتيجة
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
values ('00000000-0000-4000-8000-0000000000cc', '00000000-0000-4000-8000-0000000000dd',
        now() - interval '5 minutes', 'photo', 'feed', 'private', 'https://example.test/private.jpg');

-- 7) الاستدعاء الفعلي بصفة authenticated
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);

create temp table t_engine_40 as
  select * from aani_internal.aani_get_personalized_feed_relevance(40, 40);

create temp table t_engine_160 as
  select * from aani_internal.aani_get_personalized_feed_relevance(40, 160);

create temp table t_final as
  select * from public.get_personalized_feed(40, 160);

reset role;

-- 8) التأكيدات
do $$
declare
  v_engine_40 integer;
  v_engine_160 integer;
  v_final integer;
  v_unseen uuid := '00000000-0000-4000-8000-000000000101';
  v_private uuid := '00000000-0000-4000-8000-0000000000cc';
  v_unseen_rank integer;
  v_duplicates integer;
  v_wrapper_definition text;
  v_inner_definition text;
begin
  select count(*) into v_engine_40 from t_engine_40;
  select count(*) into v_engine_160 from t_engine_160;
  select count(*) into v_final from t_final;

  -- المحرك لا يتجاوز سقفه، وسقف 160 يرى مرشحين أكثر من سقف 40
  if v_engine_40 > 40 then
    raise exception 'assert: محرك Feed بسقف 40 يجب ألا يتجاوز 40، وجدنا %', v_engine_40;
  end if;
  if v_engine_40 = 0 then
    raise exception 'assert: محرك Feed بسقف 40 يجب أن يُعيد مرشحين، وجدنا 0.';
  end if;
  if v_engine_160 <= v_engine_40 then
    raise exception 'assert: سقف 160 يجب أن يرى مرشحين أكثر من سقف 40 (% مقابل %).', v_engine_160, v_engine_40;
  end if;

  -- المنشور غير المشاهد: غائب عن سقف 40، حاضر في 160، وبعد المرتبة 40
  if exists (select 1 from t_engine_40 where post_id = v_unseen) then
    raise exception 'assert: المنشور غير المشاهد يجب ألا يظهر ضمن أول 40 مرشحًا من المحرك.';
  end if;
  select rank_position into v_unseen_rank
    from t_engine_160 where post_id = v_unseen;
  if v_unseen_rank is null or v_unseen_rank <= 40 then
    raise exception 'assert: غير المشاهد يجب أن يكون بعد المرتبة 40 في المحرك، وجدنا %.', v_unseen_rank;
  end if;

  -- الطبقة: 40 صفًا، وغير المشاهد يتصدّرها (انطباع Reels لم يُحسب ظهورًا في Feed)
  if v_final <> 40 then
    raise exception 'assert: نتيجة التدوير يجب أن تكون 40، وجدنا %', v_final;
  end if;
  if not exists (select 1 from t_final where post_id = v_unseen and rank_position = 1) then
    raise exception 'assert: المنشور غير المشاهد يجب أن يتصدّر نتيجة تدوير Feed.';
  end if;

  -- الخصوصية
  if exists (select 1 from t_final where post_id = v_private)
     or exists (select 1 from t_engine_160 where post_id = v_private) then
    raise exception 'assert: منشور خاص ظهر في نتيجة Feed.';
  end if;

  -- لا تكرار
  select count(*) into v_duplicates
  from (select post_id from t_final group by post_id having count(*) > 1) as duplicated;
  if v_duplicates <> 0 then
    raise exception 'assert: النتيجة تحتوي % معرفًا مكررًا.', v_duplicates;
  end if;

  -- حارس Surface: طبقة Feed لا تذكر 'reels'، وتقرأ 'feed' فقط
  v_wrapper_definition := pg_get_functiondef(
    'public.get_personalized_feed(integer,integer)'::regprocedure
  );
  if position('''reels''' in v_wrapper_definition) > 0 then
    raise exception 'assert: طبقة Feed تشير إلى سطح reels — تسرب بين السطحين.';
  end if;
  if position('''feed''' in v_wrapper_definition) = 0 then
    raise exception 'assert: طبقة Feed لا تقرأ surface = ''feed''.';
  end if;

  -- الدالة الداخلية خارج public (غير مكشوفة عبر PostgREST) وفي aani_internal
  if to_regprocedure('public.aani_get_personalized_feed_relevance(integer,integer)') is not null then
    raise exception 'assert: الدالة الداخلية ما زالت مكشوفة في public.';
  end if;
  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'aani_internal'
      and proc.proname = 'aani_get_personalized_feed_relevance'
  ) then
    raise exception 'assert: الدالة الداخلية غير موجودة في aani_internal.';
  end if;

  -- إشارة الظهور داخل المحرك مقيدة بـ surface = 'feed'
  v_inner_definition := pg_get_functiondef(
    'aani_internal.aani_get_personalized_feed_relevance(integer,integer)'::regprocedure
  );
  if position('impression.surface = ''feed''' in v_inner_definition) = 0 then
    raise exception 'assert: إشارة post_impressions في المحرك غير مقيدة بـ surface = ''feed''.';
  end if;
  if position('180 days' in v_inner_definition) = 0
     or position('365 days' in v_inner_definition) = 0 then
    raise exception 'assert: نوافذ المصادر في المحرك غير موسّعة تدريجيًا.';
  end if;
end $$;

raise notice 'feed rotation integration test: OK';
