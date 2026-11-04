-- Separate Feed and Reels destinations without changing existing post IDs or media.
begin;

alter table public.posts
  add column if not exists destination text not null default 'feed';

-- Existing video posts were previously shown as Reels and in the Feed; keep them in Reels only.
update public.posts
set destination = 'reels'
where type = 'reel' and destination = 'feed';

alter table public.posts drop constraint if exists posts_destination_check;
alter table public.posts
  add constraint posts_destination_check
  check (destination in ('feed', 'reels') and (destination <> 'reels' or type = 'reel'));

create index if not exists posts_destination_created_at_idx
  on public.posts (destination, created_at desc);

commit;
