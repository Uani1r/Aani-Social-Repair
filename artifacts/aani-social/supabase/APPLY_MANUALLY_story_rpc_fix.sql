-- =====================================================================
-- إصلاح دالة نشر القصص public.aani_create_story — مستقل وقابل لإعادة التشغيل
-- =====================================================================
-- السبب الذي كشفته لوحة التشخيص:
--   "Could not find the function public.aani_create_story(p_caption,
--    p_duration_seconds, p_expiry_seconds, p_filter_key, p_is_close_friends,
--    p_media_type, p_media_url, p_original_story_id, p_share_type,
--    p_timed_texts) in the schema cache"
--
-- هذا الملف:
--   1) يتأكد من وجود جميع أعمدة جدول stories (الوسائط، النص، المدة،
--      الانتهاء بعد 24 ساعة، الفلتر، الأصدقاء المقربون، نوع المشاركة،
--      النصوص الموقّتة، والموسيقى/الصوت إن وُجد جدول الأصوات).
--   2) ينشئ دالة aani_create_story موحّدة بمعاملات العميل بالضبط (عشرة أساسية
--      + ثلاثة للصوت) — كلها بقيم افتراضية NULL فلا تفشل إن أُرسل جزء منها فقط.
--   3) يمنح EXECUTE لـ authenticated (وليس anon) ويحمي الدالة.
--   4) يحدّث كاش PostgREST فوراً عبر NOTIFY pgrst, 'reload schema'.
-- آمن لإعادة التشغيل: كل الخطوات CREATE OR REPLACE / IF NOT EXISTS.
-- =====================================================================

begin;

-- =====================================================================
-- 1) التأكد من أعمدة جدول stories
-- =====================================================================

-- الأعمدة الأساسية (موجودة في الترحيلات الأقدم عادة — IF NOT EXISTS يحفظ الأمان)
alter table public.stories
  add column if not exists media_url text,
  add column if not exists media_type text,
  add column if not exists caption text,
  add column if not exists is_close_friends boolean not null default false,
  add column if not exists duration_seconds integer not null default 5
    check (duration_seconds between 1 and 120),
  add column if not exists timed_texts jsonb not null default '[]'::jsonb,
  add column if not exists filter_key text,
  add column if not exists original_story_id uuid,
  add column if not exists share_type text not null default 'original',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz not null default (now() + interval '24 hours');

-- أعمدة الصوت (نظام الأصوات) — تُضاف فقط إن وُجد جدول الأصوات لأن العمود
-- يرتبط بمفتاح أجنبي إليه؛ إن غاب الجدول تعمل الدالة بلا أعمدة الصوت.
do $$
begin
  if to_regclass('public.sounds') is not null then
    execute 'alter table public.stories
      add column if not exists sound_id uuid references public.sounds (id) on delete set null,
      add column if not exists sound_trim_start real,
      add column if not exists sound_trim_end real';
    execute 'create index if not exists stories_sound_id_idx on public.stories (sound_id, created_at desc)';
    execute 'grant select (sound_id, sound_trim_start, sound_trim_end) on public.stories to authenticated';
  end if;
end $$;

-- =====================================================================
-- 2) الدالة المساعدة للتحقق من وجود القصة الأصل (إعادة إنشاء آمنة)
-- =====================================================================

create or replace function public.aani_story_exists(p_story_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_story_id is null then
    return false;
  end if;

  perform 1
  from public.stories as story
  where story.id = p_story_id
  for key share;

  return found;
end;
$$;

alter function public.aani_story_exists(uuid) owner to postgres;

-- =====================================================================
-- 3) حذف أي نسخة قديمة بعشرة معاملات (قد تحمل أسماء معاملات مختلفة
--    في قواعد أقدم — حذفها يمنع التزامن بين دالتين)
-- =====================================================================

drop function if exists public.aani_create_story(
  text, text, text, boolean, integer, jsonb, text, uuid, text, integer
);

-- =====================================================================
-- 4) دالة النشر الموحّدة — نفس المعاملات التي يرسلها العميل بالضبط
--    (p_caption, p_duration_seconds, p_expiry_seconds, p_filter_key,
--     p_is_close_friends, p_media_type, p_media_url, p_original_story_id,
--     p_share_type, p_timed_texts) + معاملات الصوت الاختيارية
--    كلها بقيم افتراضية NULL حتى لا تفشل لو أُرسل جزء منها فقط.
--    SECURITY DEFINER لتجاوز RLS على INSERT مع إبقاء فحوص الهوية
--    والقصة الأصل داخل الدالة (نفس تصميم ترحيل 20261113000000).
-- =====================================================================

