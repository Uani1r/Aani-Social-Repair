-- Story thumbnails + structured story reply/like notifications.
--
-- Adds:
--   * public.stories.thumbnail_url        : صورة مصغرة ثابتة (صورة، إطار فيديو أول، أو صورة مشتركة)
--   * public.notifications.metadata jsonb : بيانات منظمة لبطاقة الإشعار
--   * public.aani_set_story_thumbnail()   : حفظ الصورة المصغرة من مالك الستوري فقط
--   * aani_notify_story_like()            : إضافة metadata للصورة المصغرة على إشعار الإعجاب
--
-- Idempotent: add column if not exists / create or replace / drop trigger if exists.
-- لا يحذف أعمدة أو صفوفاً أو سياسات، ولا يغيّر RLS أو الصلاحيات القائمة.
-- لا يعتمد على messages.story_id ولا على aani_notify_story_reply: ردود الستوري
-- صارت تُسجَّل في notifications من الواجهة مباشرة، دون إنشاء رسالة خاصة.
-- يعتمد على: public.stories(id,user_id,media_url,media_type) ، public.notifications
--   public.user_blocks(blocker_id + blocked_id أو blocked_user_id) ، public.profiles.

begin;

-- 1) الصورة المصغرة للستوري
alter table public.stories
  add column if not exists thumbnail_url text;

-- 2) بيانات منظمة للإشعار (kind/story_id/story_reply_text/story_thumbnail_url/...)
alter table public.notifications
  add column if not exists metadata jsonb;

-- 3) إعداد إشعارات الستوري لصاحب الحساب (نفس تعريف 20270129000000 —
--    معرَّف هنا أيضاً كي يعمل هذا الترحيل وحده دون الاعتماد على ترتيب التطبيق).
create or replace function public.aani_story_notifications_enabled(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select case jsonb_typeof(p.notification_settings -> 'stories')
               when 'boolean' then (p.notification_settings ->> 'stories')::boolean
               else true
             end
      from public.profiles as p
      where p.id = p_user_id
    ),
    true
  );
$$;
revoke all on function public.aani_story_notifications_enabled(uuid) from public, anon, authenticated;

-- 4) حفظ الصورة المصغرة: صاحب الستوري فقط، ورابط http(s) فقط.
create or replace function public.aani_set_story_thumbnail(
  p_story_id uuid,
  p_thumbnail_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;

  if p_thumbnail_url is not null
     and p_thumbnail_url !~* '^https?://[^\s]+$' then
    raise exception 'Invalid thumbnail url' using errcode = '22023';
  end if;

  update public.stories as story
     set thumbnail_url = p_thumbnail_url
   where story.id = p_story_id
     and story.user_id = auth.uid();

  if not found then
    raise exception 'Story not found or not owned by the current user' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.aani_set_story_thumbnail(uuid, text) from public, anon, authenticated;
grant execute on function public.aani_set_story_thumbnail(uuid, text) to authenticated;

-- 5) إشعار الإعجاب: أضف metadata تحمل صورة الستوري المصغرة ونوعها وصاحبها،
--    لتعرض بطاقة الإشعار الصورة حتى لو لم تُحمَّل بيانات الستوري بعد.
create or replace function public.aani_notify_story_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_thumbnail_url text;
  v_media_type text;
  v_is_blocked boolean := false;
begin
  select story.user_id, story.thumbnail_url, story.media_type
    into v_owner, v_thumbnail_url, v_media_type
  from public.stories as story
  where story.id = new.story_id;

  if v_owner is null then return new; end if;
  if v_owner = new.user_id then return new; end if;

  -- حظر بالاتجاهين، من الجدول مباشرة، مع دعم اسمي العمود في البيئات المختلفة.
  select exists (
    select 1
    from public.user_blocks as blk
    where (
      blk.blocker_id = new.user_id
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = v_owner::text
    ) or (
      blk.blocker_id = v_owner
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = new.user_id::text
    )
  ) into v_is_blocked;

  if v_is_blocked then return new; end if;
  if not public.aani_story_notifications_enabled(v_owner) then return new; end if;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind, metadata)
  values
    (
      v_owner,
      new.user_id,
      'like',
      'أعجب بستوريك',
      new.story_id,
      new.story_id,
      null,
      'story',
      jsonb_build_object(
        'kind', 'story_like',
        'story_id', new.story_id,
        'story_thumbnail_url', v_thumbnail_url,
        'story_media_type', v_media_type,
        'story_owner_id', v_owner
      )
    );

  return new;
end;
$$;
revoke all on function public.aani_notify_story_like() from public, anon, authenticated;

drop trigger if exists aani_notify_story_like_trg on public.story_likes;
create trigger aani_notify_story_like_trg
after insert on public.story_likes
for each row execute function public.aani_notify_story_like();

commit;

-- تحقق:
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='stories' and column_name='thumbnail_url';
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='notifications' and column_name='metadata';
-- select proname from pg_proc where proname in ('aani_set_story_thumbnail','aani_notify_story_like');
