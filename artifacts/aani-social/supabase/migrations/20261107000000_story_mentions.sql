-- نظام الإشارة إلى الأشخاص في الستوري (مخفي بصرياً، مخزّن فعلياً)

create table if not exists public.story_mentions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  mentioned_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint aani_story_mentions_unique unique (story_id, mentioned_id)
);

create index if not exists aani_story_mentions_mentioned_idx
  on public.story_mentions (mentioned_id, created_at desc);

alter table public.story_mentions enable row level security;
grant select, insert, delete on public.story_mentions to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_mentions'
      and policyname = 'aani_story_mentions_select'
  ) then
    -- يرى الإشارة صاحب الستوري والمُشار إليه
    create policy aani_story_mentions_select on public.story_mentions
      for select to authenticated
      using (author_id = (select auth.uid()) or mentioned_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_mentions'
      and policyname = 'aani_story_mentions_insert_own'
  ) then
    create policy aani_story_mentions_insert_own on public.story_mentions
      for insert to authenticated
      with check (author_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'story_mentions'
      and policyname = 'aani_story_mentions_delete_own'
  ) then
    create policy aani_story_mentions_delete_own on public.story_mentions
      for delete to authenticated
      using (author_id = (select auth.uid()));
  end if;
end $$;

-- ربط الرسائل الخاصة بالستوري المُشار إليها (بطاقة غنية بدل نص)
alter table public.messages
  add column if not exists story_id uuid references public.stories(id) on delete set null;

create index if not exists aani_messages_story_idx
  on public.messages (story_id);

-- إعادة مشاركة الستوري بالرجوع إلى الأصل دون نسخ الملف
alter table public.stories
  add column if not exists original_story_id uuid references public.stories(id) on delete set null,
  add column if not exists share_type text not null default 'original';
