-- ============================================================================
-- إصلاح شامل: ظهور الريل بعد نجاح النشر (بيانات + صلاحيات + Storage)
-- يُنفَّذ يدوياً في Supabase → SQL Editor. آمن للتكرار (idempotent).
--
-- الفكرة: كل ما يكتبه التطبيق وقت النشر (type / destination / media_url /
-- media_asset_id) يجب أن يكون مقروءاً وقت العرض. أي عمود ناقص أو منحة (GRANT)
-- ناقصة أو bucket غير عام يجعل الحفظ ينجح والعرض يفشل بصمت.
-- ============================================================================
begin;

-- 0) التحقق من وجود جدول المنشورات
do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts غير موجود: طبّق مخطط المشروع الأساسي أولاً.';
  end if;
end;
$$;

-- 1) الأعمدة التي يكتبها مسار النشر ويقرأها تبويب الريلز
alter table public.posts
  add column if not exists content text not null default '',
  add column if not exists media_url text,
  add column if not exists media_urls text[],
  add column if not exists post_metadata jsonb not null default '[]'::jsonb,
  add column if not exists type text not null default 'text',
  add column if not exists destination text not null default 'feed',
  add column if not exists visibility text not null default 'public',
  add column if not exists display_order integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists media_asset_id uuid,
  add column if not exists tagged_user_ids uuid[],
  add column if not exists sound_id uuid,
  add column if not exists audio_url text,
  add column if not exists audio_title text,
  add column if not exists trim_start double precision,
  add column if not exists trim_end double precision,
  add column if not exists sound_trim_start real,
  add column if not exists sound_trim_end real;

-- 2) تصحيح أي قيم وجهة/ظهور غير صالحة (كانت تُحفظ فارغة عند إعادة المحاولة)
update public.posts
set destination = 'feed'
where destination is null or destination not in ('feed', 'reels');

update public.posts
set visibility = 'public'
where visibility is null or visibility not in ('public', 'private');

-- 3) قيد الوجهة: يسمح بصور الريلز أيضاً (NOT VALID حتى لا تفشل بيانات قديمة)
alter table public.posts drop constraint if exists posts_destination_check;
alter table public.posts
  add constraint posts_destination_check
  check (
    destination in ('feed', 'reels')
    and (destination <> 'reels' or type in ('reel', 'photo'))
  )
  not valid;

-- 4) جدول سجلات الوسائط (معالجة FFmpeg) — يحتاجه مسار الفيديو
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  original_path text,
  storage_path text,
  processed_path text,
  video_url text,
  poster_url text,
  duration double precision,
  width integer,
  height integer,
  processing_status text not null default 'uploading',
  status text not null default 'uploading',
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.media_assets
  add column if not exists user_id uuid,
  add column if not exists original_path text,
  add column if not exists storage_path text,
  add column if not exists processed_path text,
  add column if not exists video_url text,
  add column if not exists poster_url text,
  add column if not exists duration double precision,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists processing_status text default 'uploading',
  add column if not exists status text,
  add column if not exists error_message text,
  add column if not exists created_at timestamptz not null default now();

update public.media_assets
set storage_path = coalesce(nullif(storage_path, ''), nullif(original_path, '')),
    original_path = coalesce(nullif(original_path, ''), nullif(storage_path, '')),
    status = coalesce(nullif(status, ''), nullif(processing_status, ''), 'uploading'),
    processing_status = coalesce(nullif(processing_status, ''), nullif(status, ''), 'uploading')
where storage_path is null
   or original_path is null
   or status is null
   or processing_status is null;

alter table public.media_assets enable row level security;
grant select on table public.media_assets to anon, authenticated;
grant insert on table public.media_assets to authenticated;
grant all on table public.media_assets to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'media_assets'
      and policyname = 'media_assets_public_read'
  ) then
    create policy media_assets_public_read
      on public.media_assets for select to anon, authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'media_assets'
      and policyname = 'media_assets_owner_insert'
  ) then
    create policy media_assets_owner_insert
      on public.media_assets for insert to authenticated
      with check (user_id = auth.uid());
  end if;
end;
$$;

-- 5) ربط المنشور بسجل الوسائط + فهارس
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'posts_media_asset_id_fkey'
      and conrelid = 'public.posts'::regclass
  ) then
    alter table public.posts
      add constraint posts_media_asset_id_fkey
      foreign key (media_asset_id)
      references public.media_assets (id)
      on delete set null
      not valid;
  end if;
end;
$$;

create index if not exists posts_media_asset_id_idx on public.posts (media_asset_id);
create index if not exists posts_reels_feed_idx
  on public.posts (destination, type, created_at desc);
create index if not exists media_assets_user_id_idx on public.media_assets (user_id);
create index if not exists media_assets_status_created_at_idx
  on public.media_assets (status, created_at desc);

