-- إشعارات الستوري من جهة قاعدة البيانات + إصلاح المخطط messages.story_id
--
-- سبب الحاجة إلى هذا التصحيح (نتيجة مراجعة سجل الترحيلات):
--   * العمود public.messages.story_id يُضاف في ملفين فقط:
--       20261107000000_story_mentions.sql                        (سطر 53-54)
--       20261108000000_story_followers_reshare_security.sql       (سطر 15-16)
--     وكلٌّ منهما لا يُطبَّق على قاعدة الإنتاج، بينما ملفا الأساس
--     (schema.sql / fresh_schema_cloudflare_r2.sql) ينشئان public.messages
--     بدون story_id أصلاً. فأي قاعدة أُنشئت من الأساس أو تخطّت هذين الملفين
--     تبقى بلا العمود.
--     دليل إضافي: 20261109000000_story_views.sql ينشئ فهرساً فريداً على
--     (recipient_id, story_id) وهو مستحيل بلا العمود ⇒ الثلاثة لم تُطبَّق.
--   * مشغّلان على public.messages يقرآن NEW.story_id:
--       - aani_message_notification_after_insert  (أعاد ترحيل 20270129
--         السابق إنشاءه خطأً، وهو في الأصل محذوف!)
--       - aani_notify_story_reply_trg              (جديد من هذا العمل)
--     فكان أي إدراج في messages يفشل بـ 42703 "record new has no field story_id".
--
-- ما يفعله هذا الملف (كله داخل معاملة واحدة، وقابل لإعادة التشغيل):
--   1) يضيف messages.story_id (nullable) إن كان غائباً، مع مفتاح أجنبي إلى
--      public.stories(id) و ON DELETE SET NULL (يُفحص وجود القيد أولاً) وفهرس.
--   2) يعيد ضبط إشعار الرسالة العام بما يطابق نيّة 20261228000000 و
--      20261229000000: لا سجل إشعار عام لكل رسالة (رسائل FCM عبر Webhook)،
--      وبالتالي لا إشعار message مكرر لردود الستوري. وإن كانت قاعدة قديمة
--      ما زالت تملك المشغّل، يُعاد تعريف دالته بجسم آمن يتخطى ردود الستوري
--      ويقرأ story_id عبر to_jsonb فلا يفشل أبداً إن غاب العمود.
--   3) إشعار إعجاب بالستوري وإشعار رد على ستوري (content_kind = 'story').
--   4) إبقاء metadata trigger بعيداً عن إشعارات الستوري.
--
-- يعتمد على: public.stories(id,user_id) ، public.story_likes(story_id,user_id)
--   public.messages(id,sender_id,recipient_id,content,created_at)
--   public.notifications(... content_kind,entity_id,comment_id)
--   public.aani_is_user_blocked(uuid,uuid)  (20261115000000)
--   public.aani_block_message_call_notifications() (20261229000000 — إن وُجد)
-- لا يعتمد على 20270128000000: دالة إعدادات الستوري معرَّفة هنا باسم مستقل.

begin;

-- ---------------------------------------------------------------------------
-- 1) إصلاح المخطط: messages.story_id
--    nullable حتى لا تتأثر الرسائل العادية، والإضافة idempotent.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists story_id uuid;

-- المفتاح الأجنبي: لا يُضاف إن كان هناك قيد FK قائم يشمل story_id.
do $$
declare
  v_has_fk boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_constraint as con
    join pg_catalog.pg_class as tbl on tbl.oid = con.conrelid
    join pg_catalog.pg_namespace as ns on ns.oid = tbl.relnamespace
    join pg_catalog.pg_attribute as att
      on att.attrelid = tbl.oid
     and att.attnum = any (con.conkey)
    where ns.nspname = 'public'
      and tbl.relname = 'messages'
      and con.contype = 'f'
      and att.attname = 'story_id'
  )
  into v_has_fk;

  if not v_has_fk then
    alter table public.messages
      add constraint aani_messages_story_id_fkey
      foreign key (story_id) references public.stories (id) on delete set null;
  end if;
exception
  when duplicate_object then
    null;
  when others then
    -- لا نُفشل الترحيل بسبب بيانات شاذة محتملة في نسخة قديمة، لكن نسجّل السبب.
    raise warning 'aani: تعذر إنشاء مفتاح messages.story_id → stories(id): %', sqlerrm;
end $$;

create index if not exists aani_messages_story_idx
  on public.messages (story_id);

-- ---------------------------------------------------------------------------
-- 2) عمود نوع المحتوى (موجود من 20261230000000؛ احترازي فقط)
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists content_kind text;

