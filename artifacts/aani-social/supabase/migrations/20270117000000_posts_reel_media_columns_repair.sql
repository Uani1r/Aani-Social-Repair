-- Repair columns required to publish reels when the existing posts table was
-- created from an older/incomplete schema. Keeps reels in public.posts.
begin;

do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts must exist before applying the post media repair';
  end if;
end;
$$;

alter table public.posts
  add column if not exists content text not null default '',
  add column if not exists media_url text,
  add column if not exists media_urls text[],
  add column if not exists post_metadata jsonb not null default '[]'::jsonb,
  add column if not exists type text not null default 'text',
  add column if not exists destination text not null default 'feed',
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

create index if not exists posts_media_asset_id_idx
  on public.posts (media_asset_id);

do $$
begin
  if to_regclass('public.media_assets') is not null
    and not exists (
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

-- Restore only the public post/media columns needed by the authenticated app;
-- do not grant access to private columns such as allowed_commenters.
grant select (
  id, user_id, content, post_metadata, media_url, media_urls, media_asset_id,
  type, destination, created_at, tagged_user_ids, sound_id, audio_url, audio_title,
  trim_start, trim_end, sound_trim_start, sound_trim_end
) on table public.posts to authenticated;

grant insert (
  id, user_id, content, post_metadata, media_url, media_urls, media_asset_id,
  type, destination, created_at, tagged_user_ids, sound_id, audio_url, audio_title,
  trim_start, trim_end, sound_trim_start, sound_trim_end
) on table public.posts to authenticated;

notify pgrst, 'reload schema';
commit;
