-- Video asset metadata and processing state for server-side FFmpeg encoding.
-- Safe to apply when media_assets and posts.media_asset_id were created manually.
begin;

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  original_path text not null,
  video_url text,
  poster_url text,
  duration double precision,
  width integer,
  height integer,
  processing_status text not null default 'uploading',
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.media_assets
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists original_path text,
  add column if not exists video_url text,
  add column if not exists poster_url text,
  add column if not exists duration double precision,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists processing_status text default 'uploading',
  add column if not exists error_message text,
  add column if not exists created_at timestamptz not null default now();

update public.media_assets
set processing_status = 'uploading'
where processing_status is null;

alter table public.media_assets
  alter column processing_status set default 'uploading',
  alter column processing_status set not null;

alter table public.media_assets
  drop constraint if exists media_assets_processing_status_check;

alter table public.media_assets
  add constraint media_assets_processing_status_check
  check (processing_status in ('uploading', 'processing', 'ready', 'failed')) not valid;

alter table public.posts
  add column if not exists media_asset_id uuid;

create index if not exists media_assets_user_id_idx
  on public.media_assets (user_id);

create index if not exists posts_media_asset_id_idx
  on public.posts (media_asset_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
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

alter table public.media_assets enable row level security;
grant select on table public.media_assets to anon, authenticated;
grant insert on table public.media_assets to authenticated;
grant all on table public.media_assets to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'media_assets'
      and policyname = 'media_assets_public_read'
  ) then
    create policy media_assets_public_read
      on public.media_assets for select to anon, authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'media_assets'
      and policyname = 'media_assets_owner_insert'
  ) then
    create policy media_assets_owner_insert
      on public.media_assets for insert to authenticated
      with check (user_id = auth.uid());
  end if;
end;
$$;

commit;
