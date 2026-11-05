-- Secure comment editing and moderation actions, reports, hides, and restrictions.
begin;

alter table public.comments
  add column if not exists is_pinned boolean not null default false;

create index if not exists aani_comments_pinned_order_idx
  on public.comments (post_id, is_pinned desc, created_at asc);

create table if not exists public.comment_reports (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null,
  post_id uuid not null,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in ('spam', 'harassment', 'hate', 'fake_account', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint aani_comment_reports_not_self check (reporter_id <> reported_user_id),
  constraint aani_comment_reports_reporter_comment_unique unique (reporter_id, comment_id)
);

create table if not exists public.comment_hides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  comment_id uuid not null references public.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

create table if not exists public.user_restrictions (
  restricter_id uuid not null references public.profiles(id) on delete cascade,
  restricted_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (restricter_id, restricted_user_id),
  constraint aani_user_restrictions_not_self check (restricter_id <> restricted_user_id)
);

create index if not exists aani_comment_reports_target_created_idx
  on public.comment_reports (reported_user_id, created_at desc);
create index if not exists aani_comment_hides_comment_idx
  on public.comment_hides (comment_id, user_id);

alter table public.comment_reports enable row level security;
alter table public.comment_hides enable row level security;
alter table public.user_restrictions enable row level security;

revoke all on public.comment_reports, public.comment_hides, public.user_restrictions from public, anon, authenticated;
grant select, insert on public.comment_reports to authenticated;
grant select, insert on public.comment_hides to authenticated;
grant select on public.user_restrictions to authenticated;
grant select on public.comments to authenticated;

drop policy if exists aani_comment_reports_select_own on public.comment_reports;
create policy aani_comment_reports_select_own on public.comment_reports
  for select to authenticated using (reporter_id = (select auth.uid()));
drop policy if exists aani_comment_reports_insert_own on public.comment_reports;
create policy aani_comment_reports_insert_own on public.comment_reports
  for insert to authenticated with check (
    reporter_id = (select auth.uid())
    and reporter_id <> reported_user_id
    and status = 'pending'
    and exists (
      select 1 from public.comments as comment
      where comment.id = comment_reports.comment_id
        and comment.post_id = comment_reports.post_id
        and comment.user_id = comment_reports.reported_user_id
    )
  );

drop policy if exists aani_comment_hides_select_own on public.comment_hides;
create policy aani_comment_hides_select_own on public.comment_hides
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists aani_comment_hides_insert_own on public.comment_hides;
create policy aani_comment_hides_insert_own on public.comment_hides
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists aani_user_restrictions_select_own on public.user_restrictions;
create policy aani_user_restrictions_select_own on public.user_restrictions
  for select to authenticated using (restricter_id = (select auth.uid()));

create or replace function public.aani_comment_visible_under_restriction(
  p_post_id uuid,
  p_author_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer_id = auth.uid()
    and not exists (
      select 1
      from public.posts as post
      join public.user_restrictions as restriction
        on restriction.restricter_id = post.user_id
       and restriction.restricted_user_id = p_author_id
      where post.id = p_post_id
        and p_author_id <> post.user_id
        and p_viewer_id <> post.user_id
        and p_viewer_id <> p_author_id
    );
$$;
revoke all on function public.aani_comment_visible_under_restriction(uuid, uuid, uuid) from public, anon;
grant execute on function public.aani_comment_visible_under_restriction(uuid, uuid, uuid) to authenticated;

drop policy if exists aani_comments_restriction_read_guard on public.comments;
create policy aani_comments_restriction_read_guard on public.comments
  as restrictive for select to authenticated
  using (public.aani_comment_visible_under_restriction(post_id, user_id, (select auth.uid())));

create or replace function public.aani_edit_comment(p_comment_id uuid, p_content text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  current_image_url text;
  normalized_content text := btrim(coalesce(p_content, ''));
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if char_length(normalized_content) > 2000 then
    raise exception 'Comment is too long' using errcode = '22023';
  end if;

  select comment.image_url into current_image_url
  from public.comments as comment
  where comment.id = p_comment_id and comment.user_id = actor_id;
  if not found then
    raise exception 'Only the comment author may edit this comment' using errcode = '42501';
  end if;
  if normalized_content = '' and nullif(btrim(coalesce(current_image_url, '')), '') is null then
    raise exception 'Comment text cannot be empty without an image' using errcode = '22023';
  end if;

  update public.comments as comment
  set content = normalized_content
  where comment.id = p_comment_id and comment.user_id = actor_id;
end;
$$;
revoke all on function public.aani_edit_comment(uuid, text) from public, anon;
grant execute on function public.aani_edit_comment(uuid, text) to authenticated;

create or replace function public.aani_set_comment_pinned(p_comment_id uuid, p_is_pinned boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  updated_count integer;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  update public.comments as comment
  set is_pinned = coalesce(p_is_pinned, false)
  from public.posts as post
  where comment.id = p_comment_id
    and post.id = comment.post_id
    and post.user_id = actor_id;
  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    raise exception 'Only the post owner may pin comments' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.aani_set_comment_pinned(uuid, boolean) from public, anon;
grant execute on function public.aani_set_comment_pinned(uuid, boolean) to authenticated;

create or replace function public.aani_delete_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  deleted_count integer;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  delete from public.comments as comment
  using public.posts as post
  where comment.id = p_comment_id
    and post.id = comment.post_id
    and (comment.user_id = actor_id or post.user_id = actor_id);
  get diagnostics deleted_count = row_count;
  if deleted_count = 0 then
    raise exception 'Only the comment author or post owner may delete this comment' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.aani_delete_comment(uuid) from public, anon;
grant execute on function public.aani_delete_comment(uuid) to authenticated;

create or replace function public.aani_set_user_restricted(p_user_id uuid, p_restricted boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = actor_id then
    raise exception 'Invalid user to restrict' using errcode = '22023';
  end if;

  if coalesce(p_restricted, false) then
    insert into public.user_restrictions (restricter_id, restricted_user_id)
    values (actor_id, p_user_id)
    on conflict (restricter_id, restricted_user_id) do nothing;
  else
    delete from public.user_restrictions
    where restricter_id = actor_id and restricted_user_id = p_user_id;
  end if;
end;
$$;
revoke all on function public.aani_set_user_restricted(uuid, boolean) from public, anon;
grant execute on function public.aani_set_user_restricted(uuid, boolean) to authenticated;

alter table public.comments replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.comment_reports;
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end;
$$;

commit;
