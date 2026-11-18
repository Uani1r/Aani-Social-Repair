-- =====================================================================
-- Post reports (إبلاغ عن المنشورات)
-- Backs the post action dropdown "Report" option for non-owner users.
-- Idempotent: safe to run multiple times.
--
-- NOTE: earlier deployments created a `reports` table with a `user_id`
-- column instead of `reporter_id`. `create table if not exists` silently
-- skipped that table, so the app kept failing with
--   PGRST204 "Could not find the 'reporter_id' column"
-- and inserts were rejected by RLS (42501).
-- The repair block below migrates the legacy table in place, so both
-- shapes work after this file is applied.
-- =====================================================================

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete set null,
  reason text not null default 'محتوى غير مناسب',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Repair / upgrade an existing table (no-op on a fresh database)
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists reporter_id uuid;
alter table public.reports add column if not exists reported_user_id uuid;
alter table public.reports add column if not exists status text not null default 'pending';
-- Kept only so legacy clients and legacy rows stay valid; newer code
-- writes reporter_id. Both are kept in sync by a trigger below.
alter table public.reports add column if not exists user_id uuid;

-- Backfill both directions for rows created by either code path.
update public.reports set reporter_id = user_id where reporter_id is null and user_id is not null;
update public.reports set user_id = reporter_id where user_id is null and reporter_id is not null;

-- Rows with no attributable reporter cannot satisfy the contract below.
delete from public.reports where reporter_id is null;

-- Deduplicate before enforcing one report per (post, user).
delete from public.reports a
 using public.reports b
 where a.ctid > b.ctid
   and a.post_id = b.post_id
   and a.reporter_id = b.reporter_id;

alter table public.reports alter column reporter_id set not null;
-- Legacy NOT NULL on user_id would block inserts that only send reporter_id.
alter table public.reports alter column user_id drop not null;

-- ---------------------------------------------------------------------
-- Foreign keys
-- Guarded by "does a FK already cover this column", not by constraint
-- name: `create table if not exists` above may have created inline FKs
-- with auto-generated names on a fresh database.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'post_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_post_fk
      foreign key (post_id) references public.posts(id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'reporter_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_reporter_fk
      foreign key (reporter_id) references public.profiles(id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'reports'
       and c.contype = 'f'
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = t.oid and attname = 'reported_user_id')]
  ) then
    alter table public.reports
      add constraint aani_reports_reported_user_fk
      foreign key (reported_user_id) references public.profiles(id) on delete set null;
  end if;
end $$;

create unique index if not exists aani_reports_post_reporter_unique_idx
  on public.reports (post_id, reporter_id);

create index if not exists aani_reports_status_idx
  on public.reports (status, created_at desc);
create index if not exists aani_reports_post_idx on public.reports (post_id);

-- ---------------------------------------------------------------------
-- Accept either insert shape: {reporter_id} or legacy {user_id}
-- ---------------------------------------------------------------------
create or replace function public.aani_reports_normalize()
returns trigger
language plpgsql
as $$
begin
  if new.reporter_id is null then
    new.reporter_id := new.user_id;
  end if;
  if new.user_id is null then
    new.user_id := new.reporter_id;
  end if;
  return new;
end $$;

drop trigger if exists aani_reports_normalize_trg on public.reports;
create trigger aani_reports_normalize_trg
  before insert or update on public.reports
  for each row execute function public.aani_reports_normalize();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.reports enable row level security;

-- Policies OR together, so these only ever widen access for the reporter
-- themselves. Pre-existing policies on the legacy table are left intact.
do $$
begin
  -- A reporter can read back their own reports (used to detect duplicates).
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_select_own') then
    create policy aani_reports_select_own on public.reports
      for select using (auth.uid() = reporter_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_insert_own') then
    create policy aani_reports_insert_own on public.reports
      for insert with check (auth.uid() = reporter_id);
  end if;

  -- Reporters may withdraw their own report.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_delete_own') then
    create policy aani_reports_delete_own on public.reports
      for delete using (auth.uid() = reporter_id);
  end if;

  -- Moderators (service role bypasses RLS) may triage reports; authenticated
  -- users never see other people's reports.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'aani_reports_update_own') then
    create policy aani_reports_update_own on public.reports
      for update using (auth.uid() = reporter_id) with check (auth.uid() = reporter_id);
  end if;
end $$;

grant select, insert, update, delete on public.reports to authenticated;

alter table public.reports replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.reports';
    exception
      when duplicate_object then null;
      when undefined_object then null;
      when others then null;
    end;
  end if;
end $$;