-- 6) صلاحيات القراءة: كل عمود يطلبه استعلام الريلز/الواجهة/الملف الشخصي
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'posts'
    and column_name in (
      'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
      'media_asset_id', 'type', 'destination', 'visibility', 'display_order',
      'created_at', 'likes_count', 'comments_count', 'reposts_count',
      'shares_count', 'comments_disabled', 'audio_url', 'audio_title',
      'sound_id', 'sound_trim_start', 'sound_trim_end', 'trim_start',
      'trim_end', 'tagged_user_ids', 'hide_likes', 'hide_comments',
      'comment_privacy'
    );

  if cols is not null then
    execute format('grant select (%s) on table public.posts to anon, authenticated', cols);
  end if;
end;
$$;

-- 7) صلاحيات الكتابة: ما يرسله التطبيق فعلاً عند النشر (Upsert يحتاج INSERT+UPDATE)
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'posts'
    and column_name in (
      'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
      'media_asset_id', 'type', 'destination', 'created_at', 'tagged_user_ids',
      'sound_id', 'audio_url', 'audio_title', 'sound_trim_start',
      'sound_trim_end', 'trim_start', 'trim_end', 'visibility',
      'display_order', 'hide_likes', 'hide_comments', 'comment_privacy'
    );

  if cols is not null then
    execute format('grant insert (%s) on table public.posts to authenticated', cols);
    execute format('grant update (%s) on table public.posts to authenticated', cols);
  end if;
end;
$$;

-- 8) سياسات RLS: المالك ينشر ويعدّل، والقراءة لكل منشور عام (لا تُلمس سياسة موجودة)
alter table public.posts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'Signed-in users can read posts'
  ) and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts' and cmd = 'SELECT'
  ) then
    create policy "Signed-in users can read posts"
      on public.posts for select to authenticated
      using (user_id = (select auth.uid()) or visibility = 'public');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'Users can create their own posts'
  ) then
    create policy "Users can create their own posts"
      on public.posts for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'Users can update their own posts'
  ) then
    create policy "Users can update their own posts"
      on public.posts for update to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end;
$$;

-- 9) Storage: الـ bucket يجب أن يكون عاماً حتى تعمل روابط getPublicUrl في <video>
insert into storage.buckets (id, name, public)
values ('aani-media', 'aani-media', true)
on conflict (id) do update set public = true;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Aani media is readable by signed-in users'
  ) then
    create policy "Aani media is readable by signed-in users"
      on storage.objects for select to authenticated
      using (bucket_id = 'aani-media');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can upload their own Aani media'
  ) then
    create policy "Users can upload their own Aani media"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'aani-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can update their own Aani media'
  ) then
    create policy "Users can update their own Aani media"
      on storage.objects for update to authenticated
      using (
        bucket_id = 'aani-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can delete their own Aani media'
  ) then
    create policy "Users can delete their own Aani media"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'aani-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
exception
  when insufficient_privilege then
    raise notice 'تعذر إنشاء سياسات Storage (تحتاج دور postgres في SQL Editor) — الـ bucket العام يكفي للتشغيل.';
end;
$$;

notify pgrst, 'reload schema';
commit;

-- ============================================================================
-- (اختياري) إعادة توجيه ريلز قديمة حُفظت بوجهة feed قبل الإصلاح.
-- شغّله فقط إن كانت لديك فيديوهات نُشرت إلى الريلز ولم تظهر.
-- تحذير: يطابق كل فيديو (type = 'reel') نُشر حديثاً، فحدّد المدة أو المعرّفات.
-- ============================================================================
-- update public.posts
-- set destination = 'reels'
-- where type = 'reel'
--   and destination = 'feed'
--   and created_at > now() - interval '1 day';

-- ============================================================================
-- تشخيص سريع (ينفَّذ منفصلاً — يعيد صفاً واحداً بكل الفحوص)
-- ============================================================================
select 'bucket aani-media public' as check_name,
       coalesce((select b.public::text from storage.buckets b where b.id = 'aani-media'), 'MISSING') as value
union all
select 'reels rows (destination=reels or type=reel)',
       (select count(*)::text from public.posts where destination = 'reels' or type = 'reel')
union all
select 'reels rows without media_url',
       (select count(*)::text from public.posts
        where (destination = 'reels' or type = 'reel')
          and coalesce(media_url, media_urls[1]) is null)
union all
select 'latest post (type | destination | media_url)',
       (select concat_ws(' | ', type, destination, coalesce(left(media_url, 80), 'NULL'))
        from public.posts order by created_at desc limit 1)
union all
select 'authenticated select on posts',
       (select count(*)::text
        from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'posts'
          and grantee = 'authenticated' and privilege_type = 'SELECT');
