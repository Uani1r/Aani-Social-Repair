-- إشعارات الستوري من جهة قاعدة البيانات:
--   1) إعجاب بالستوري  → type = 'like'  , content_kind = 'story', reference_id = story_id
--   2) رد على الستوري  → type = 'reply' , content_kind = 'story', reference_id = story_id
-- مع منع أي ازدواج مع إشعار الرسالة العام (type = 'message') للردود على الستوري.
--
-- Idempotent بالكامل: create or replace function + drop trigger if exists.
-- لا يُنشئ جداول ولا أعمدة إلزامية جديدة، ولا يمسّ أي مشغّل قائم آخر.
--
-- يعتمد على ما هو موجود فعلاً في المخطط:
--   public.stories(id, user_id)
--   public.story_likes(id, story_id, user_id, created_at)   unique(story_id, user_id)
--   public.messages(id, sender_id, recipient_id, content, story_id, created_at)
--   public.notifications(id, user_id, actor_id, type, content, reference_id,
--                        entity_id, comment_id, is_read, content_kind, created_at)
--   public.profiles.notification_settings jsonb {messages, followers, interactions, stories}
--   public.aani_is_user_blocked(uuid, uuid)                 (20261115000000)
--   public.aani_notify_on_message_insert()                  (20261226000000) ← يُعاد تعريفه هنا
--   public.aani_attach_notification_content_metadata()      (20261230000000) ← يُعاد تعريفه هنا
--
-- لا يعتمد على 20270128000000: دالة إعدادات الستوري معرَّفة هنا باسم مستقل.
-- لا يطابق/يحذف أي إشعار قديم، ولا يُنشئ إشعاراً عند إلغاء الإعجاب.

begin;

-- عمود نوع المحتوى (موجود من 20261230000000؛ هذا السطر احترازي فقط)
alter table public.notifications add column if not exists content_kind text;

-- ---------------------------------------------------------------------------
-- 1) هل إشعارات "الستوري" مفعّلة لصاحب الحساب؟ (افتراضي: نعم)
--    قراءة آمنة لـ JSON: قيمة غير منطقية/NULL/مفتاح غائب ⇒ true
--    بدل رفع استثناء يُفشل الإعجاب أو إرسال الرد.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) بيانات المحتوى: لا تُلمس إشعارات الستوري
--    (نفس جسم 20261230000000 + خروج مبكر عند content_kind = 'story')
-- ---------------------------------------------------------------------------
create or replace function public.aani_attach_notification_content_metadata()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_post_id uuid;
  resolved_post_type text;
begin
  -- إشعار ستوري: reference_id هو معرّف الستوري وليس منشوراً، فلا يُشتق
  -- منه content_kind ولا يُدهس المعرّف.
  if new.content_kind = 'story' then
    return new;
  end if;

  if lower(new.type) in ('like', 'post_like', 'comment', 'reply', 'mention', 'repost') then
    resolved_post_id := coalesce(new.reference_id, new.entity_id);

    if resolved_post_id is null and new.comment_id is not null then
      select c.post_id into resolved_post_id
      from public.comments c
      where c.id = new.comment_id
      limit 1;
    end if;

    if resolved_post_id is not null then
      select p.type into resolved_post_type
      from public.posts p
      where p.id = resolved_post_id
      limit 1;

      if found then
        new.content_kind := resolved_post_type;
        if new.reference_id is null then
          new.reference_id := resolved_post_id;
        end if;
        if new.entity_id is null then
          new.entity_id := resolved_post_id;
        end if;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists aani_attach_notification_content_metadata on public.notifications;
create trigger aani_attach_notification_content_metadata
before insert on public.notifications
for each row execute function public.aani_attach_notification_content_metadata();

-- ---------------------------------------------------------------------------
-- 3) إشعار الرسالة العام: يتخطى الردود على الستوري كي لا يتكرر الإشعار
--    (الرد على الستوري له مشغّله المستقل في القسم 5).
--    يُتخطى فقط عندما يكون صاحب الستوري هو مستقبل الرسالة، فلا تُفقد
--    إشعارات أي حالة شاذة أخرى.
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_story_owner uuid;
begin
  if new.story_id is not null and new.content like '[story-reply]%' then
    select story.user_id into v_story_owner
    from public.stories as story
    where story.id = new.story_id;

    if v_story_owner is not null and v_story_owner = new.recipient_id then
      return new;
    end if;
  end if;

  if new.sender_id is null
    or new.recipient_id is null
    or new.sender_id = new.recipient_id
    or new.content like '[aani-call:v1]%'
    or exists (
      select 1
      from public.profiles as recipient
      where recipient.id = new.recipient_id
        and recipient.notification_settings->'messages' = 'false'::jsonb
    ) then
    return new;
  end if;

  insert into public.notifications (user_id, actor_id, type, content, reference_id)
  values (new.recipient_id, new.sender_id, 'message', 'أرسل لك رسالة', new.id);

  return new;
