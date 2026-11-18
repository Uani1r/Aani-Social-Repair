-- =====================================================================
-- اختبار تكامل حقيقي لطبقة تدوير الريلز — قاعدة PostgreSQL اختبارية فقط.
--
-- يُشغّل الترحيلين الفعليين على مخطط اختباري مصغّر ثم يستدعي الدوال الحقيقية:
--   20270213000000_get_personalized_reels_v2b.sql           (المحرك الأصلي)
--   20270223000000_get_personalized_reels_impression_rotation.sql (التدوير)
--
-- التشغيل (قاعدة اختبارية فارغة، ليس الإنتاج ولا Supabase):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f artifacts/aani-social/supabase/tests/reels_rotation_integration.test.sql
--
-- المخطط هنا مصغّر: يحوي فقط الجداول والأعمدة التي يقرأها المحرك، وRLS مبسّطة
-- على posts لمنشورات الحسابات الخاصة. أي قاعدة إنتاج لا تُستخدم.
-- =====================================================================
\set ON_ERROR_STOP on

-- 1) الأدوار التي يتوقعها الترحيلان
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

-- 2) مخطط auth المصغّر: auth.uid() يقرأ claim من إعداد الجلسة
create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated;

-- 3) المخطط المصغّر الذي يقرأه المحرك
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

create table if not exists public.follows (
  follower_id uuid not null,
  following_id uuid not null
);

create table if not exists public.reposts (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.likes (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bookmarks (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.post_shares (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

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

-- 4) صلاحيات القراءة كما في الإنتاج (authenticated فقط للجداول المشاركة)
grant select on public.profiles, public.posts, public.follows, public.reposts,
  public.likes, public.bookmarks, public.post_shares, public.post_feedback,
  public.post_impressions, public.post_view_events
  to authenticated;

-- 5) RLS مبسّطة: المنشورات الخاصة لا تُقرأ (تحاكي حارس الإنتاج)
alter table public.posts enable row level security;
drop policy if exists posts_test_select on public.posts;
create policy posts_test_select
  on public.posts for select to authenticated
  using (coalesce(visibility, 'public') <> 'private');

-- 6) تطبيق الترحيلين الفعليين
\ir ../migrations/20270213000000_get_personalized_reels_v2b.sql
\ir ../migrations/20270223000000_get_personalized_reels_impression_rotation.sql

-- 7) بيانات الاختبار
insert into public.profiles (id, is_private, is_deactivated) values
  ('00000000-0000-4000-8000-0000000000aa', false, false),  -- author A (متابَع)
  ('00000000-0000-4000-8000-0000000000bb', true, false);   -- author B (خاص)

insert into public.follows (follower_id, following_id) values
  ('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000aa');

-- 41 ريلًا من author A، الأقدم (created_at - 2 hours) سيكون صاحب أدنى ترتيب
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
select
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000aa',
  now() - (interval '2 hours') + (g * interval '1 minute'),
  'reel',
  'reels',
  'public',
  'https://example.test/reel-' || g || '.mp4'
from generate_series(1, 41) as g;

-- 40 منها ظهرت قبل 10 دقائق (لم يظهر الأقدم: post 1)
insert into public.post_impressions (event_id, user_id, post_id, surface, content_type, session_id, impression_at)
select
  gen_random_uuid(),
  '00000000-0000-4000-8000-0000000000ff',
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'reels',
  'video',
  gen_random_uuid(),
  now() - interval '10 minutes'
from generate_series(2, 41) as g;

-- منشور خاص من حساب خاص: يجب ألا يصل إلى أي نتيجة
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
values ('00000000-0000-4000-8000-0000000000cc', '00000000-0000-4000-8000-0000000000bb',
        now() - interval '5 minutes', 'reel', 'reels', 'private', 'https://example.test/private.mp4');

insert into public.post_impressions (event_id, user_id, post_id, surface, content_type, session_id, impression_at)
values (gen_random_uuid(), '00000000-0000-4000-8000-0000000000ff',
        '00000000-0000-4000-8000-0000000000cc', 'reels', 'video', gen_random_uuid(),
        now() - interval '10 minutes');

-- 8) الاستدعاء الفعلي بصفة authenticated
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);

create temp table t_engine_40 as
  select * from public.aani_get_personalized_reels_relevance(40, 40);

create temp table t_engine_200 as
  select * from public.aani_get_personalized_reels_relevance(40, 200);

create temp table t_final as
  select * from public.get_personalized_reels(40, 200);

reset role;

-- 9) التأكيدات
do $$
declare
  v_engine_40 integer;
  v_engine_200 integer;
  v_final integer;
  v_unseen uuid := '00000000-0000-4000-8000-000000000001';
  v_private uuid := '00000000-0000-4000-8000-0000000000cc';
  v_unseen_rank integer;
  v_duplicates integer;
begin
  select count(*) into v_engine_40 from t_engine_40;
  select count(*) into v_engine_200 from t_engine_200;
  select count(*) into v_final from t_final;

  -- المحرك الداخلي يصل إلى كامل المرشحين عند الطلب، ويقصّ على 40 عند طلبه
  if v_engine_40 <> 40 then
    raise exception 'assert: المحرك بسقف 40 يجب أن يُعيد 40، وجدنا %', v_engine_40;
  end if;
  if v_engine_200 < 41 then
    raise exception 'assert: المحرك يجب أن يُعيد 41 مرشحًا أو أكثر عند p_candidate_limit=200، وجدنا %', v_engine_200;
  end if;

  -- الريل غير المشاهد (أدنى ترتيب في المحرك) غائب عن سقف 40 وحاضر في 200
  if exists (select 1 from t_engine_40 where post_id = v_unseen) then
    raise exception 'assert: غير المشاهد يجب ألا يظهر ضمن أول 40 مرشحًا من المحرك.';
  end if;
  select rank_position into v_unseen_rank
    from t_engine_200 where post_id = v_unseen;
  if v_unseen_rank is null or v_unseen_rank <= 40 then
    raise exception 'assert: غير المشاهد يجب أن يكون بعد المرتبة 40 في المحرك، وجدنا %.', v_unseen_rank;
  end if;

  -- طبقة التدوير: 40 صفًا، وغير المشاهد يدخلها ويتصدّرها
  if v_final <> 40 then
    raise exception 'assert: النتيجة النهائية يجب أن تكون 40، وجدنا %', v_final;
  end if;
  if not exists (select 1 from t_final where post_id = v_unseen and rank_position = 1) then
    raise exception 'assert: الريل غير المشاهد يجب أن يتصدّر نتيجة التدوير.';
  end if;

  -- الخصوصية: المنشور الخاص لا يظهر في أي نتيجة
  if exists (select 1 from t_final where post_id = v_private)
     or exists (select 1 from t_engine_200 where post_id = v_private) then
    raise exception 'assert: منشور خاص ظهر في نتيجة الريلز.';
  end if;

  -- لا تكرار
  select count(*) into v_duplicates
  from (select post_id from t_final group by post_id having count(*) > 1) as duplicated;
  if v_duplicates <> 0 then
    raise exception 'assert: النتيجة تحتوي % معرفًا مكررًا.', v_duplicates;
  end if;
end $$;

raise notice 'reels rotation integration test: OK';
