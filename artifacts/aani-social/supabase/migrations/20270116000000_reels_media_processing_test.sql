-- FFmpeg-ready metadata for reel videos. Reels remain rows in public.posts
-- with type = 'reel' and destination = 'reels'; no separate reels table is used.
-- Safe to re-run after the existing posts/media_assets baseline migrations.
begin;

do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts must exist before applying the reels media processing migration';
  end if;
end;
$$;

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

alter table public.posts
  add column if not exists media_asset_id uuid;

-- Backfill the new names from the established app columns (and vice versa).
update public.media_assets
set storage_path = coalesce(nullif(storage_path, ''), nullif(original_path, '')),
    original_path = coalesce(nullif(original_path, ''), nullif(storage_path, '')),
    status = coalesce(nullif(status, ''), nullif(processing_status, ''), 'uploading'),
    processing_status = coalesce(nullif(processing_status, ''), nullif(status, ''), 'uploading');

update public.media_assets as asset
set user_id = post.user_id
from public.posts as post
where post.media_asset_id = asset.id
  and asset.user_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_assets_user_id_fkey'
      and conrelid = 'public.media_assets'::regclass
  ) then
    alter table public.media_assets
      add constraint media_assets_user_id_fkey
      foreign key (user_id)
      references auth.users (id)
      on delete cascade
      not valid;
  end if;
end;
$$;

alter table public.media_assets
  alter column processing_status set default 'uploading',
  alter column processing_status set not null,
  alter column status set default 'uploading',
  alter column status set not null;

alter table public.media_assets
  drop constraint if exists media_assets_processing_status_check,
  drop constraint if exists media_assets_status_check;

alter table public.media_assets
  add constraint media_assets_processing_status_check
    check (processing_status in ('uploading', 'processing', 'ready', 'failed')) not valid,
  add constraint media_assets_status_check
    check (status in ('uploading', 'processing', 'ready', 'failed')) not valid;

create or replace function public.sync_media_asset_processing_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.storage_path := coalesce(nullif(new.storage_path, ''), nullif(new.original_path, ''));
    new.original_path := coalesce(nullif(new.original_path, ''), nullif(new.storage_path, ''));
    if new.status is null or new.status = '' then
      new.status := coalesce(nullif(new.processing_status, ''), 'uploading');
    elsif new.processing_status is null or new.processing_status = '' then
      new.processing_status := new.status;
    elsif new.status is distinct from new.processing_status then
      if new.status = 'uploading' then
        new.status := new.processing_status;
      else
        new.processing_status := new.status;
      end if;
    end if;
  else
    if new.storage_path is distinct from old.storage_path then
      new.original_path := new.storage_path;
    elsif new.original_path is distinct from old.original_path then
      new.storage_path := new.original_path;
    end if;

    if new.status is distinct from old.status then
      new.processing_status := new.status;
    elsif new.processing_status is distinct from old.processing_status then
      new.status := new.processing_status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists media_assets_sync_processing_columns on public.media_assets;
create trigger media_assets_sync_processing_columns
before insert or update of original_path, storage_path, processing_status, status
on public.media_assets
for each row execute function public.sync_media_asset_processing_columns();

create index if not exists media_assets_user_id_idx
  on public.media_assets (user_id);
create index if not exists media_assets_status_created_at_idx
  on public.media_assets (status, created_at desc);
create index if not exists posts_media_asset_id_idx
  on public.posts (media_asset_id);

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
