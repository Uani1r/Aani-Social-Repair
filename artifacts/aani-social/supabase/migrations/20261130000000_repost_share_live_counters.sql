-- Keep repost/share totals authoritative and make each recipient count as one share.
begin;

alter table public.posts
  add column if not exists reposts_count integer not null default 0,
  add column if not exists shares_count integer not null default 0;

-- A share is an event, not a unique (post, user) relationship: one sender may
-- share the same post with multiple recipients or externally more than once.
drop index if exists public.aani_post_shares_post_user_unique;
create index if not exists aani_post_shares_post_created_idx
  on public.post_shares (post_id, created_at desc);

create or replace function public.aani_sync_post_counters()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_post uuid;
  delta integer;
begin
  if tg_op = 'INSERT' then
    target_post := new.post_id;
    delta := 1;
  elsif tg_op = 'DELETE' then
    target_post := old.post_id;
    delta := -1;
  else
    return null;
  end if;

  if target_post is null then
    return null;
  end if;

  if tg_table_name = 'likes' then
    update public.posts
      set likes_count = case
        when hide_likes then 0
        else greatest(0, coalesce(likes_count, 0) + delta)
      end
      where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts
      set comments_count = case
        when hide_comments then 0
        else greatest(0, coalesce(comments_count, 0) + delta)
      end
      where id = target_post;
  elsif tg_table_name = 'reposts' then
    update public.posts
      set reposts_count = greatest(0, coalesce(reposts_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'post_shares' then
    update public.posts
      set shares_count = greatest(0, coalesce(shares_count, 0) + delta)
      where id = target_post;
  end if;

  return null;
end;
$$;

do $$
declare
  target_table text;
  target_rel regclass;
  existing_trigger text;
begin
  foreach target_table in array array['reposts', 'post_shares']
  loop
    target_rel := format('public.%I', target_table)::regclass;

    for existing_trigger in
      select t.tgname
      from pg_catalog.pg_trigger t
      where t.tgrelid = target_rel
        and not t.tgisinternal
        and t.tgfoid = 'public.aani_sync_post_counters()'::regprocedure
    loop
      execute format('drop trigger if exists %I on public.%I', existing_trigger, target_table);
    end loop;

    execute format(
      'create trigger %I after insert or delete on public.%I for each row execute function public.aani_sync_post_counters()',
      'aani_' || target_table || '_counter',
      target_table
    );
  end loop;
end;
$$;

-- Batch share registration is atomic; its trigger increments shares_count once
-- for each successfully delivered recipient.
create or replace function public.aani_register_post_share(p_post_id uuid, p_count integer default 1)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  total integer := greatest(0, least(coalesce(p_count, 0), 500));
begin
  if actor is null or p_post_id is null or total = 0 then
    return;
  end if;

  if not exists (select 1 from public.posts p where p.id = p_post_id) then
    return;
  end if;

  insert into public.post_shares (post_id, user_id)
  select p_post_id, actor
  from generate_series(1, total);
end;
$$;

revoke all on function public.aani_register_post_share(uuid, integer) from public, anon, authenticated;
grant execute on function public.aani_register_post_share(uuid, integer) to authenticated;

-- Rebuild current totals from interaction rows to repair any previous drift.
update public.posts p
set
  reposts_count = greatest(0, coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0)),
  shares_count = greatest(0, coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0));

-- Clients subscribe to posts for visible aggregate counter updates and to the
-- interaction tables for their own optimistic-state reconciliation.
alter table public.posts replica identity full;
alter table public.reposts replica identity full;
alter table public.post_shares replica identity full;

do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['posts', 'reposts', 'post_shares']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = target_table
      ) then
        begin
          execute format('alter publication supabase_realtime add table public.%I', target_table);
        exception
          when duplicate_object then null;
          when undefined_object then null;
        end;
      end if;
    end loop;
  end if;
end;
$$;

commit;
