-- Aani: repair post interaction counter triggers and rebuild saved counts.
-- Safe to rerun. Paste the complete script into Supabase SQL Editor.
begin;

-- Pause interaction writes while triggers are normalized and counters rebuilt.
lock table public.likes, public.comments, public.reposts, public.post_shares, public.posts
  in share row exclusive mode;

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
      set likes_count = greatest(0, coalesce(likes_count, 0) + delta)
      where id = target_post;
  elsif tg_table_name = 'comments' then
    update public.posts
      set comments_count = greatest(0, coalesce(comments_count, 0) + delta)
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
  trigger_name text;
  existing text;
begin
  foreach target_table in array array['likes', 'comments', 'reposts', 'post_shares']
  loop
    target_rel := format('public.%I', target_table)::regclass;

    -- Remove every trigger on this table that calls the counter function,
    -- regardless of its name, then create one canonical trigger.
    for existing in
      select t.tgname
      from pg_catalog.pg_trigger t
      where t.tgrelid = target_rel
        and not t.tgisinternal
        and t.tgfoid = 'public.aani_sync_post_counters()'::regprocedure
    loop
      execute format('drop trigger if exists %I on public.%I', existing, target_table);
    end loop;

    trigger_name := 'aani_' || target_table || '_counter';
    execute format(
      'create trigger %I after insert or delete on public.%I for each row execute function public.aani_sync_post_counters()',
      trigger_name,
      target_table
    );
  end loop;
end;
$$;

-- Rebuild from the source interaction rows; COUNT(*) is valid PostgreSQL syntax.
update public.posts p set
  likes_count = greatest(0, coalesce((select count(*) from public.likes l where l.post_id = p.id), 0)),
  comments_count = greatest(0, coalesce((select count(*) from public.comments c where c.post_id = p.id), 0)),
  reposts_count = greatest(0, coalesce((select count(*) from public.reposts r where r.post_id = p.id), 0)),
  shares_count = greatest(0, coalesce((select count(*) from public.post_shares s where s.post_id = p.id), 0));

commit;