-- ---------------------------------------------------------------------------
-- 3) إعداد إشعارات الستوري لصاحب الحساب (افتراضي: نعم)
--    قراءة آمنة لـ JSON: قيمة غير منطقية/NULL/مفتاح غائب ⇒ true
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
-- 4) بيانات المحتوى: لا تُلمس إشعارات الستوري
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

-- نفس المشغّل القائم (اسم واحد، دالة واحدة) يُعاد ربطه بالجسم المحدَّث.
drop trigger if exists aani_attach_notification_content_metadata on public.notifications;
create trigger aani_attach_notification_content_metadata
before insert on public.notifications
for each row execute function public.aani_attach_notification_content_metadata();

-- ---------------------------------------------------------------------------
-- 5) إشعار الرسالة العام: جسم آمن يتخطى ردود الستوري
--    يُقرأ story_id عبر to_jsonb(new) فلا يمكن أن يفشل إدراج رسالة حتى لو
--    كان العمود غائباً في نسخة أقدم. إشعارات الرسائل العادية تبقى كما هي
--    تماماً (نفس الشروط ونفس السجل).
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_story_id uuid;
  v_story_owner uuid;
begin
  begin
    v_story_id := nullif(to_jsonb(new) ->> 'story_id', '')::uuid;
  exception
    when others then
      v_story_id := null;
  end;

  if v_story_id is not null and new.content like '[story-reply]%' then
    select story.user_id into v_story_owner
    from public.stories as story
    where story.id = v_story_id;

    -- رد الستوري له مشغّله المستقل؛ لا إشعار message مكرر.
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

-- استعادة نيّة 20261228000000 + 20261229000000: لا سجل إشعار عام لكل رسالة.
-- إذا كانت القاعدة قد طبّقت 20261229 (دالة الحجب موجودة) فهذا الترحيل يزيل
-- المشغّل والدالة اللذين أعاد ترحيل 20270129 السابق إنشاءهما خطأً ويعيد
-- الحالة المقصودة. أما قاعدة قديمة بلا 20261229 فيبقى مشغّلها كما هو، لكن
-- بجسم آمن لا يفشل ولا يكرر إشعار رد الستوري.
do $$
begin
  if to_regprocedure('public.aani_block_message_call_notifications()') is not null then
    drop trigger if exists aani_message_notification_after_insert on public.messages;
    begin
      drop function if exists public.aani_notify_on_message_insert();
    exception
      when dependent_objects_still_exist then
        raise warning 'aani: دالة إشعار الرسائل ما زالت مرتبطة بكائن آخر ولم تُحذف.';
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) رد على ستوري
--    كل رسالة رد حدث مستقل ⇒ ردود متعددة على الستوري نفسها = إشعار لكل رد
--    (الفهرس الجزئي aani_messages_story_unique يستثني [story-reply] صراحةً).
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_story_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_story_id uuid;
  v_owner uuid;
begin
  begin
    v_story_id := nullif(to_jsonb(new) ->> 'story_id', '')::uuid;
  exception
    when others then
      v_story_id := null;
  end;

  if v_story_id is null then return new; end if;
  if new.content is null or new.content not like '[story-reply]%' then return new; end if;
  if new.sender_id is null or new.recipient_id is null then return new; end if;
  if new.sender_id = new.recipient_id then return new; end if;

  select story.user_id into v_owner
  from public.stories as story
  where story.id = v_story_id;

  if v_owner is null then return new; end if;
  if v_owner <> new.recipient_id then return new; end if;
  if v_owner = new.sender_id then return new; end if;
  if public.aani_is_user_blocked(new.sender_id, v_owner) then return new; end if;
  if not public.aani_story_notifications_enabled(v_owner) then return new; end if;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.sender_id, 'reply', 'رد على ستوريك', v_story_id, v_story_id, null, 'story');

  return new;
end;
$$;
revoke all on function public.aani_notify_story_reply() from public, anon, authenticated;

drop trigger if exists aani_notify_story_reply_trg on public.messages;
create trigger aani_notify_story_reply_trg
after insert on public.messages
for each row execute function public.aani_notify_story_reply();

-- ---------------------------------------------------------------------------
-- 7) إعجاب بستوري
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

commit;

-- تحقق بعد التطبيق (اختياري):
-- select column_name, is_nullable, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'messages' and column_name = 'story_id';
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.messages'::regclass and contype = 'f';
-- select tgname from pg_trigger
--  where tgrelid = 'public.messages'::regclass and not tgisinternal;
-- المتوقع على قاعدة طبّقت 20261229: لا aani_message_notification_after_insert،
-- ومعها aani_notify_story_reply_trg من إشعارات هذا الملف فقط.
