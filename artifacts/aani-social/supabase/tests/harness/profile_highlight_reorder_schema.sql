-- Minimal throwaway schema for the highlight story reordering RPC tests.
-- Runs only on the CI PostgreSQL service, never on a Supabase project.

-- Supabase provides these roles and auth.uid(); the CI database does not.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
end;
$$;

create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table if not exists public.profile_highlight_collections (
  id uuid primary key,
  user_id uuid not null,
  title text not null default '',
  cover_url text,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.profile_highlights (
  id uuid primary key,
  user_id uuid not null,
  collection_id uuid not null references public.profile_highlight_collections (id) on delete cascade,
  position integer not null default 0,
  media_url text,
  media_type text not null default 'image',
  caption text,
  created_at timestamptz not null default now()
);

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on public.profile_highlight_collections to authenticated;
grant select, insert, update, delete on public.profile_highlights to authenticated;

-- Two owners, three collections and four stories.
insert into public.profile_highlight_collections (id, user_id, title, display_order) values
  ('c0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'Owner A first', 0),
  ('c0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-00000000000a', 'Owner A second', 1),
  ('c0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-00000000000b', 'Owner B only', 0);

insert into public.profile_highlights (id, user_id, collection_id, position, caption) values
  ('50000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a', 0, 'A story 1'),
  ('50000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a', 1, 'A story 2'),
  ('50000000-0000-4000-8000-0000000000a3', 'a0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a', 2, 'A story 3'),
  ('50000000-0000-4000-8000-0000000000a4', 'a0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000b', 0, 'A story in second collection'),
  ('50000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000c', 0, 'B story');
