-- =====================================================================
-- توثيق بنية جداول تسجيل الظهور والمشاهدة (توصيات المنشورات)
--
-- حالة هذا الملف: **توثيقي، وليس ترحيلاً مطلوباً تشغيله**.
--   الترحيل 20261116113304_create_post_recommendation_telemetry_tables سبق
--   تنفيذه مباشرة على Supabase Production، والجدولان post_impressions
--   و post_view_events موجودان هناك بالفعل. هذا الملف يُضاف الآن إلى
--   المستودع لتوثيق مصدر البنية (كانت غائبة عن supabase/migrations تماماً)
--   وليُعيد إنشاءها في بيئة جديدة عند الحاجة فقط.
--
--   لا تُشغّله على قاعدة الإنتاج الحالية: لن يغيّر شيئاً هناك (كل الأوامر
--   محميّة بـ if not exists / drop policy if exists)، لكن لا حاجة له ولا
--   فائدة، وقد يوهم بأن الترحيل لم يكن مطبَّقاً. لا يوجد سجل مطابق لهذا
--   الترحيل في schema_migrations داخل المستودع.
--
-- المصدر: بنية Production كما استُخرجت منها مباشرة (أعمدة، قيود، فهارس،
--   سياسات، صلاحيات). لم يُضف أي تحسين أو قيد غير موجود هناك.
--
-- ملاحظات على ما لم يُستخرج حرفياً:
--   * أسماء قيود CHECK والمفاتيح الأجنبية لم تُستخرج؛ كُتبت داخل تعريف
--     الجدول بلا أسماء، فتولّد PostgreSQL أسماءها التلقائية كما فعلت في
--     الإنتاج. أسماء الفهارس والمفاتيح الأساسية والسياسات مذكورة صراحةً
--     لأنها المستخرجة فعلاً.
--   * قيد UNIQUE (user_id, event_id) في الإنتاج فهرس فريد باسم
--     <table>_user_event_unique، فكُتب هنا كفهرس فريد بنفس الاسم لا كقيد
--     داخل الجدول.
--
-- سياق مهم عند إعادة الإنشاء في بيئة جديدة:
--   شرط EXISTS في سياستي INSERT يقرأ public.posts، وهو **خاضع لسياسات RLS
--   السارية على posts وقت التنفيذ**. سياسة قراءة posts تغيّرت في
--   20270203000000_posts_private_accounts_read_policy.sql، فطبّق ترحيلات
--   posts قبل هذا الملف إن أردت أن يعمل الشرط كما يعمل في الإنتاج.
-- =====================================================================
begin;

-- =====================================================================
-- 1) post_impressions — انطباعات ظهور المنشورات في الواجهة
-- =====================================================================
create table if not exists public.post_impressions (
  id uuid not null default gen_random_uuid() primary key,
  event_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  surface text not null check (surface in ('feed', 'reels')),
  content_type text not null check (content_type in ('text', 'image', 'video')),
  session_id uuid not null,
  impression_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- الفهرس post_impressions_pkey (UNIQUE على id) يُنشأ تلقائياً مع المفتاح
-- الأساسي أعلاه، فلا يُعاد إنشاؤه هنا.
create index if not exists post_impressions_post_time_idx
  on public.post_impressions (post_id, impression_at desc);

create index if not exists post_impressions_session_surface_idx
  on public.post_impressions (user_id, session_id, surface);

create unique index if not exists post_impressions_user_event_unique
  on public.post_impressions (user_id, event_id);

create index if not exists post_impressions_user_time_idx
  on public.post_impressions (user_id, impression_at desc);

alter table public.post_impressions enable row level security;

-- لا توجد سياسات anon ولا PUBLIC على الجدولين، ولا صلاحيات لهما.
grant select, insert on public.post_impressions to authenticated;
grant all on public.post_impressions to service_role;

drop policy if exists "Users can read their own post impressions" on public.post_impressions;
create policy "Users can read their own post impressions"
  on public.post_impressions for select to authenticated
  using ((select auth.uid()) = user_id);

-- الشرط EXISTS يقرأ public.posts ويخضع لسياسات RLS الخاصة به:
-- لا يُعاد صف إن كان المنشور غير موجود أو غير مقروء للمستخدم.
drop policy if exists "Users can insert their own readable post impressions" on public.post_impressions;
create policy "Users can insert their own readable post impressions"
  on public.post_impressions for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.posts p
      where p.id = post_impressions.post_id
    )
  );

-- =====================================================================
-- 2) post_view_events — أحداث المشاهدة وزمن المشاهدة والتشغيل
-- =====================================================================
create table if not exists public.post_view_events (
  id uuid not null default gen_random_uuid() primary key,
  event_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  surface text not null check (surface in ('feed', 'reels')),
  content_type text not null check (content_type in ('text', 'image', 'video')),
  session_id uuid not null,
  visible_duration_ms integer not null default 0
    check (visible_duration_ms between 0 and 86400000),
  played_duration_ms integer not null default 0
    check (played_duration_ms between 0 and 86400000),
  media_duration_ms integer null
    check (media_duration_ms is null or media_duration_ms between 1 and 86400000),
  completion_ratio numeric(6, 5) null
    check (completion_ratio is null or completion_ratio between 0 and 1),
  replay_count integer not null default 0
    check (replay_count between 0 and 1000),
  early_skip boolean not null default false,
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- الفهرس post_view_events_pkey (UNIQUE على id) يُنشأ تلقائياً مع المفتاح
-- الأساسي أعلاه، فلا يُعاد إنشاؤه هنا.
create index if not exists post_view_events_post_time_idx
  on public.post_view_events (post_id, event_at desc);

create unique index if not exists post_view_events_user_event_unique
  on public.post_view_events (user_id, event_id);

create index if not exists post_view_events_user_post_time_idx
  on public.post_view_events (user_id, post_id, event_at desc);

create index if not exists post_view_events_user_time_idx
  on public.post_view_events (user_id, event_at desc);

alter table public.post_view_events enable row level security;

grant select, insert on public.post_view_events to authenticated;
grant all on public.post_view_events to service_role;

drop policy if exists "Users can read their own post view events" on public.post_view_events;
create policy "Users can read their own post view events"
  on public.post_view_events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own readable post view events" on public.post_view_events;
create policy "Users can insert their own readable post view events"
  on public.post_view_events for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.posts p
      where p.id = post_view_events.post_id
    )
  );

commit;

-- =====================================================================
-- لا مُشغّلات ولا دوال مرتبطة بالجدولين في الإنتاج (فحص مباشر).
-- لا بيانات تجريبية.
-- =====================================================================
