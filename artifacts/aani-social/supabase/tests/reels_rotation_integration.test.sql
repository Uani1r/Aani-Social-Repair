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

-- 7) بيانات الاختبار — موزّعة على المصادر الثلاثة بما يوافق حصص المحرك
--    (40% متابعات، 40% اكتشاف، 20% إعادات نشر)، حتى لا يكون العدد النهائي
--    رهينة لمصدر واحد.
insert into public.profiles (id, is_private, is_deactivated) values
  ('00000000-0000-4000-8000-0000000000aa', false, false),  -- author A (متابَع)
  ('00000000-0000-4000-8000-0000000000bb', false, false),  -- author B (اكتشاف)
  ('00000000-0000-4000-8000-0000000000dd', true, false);   -- author D (حساب خاص)

insert into public.follows (follower_id, following_id) values
  ('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000aa');

-- مصدر المتابعات: 10 ريلز حديثة من author A (داخل نافذة 30 يومًا)
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
select
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000aa',
  now() - (g * interval '1 hour'),
  'reel',
  'reels',
  'public',
  'https://example.test/reel-a-' || g || '.mp4'
from generate_series(1, 10) as g;

-- مصدر الاكتشاف: 44 ريلز حديثة من author B، وواحد قديم (قبل 100 يوم) هو
-- الريل غير المشاهد. author_position له = 45، فيقع بعد المرتبة 40 حتمًا.
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
select
  ('00000000-0000-4000-8000-' || lpad((100 + g)::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000bb',
  case when g = 1 then now() - interval '100 days' else now() - (g * interval '1 hour') end,
  'reel',
  'reels',
  'public',
  'https://example.test/reel-b-' || g || '.mp4'
from generate_series(1, 45) as g;

-- مصدر إعادة النشر: منشوران قبل 200 يوم (لا يغطيهما الاكتشاف 180 يومًا)
-- أعادهما المستخدم الحالي حديثًا.
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
values
  ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000bb',
   now() - interval '200 days', 'reel', 'reels', 'public', 'https://example.test/repost-1.mp4'),
  ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-0000000000aa',
   now() - interval '210 days', 'reel', 'reels', 'public', 'https://example.test/repost-2.mp4');

insert into public.reposts (post_id, user_id, created_at) values
  ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000ff', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-0000000000ff', now() - interval '2 hours');

-- كل المرشحين ظهروا قبل 10 دقائق، باستثناء الريل غير المشاهد (101) والخاص (cc)
insert into public.post_impressions (event_id, user_id, post_id, surface, content_type, session_id, impression_at)
select gen_random_uuid(), '00000000-0000-4000-8000-0000000000ff', seen.post_id,
       'reels', 'video', gen_random_uuid(), now() - interval '10 minutes'
from (
  select post_id from public.posts
  where user_id in ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb')
    and id <> '00000000-0000-4000-8000-000000000101'::uuid
) as seen;

-- منشور خاص من حساب خاص: يجب ألا يصل إلى أي نتيجة
insert into public.posts (id, user_id, created_at, type, destination, visibility, media_url)
values ('00000000-0000-4000-8000-0000000000cc', '00000000-0000-4000-8000-0000000000dd',
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
  v_definition text;
  v_discovery_limit_count integer;
  v_repost_limit_count integer;
begin
  -- حدود صريحة لكل نافذة: LIMIT قبل تجميع النتائج وترتيبها، في كل من نوافذ
  -- الاكتشاف الثلاث (14/60/180) ونوافذ إعادة النشر الثلاث (30/90/365).
  v_definition := pg_get_functiondef(
    'public.aani_get_personalized_reels_relevance(integer,integer)'::regprocedure
  );
  v_discovery_limit_count := (
    length(v_definition) - length(replace(v_definition, 'limit v_bound_discovery', ''))
  ) / length('limit v_bound_discovery');
  v_repost_limit_count := (
    length(v_definition) - length(replace(v_definition, 'limit v_bound_reposts', ''))
  ) / length('limit v_bound_reposts');

  if v_discovery_limit_count <> 3 then
    raise exception 'assert: نوافذ الاكتشاف يجب أن تحمل 3 حدود LIMIT صريحة، وجدنا %.', v_discovery_limit_count;
  end if;
  if v_repost_limit_count <> 3 then
    raise exception 'assert: نوافذ إعادة النشر يجب أن تحمل 3 حدود LIMIT صريحة، وجدنا %.', v_repost_limit_count;
  end if;

  select count(*) into v_engine_40 from t_engine_40;
  select count(*) into v_engine_200 from t_engine_200;
  select count(*) into v_final from t_final;

  -- المحرك بسقف 40 لا يتجاوز 40، وبسقف 200 يصل إلى كامل المرشحين.
  -- الحصص (40/40/20) لا تُلزم بعدد 40 من مصدر واحد، فالتأكيد على السقف نفسه
  -- وعلى ظهور/غياب الريل غير المشاهد، لا على عدد ثابت من مصدر واحد.
  if v_engine_40 > 40 then
    raise exception 'assert: المحرك بسقف 40 يجب ألا يتجاوز 40، وجدنا %', v_engine_40;
  end if;
  if v_engine_40 = 0 then
    raise exception 'assert: المحرك بسقف 40 يجب أن يُعيد مرشحين، وجدنا 0.';
  end if;
  if v_engine_200 < 41 then
    raise exception 'assert: المحرك يجب أن يُعيد 41 مرشحًا أو أكثر عند p_candidate_limit=200، وجدنا %', v_engine_200;
  end if;
  if v_engine_200 <= v_engine_40 then
    raise exception 'assert: سقف 200 يجب أن يرى مرشحين أكثر من سقف 40 (% مقابل %).', v_engine_200, v_engine_40;
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
