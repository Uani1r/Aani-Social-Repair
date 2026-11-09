begin;

alter table public.posts
  add column if not exists display_order integer not null default 0;

with ranked_posts as (
  select id, row_number() over (partition by user_id order by created_at desc, id) - 1 as display_order
  from public.posts
)
update public.posts as post
set display_order = ranked_posts.display_order
from ranked_posts
where ranked_posts.id = post.id;

create index if not exists posts_user_display_order_idx
  on public.posts (user_id, display_order, created_at desc);

-- Posts use column-level SELECT grants to keep allowed_commenters private.
grant select (display_order) on table public.posts to authenticated;

alter table public.profile_highlight_collections
  add column if not exists display_order integer not null default 0;

with ranked_collections as (
  select id, row_number() over (partition by user_id order by created_at, id) - 1 as display_order
  from public.profile_highlight_collections
)
update public.profile_highlight_collections as collection
set display_order = ranked_collections.display_order
from ranked_collections
where ranked_collections.id = collection.id;

create index if not exists aani_profile_highlight_collections_user_display_order_idx
  on public.profile_highlight_collections (user_id, display_order, created_at, id);

create or replace function public.aani_assign_profile_highlight_collection_display_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.display_order, 0) = 0 then
    select coalesce(max(collection.display_order), -1) + 1
      into new.display_order
    from public.profile_highlight_collections as collection
    where collection.user_id = new.user_id;
  end if;
  return new;
end;
$$;

alter function public.aani_assign_profile_highlight_collection_display_order() owner to postgres;
revoke all on function public.aani_assign_profile_highlight_collection_display_order() from public;
drop trigger if exists aani_profile_highlight_collection_display_order on public.profile_highlight_collections;
create trigger aani_profile_highlight_collection_display_order
  before insert on public.profile_highlight_collections
  for each row execute function public.aani_assign_profile_highlight_collection_display_order();

create or replace function public.aani_reorder_profile_content(
  p_kind text,
  p_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_owned_count bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_ids is null then
    raise exception using errcode = '22023', message = 'An ordered item list is required';
  end if;

  if cardinality(p_ids) <> (
    select count(distinct requested.id)
    from unnest(p_ids) as requested(id)
  ) then
    raise exception using errcode = '22023', message = 'The ordered item list contains duplicates';
  end if;

  if p_kind = 'posts' then
    select count(*) into v_owned_count
    from public.posts as post
    where post.user_id = v_user_id
      and post.id = any(p_ids);

    if v_owned_count <> cardinality(p_ids) then
      raise exception using errcode = '42501', message = 'One or more posts are not owned by the current user';
    end if;

    update public.posts as post
    set display_order = requested.ordinality::integer - 1
    from unnest(p_ids) with ordinality as requested(id, ordinality)
    where post.id = requested.id
      and post.user_id = v_user_id;
  elsif p_kind = 'highlights' then
    select count(*) into v_owned_count
    from public.profile_highlight_collections as collection
    where collection.user_id = v_user_id
      and collection.id = any(p_ids);

    if v_owned_count <> cardinality(p_ids) then
      raise exception using errcode = '42501', message = 'One or more highlight collections are not owned by the current user';
    end if;

    update public.profile_highlight_collections as collection
    set display_order = requested.ordinality::integer - 1
    from unnest(p_ids) with ordinality as requested(id, ordinality)
    where collection.id = requested.id
      and collection.user_id = v_user_id;
  else
    raise exception using errcode = '22023', message = 'Unsupported profile content type';
  end if;
end;
$$;

alter function public.aani_reorder_profile_content(text, uuid[]) owner to postgres;
revoke all on function public.aani_reorder_profile_content(text, uuid[]) from public;
grant execute on function public.aani_reorder_profile_content(text, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
