-- Persistent group conversations and messages with authenticated membership checks.

create table if not exists public.group_conversations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  avatar text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.group_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.group_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists aani_group_members_user_idx
  on public.group_members(user_id, group_id);
create index if not exists aani_group_messages_history_idx
  on public.group_messages(group_id, created_at);

alter table public.group_conversations enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;

grant select on public.group_conversations, public.group_members, public.group_messages to authenticated;
grant insert on public.group_messages to authenticated;

create or replace function public.aani_is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()
  );
$$;

revoke all on function public.aani_is_group_member(uuid) from public;
grant execute on function public.aani_is_group_member(uuid) to authenticated;

drop policy if exists aani_group_conversations_member_select on public.group_conversations;
create policy aani_group_conversations_member_select on public.group_conversations
  for select to authenticated
  using (public.aani_is_group_member(id));

drop policy if exists aani_group_members_member_select on public.group_members;
create policy aani_group_members_member_select on public.group_members
  for select to authenticated
  using (public.aani_is_group_member(group_id));

drop policy if exists aani_group_messages_member_select on public.group_messages;
create policy aani_group_messages_member_select on public.group_messages
  for select to authenticated
  using (public.aani_is_group_member(group_id));

drop policy if exists aani_group_messages_member_insert on public.group_messages;
create policy aani_group_messages_member_insert on public.group_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.aani_is_group_member(group_id)
  );

create or replace function public.aani_create_group(p_name text, p_member_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_member_ids uuid[];
  v_group public.group_conversations%rowtype;
begin
  if v_creator is null then
    raise exception 'يجب تسجيل الدخول لإنشاء مجموعة.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'اسم المجموعة مطلوب ويجب ألا يتجاوز 60 حرفاً.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct selected.user_id), array[]::uuid[])
    into v_member_ids
  from unnest(coalesce(p_member_ids, array[]::uuid[])) as selected(user_id)
  where selected.user_id is not null and selected.user_id <> v_creator;

  if cardinality(v_member_ids) = 0 then
    raise exception 'اختر عضواً واحداً على الأقل.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(v_member_ids) as selected(user_id)
    where not exists (
      select 1 from public.follows f
      where (f.follower_id = v_creator and f.following_id = selected.user_id)
         or (f.following_id = v_creator and f.follower_id = selected.user_id)
    )
  ) then
    raise exception 'يمكن إضافة الحسابات المرتبطة بك فقط.' using errcode = '42501';
  end if;

  insert into public.group_conversations(name, creator_id, avatar)
  values (v_name, v_creator, left(v_name, 1))
  returning * into v_group;

  insert into public.group_members(group_id, user_id)
  select v_group.id, selected.user_id
  from unnest(array_append(v_member_ids, v_creator)) as selected(user_id);

  return jsonb_build_object(
    'id', v_group.id,
    'name', v_group.name,
    'creatorId', v_group.creator_id,
    'members', to_jsonb(array_append(v_member_ids, v_creator)),
    'avatar', v_group.avatar,
    'createdAt', v_group.created_at
  );
end;
$$;

revoke all on function public.aani_create_group(text, uuid[]) from public;
grant execute on function public.aani_create_group(text, uuid[]) to authenticated;

create or replace function public.aani_get_my_groups()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'creatorId', g.creator_id,
        'members', (
          select coalesce(jsonb_agg(gm.user_id order by gm.joined_at), '[]'::jsonb)
          from public.group_members gm
          where gm.group_id = g.id
        ),
        'avatar', g.avatar,
        'createdAt', g.created_at
      ) order by g.created_at desc
    ),
    '[]'::jsonb
  )
  from public.group_conversations g
  where exists (
    select 1 from public.group_members gm
    where gm.group_id = g.id and gm.user_id = auth.uid()
  );
$$;

revoke all on function public.aani_get_my_groups() from public;
grant execute on function public.aani_get_my_groups() to authenticated;