end;
$$;
revoke all on function public.aani_notify_on_message_insert() from public, anon, authenticated;

drop trigger if exists aani_message_notification_after_insert on public.messages;
create trigger aani_message_notification_after_insert
after insert on public.messages
for each row execute function public.aani_notify_on_message_insert();

-- ---------------------------------------------------------------------------
-- 4) إعجاب بستوري
--    - لا إشعار لإعجاب صاحب الستوري بستوره.
--    - لا إشعار عند حظر متبادل.
--    - يحترم notification_settings.stories.
--    - story_likes: unique(story_id, user_id) ⇒ حدث واحد لكل إعجاب نشط،
--      وإعادة الإعجاب بعد إلغائه صف جديد ⇒ إشعار جديد مشروع.
--    - لا مشغّل على DELETE ⇒ إلغاء الإعجاب لا يُنشئ إشعاراً.
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_story_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select story.user_id into v_owner
  from public.stories as story
  where story.id = new.story_id;

  if v_owner is null then return new; end if;
  if v_owner = new.user_id then return new; end if;
  if public.aani_is_user_blocked(new.user_id, v_owner) then return new; end if;
  if not public.aani_story_notifications_enabled(v_owner) then return new; end if;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.user_id, 'like', 'أعجب بستوريك', new.story_id, new.story_id, null, 'story');

  return new;
end;
$$;
revoke all on function public.aani_notify_story_like() from public, anon, authenticated;

drop trigger if exists aani_notify_story_like_trg on public.story_likes;
create trigger aani_notify_story_like_trg
after insert on public.story_likes
for each row execute function public.aani_notify_story_like();

-- ---------------------------------------------------------------------------
-- 5) رد على ستوري (رسالة مباشرة تحمل story_id وبادئة [story-reply])
--    - user_id = صاحب الستوري ، actor_id = صاحب الرد.
--    - الرد يجب أن يكون موجهاً لصاحب الستوري.
--    - لا إشعار ذاتي، لا حظر متبادل، يحترم notification_settings.stories.
--    - كل رسالة رد هي حدث مستقل ⇒ ردود متعددة على الستوري نفسها تعطي
--      إشعاراً لكل رد (ولا تتعارض مع الفهرس aani_messages_story_unique لأنها
--      مستثناة صراحةً من الفهرس الجزئي في 20261109000000).
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_story_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.story_id is null then return new; end if;
  if new.content is null or new.content not like '[story-reply]%' then return new; end if;
  if new.sender_id is null or new.recipient_id is null then return new; end if;
  if new.sender_id = new.recipient_id then return new; end if;

  select story.user_id into v_owner
  from public.stories as story
  where story.id = new.story_id;

  if v_owner is null then return new; end if;
  if v_owner <> new.recipient_id then return new; end if;
  if v_owner = new.sender_id then return new; end if;
  if public.aani_is_user_blocked(new.sender_id, v_owner) then return new; end if;
  if not public.aani_story_notifications_enabled(v_owner) then return new; end if;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.sender_id, 'reply', 'رد على ستوريك', new.story_id, new.story_id, null, 'story');

  return new;
end;
$$;
revoke all on function public.aani_notify_story_reply() from public, anon, authenticated;

drop trigger if exists aani_notify_story_reply_trg on public.messages;
create trigger aani_notify_story_reply_trg
after insert on public.messages
for each row execute function public.aani_notify_story_reply();

commit;

-- تحقق بعد التطبيق (اختياري):
-- select tgname, tgrelid::regclass from pg_trigger
--  where tgname in ('aani_notify_story_like_trg',
--                   'aani_notify_story_reply_trg',
--                   'aani_message_notification_after_insert',
--                   'aani_attach_notification_content_metadata');