create or replace function public.aani_create_story(
  p_media_url text default null,
  p_media_type text default null,
  p_caption text default null,
  p_is_close_friends boolean default null,
  p_duration_seconds integer default null,
  p_timed_texts jsonb default null,
  p_filter_key text default null,
  p_original_story_id uuid default null,
  p_share_type text default null,
  p_expiry_seconds integer default null,
  p_sound_id uuid default null,
  p_sound_trim_start real default null,
  p_sound_trim_end real default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_story_id uuid;
  normalized_original_story_id uuid := p_original_story_id;
  normalized_share_type text := coalesce(p_share_type, 'original');
  has_sound_columns boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_media_type is null or p_media_type not in ('text', 'photo', 'video') then
    raise exception 'Invalid story media type' using errcode = '22023';
  end if;

  if p_expiry_seconds is not null and (p_expiry_seconds < 5 or p_expiry_seconds > 3600) then
    raise exception 'Story expiry must be between 5 seconds and 60 minutes' using errcode = '22023';
  end if;

  if normalized_original_story_id is null then
    normalized_share_type := 'original';
  elsif not coalesce(public.aani_story_exists(normalized_original_story_id), false) then
    normalized_original_story_id := null;
    normalized_share_type := 'original';
  elsif normalized_share_type <> 'reshare' then
    raise exception 'A story with an original reference must be a reshare' using errcode = '22023';
  elsif not public.aani_can_reshare_story(
    normalized_original_story_id,
    auth.uid(),
    p_media_url,
    p_media_type
  ) then
    raise exception 'The original story is not available for resharing' using errcode = '42501';
  end if;

  -- أعمدة الصوت قد لا تكون مطبقة على قواعد أقدم — نفحص ثم نكتب بما يناسب
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stories'
      and column_name = 'sound_id'
  ) into has_sound_columns;

  if has_sound_columns then
    insert into public.stories (
      user_id,
      media_url,
      media_type,
      caption,
      is_close_friends,
      duration_seconds,
      timed_texts,
      filter_key,
      original_story_id,
      share_type,
      created_at,
      expires_at,
      sound_id,
      sound_trim_start,
      sound_trim_end
    ) values (
      auth.uid(),
      p_media_url,
      p_media_type,
      p_caption,
      coalesce(p_is_close_friends, false),
      least(120, greatest(1, coalesce(p_duration_seconds, 30))),
      coalesce(p_timed_texts, '[]'::jsonb),
      p_filter_key,
      normalized_original_story_id,
      normalized_share_type,
      now(),
      now() + pg_catalog.make_interval(secs => coalesce(p_expiry_seconds, 86400)::double precision),
      p_sound_id,
      p_sound_trim_start,
      p_sound_trim_end
    )
    returning id into created_story_id;
  else
    insert into public.stories (
      user_id,
      media_url,
      media_type,
      caption,
      is_close_friends,
      duration_seconds,
      timed_texts,
      filter_key,
      original_story_id,
      share_type,
      created_at,
      expires_at
    ) values (
      auth.uid(),
      p_media_url,
      p_media_type,
      p_caption,
      coalesce(p_is_close_friends, false),
      least(120, greatest(1, coalesce(p_duration_seconds, 30))),
      coalesce(p_timed_texts, '[]'::jsonb),
      p_filter_key,
      normalized_original_story_id,
      normalized_share_type,
      now(),
      now() + pg_catalog.make_interval(secs => coalesce(p_expiry_seconds, 86400)::double precision)
    )
    returning id into created_story_id;
  end if;

  return created_story_id;
end;
$$;

-- =====================================================================
-- 5) الملكية والصلاحيات: EXECUTE لـ authenticated (وليس anon/public)
-- =====================================================================

alter function public.aani_create_story(
  text, text, text, boolean, integer, jsonb, text, uuid, text, integer,
  uuid, real, real
) owner to postgres;

revoke all on function public.aani_create_story(
  text, text, text, boolean, integer, jsonb, text, uuid, text, integer,
  uuid, real, real
) from public, anon;

grant execute on function public.aani_create_story(
  text, text, text, boolean, integer, jsonb, text, uuid, text, integer,
  uuid, real, real
) to authenticated, service_role;

-- =====================================================================
-- 6) تحديث كاش PostgREST فوراً حتى يرى PostgREST الدالة الجديدة
--    دون إعادة تشغيل أي شيء (الإشعار يُسلَّم لحظة الـ commit)
-- =====================================================================

notify pgrst, 'reload schema';

commit;
