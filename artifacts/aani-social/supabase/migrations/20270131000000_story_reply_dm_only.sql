-- Story replies are DM-only (v2).
--
-- الهدف:
--   * كل رد على ستوري يُرسل رسالة خاصة واحدة فقط (public.messages).
--   * لا يُنشأ أي إشعار reply بسبب رد الستوري.
--   * لا يُنشأ إشعار message عام لرد الستوري، بينما تبقى إشعارات مشاركة
--     الستوري العادية والرسائل العادية كما هي دون أي تغيير.
--   * الوسم [story-reply] لا يُستخدم في الرسائل الجديدة، لكن الرسائل القديمة
--     التي تحمله تبقى مدعومة في الواجهة.
--   * تُحفظ بيانات معاينة الستوري مع الرسالة نفسها كي تظل بطاقة الرد سليمة
--     بعد انتهاء صلاحية الستوري أو حذف سجله/وسائطه.
--
-- التمييز الدقيق (لا يعتمد على story_id وحده، لأن مشاركة الستوري تحمله أيضاً):
--   * رد ستوري  : messages.story_reply = true، أو الوسم القديم [story-reply].
--   * مشاركة ستوري: content يبدأ بـ[story:...] (+ story_id)، وstory_reply غير مفعّل.
--   * رسالة عادية : لا علامة ولا وسم.
-- لا يُغيّر أي مشغّل آخر، ولا يحذف أي رسالة أو إشعار قائم، ولا يمسّ إشعارات
-- الإعجاب أو التعليق أو المتابعة أو إعجاب الستوري أو أبرز القصص أو مشاركة القصص.
--
-- يعمل على أي قاعدة طبّقت أو لم تُطبّق 20270129000000 / 20270130000000
-- (كل شيء idempotent). ترتيب التطبيق: بعد 20270130000000.

begin;

-- ---------------------------------------------------------------------------
-- 0) الشروط المسبقة: الجداول التي يعتمد عليها الترحيل.
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array['messages', 'notifications', 'profiles', 'stories']
  loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'aani: الجدول public.% غير موجود؛ لا يمكن تطبيق ترحيل ردود الستوري.', v_table
        using errcode = '42P01';
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1) أعمدة بطاقة رد الستوري داخل الرسالة.
--    nullable بالكامل: الرسائل العادية لا تتأثر، وكل الإضافات IF NOT EXISTS.
--    story_reply هي العلامة الصريحة التي تميّز الرد عن مشاركة الستوري، لأن
--    كلتيهما تحمل story_id.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists story_id uuid,
  add column if not exists story_media_url text,
  add column if not exists story_thumbnail_url text,
  add column if not exists story_media_type text,
  add column if not exists story_reply boolean;

-- تحقق من الأنواع الفعلية: عمود قائم بنوع مختلف يقبل الإدراج لكنه يكسر
-- الاستعلامات، فنوقف الترحيل برسالة واضحة بدل افتراض النوع.
do $$
declare
  v_bad_type text;
begin
  select string_agg(format('%s (%s)', col.column_name, col.data_type), ', ')
    into v_bad_type
  from information_schema.columns as col
  where col.table_schema = 'public'
    and col.table_name = 'messages'
    and (
      (col.column_name = 'story_id' and col.data_type <> 'uuid')
      or (col.column_name in ('story_media_url', 'story_thumbnail_url', 'story_media_type')
        and col.data_type <> 'text')
      or (col.column_name = 'story_reply' and col.data_type <> 'boolean')
    );

  if v_bad_type is not null then
    raise exception 'aani: أنواع أعمدة messages غير متوقعة، أصلحها يدوياً قبل الترحيل: %', v_bad_type
      using errcode = '42804';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) إيقاف مشغّل إشعار رد الستوري — هذا هو الضمان الأساسي.
--    المشغّل الذي أنشأه 20270129000000 اسمه aani_notify_story_reply_trg ودالته
--    aani_notify_story_reply(). نُزيل كل مشغّل على messages يستدعي تلك الدالة
--    (بأي اسم) ثم الدالة نفسها. لا نلمس أي مشغّل آخر على messages.
-- ---------------------------------------------------------------------------
do $$
declare
  v_trigger record;
begin
  for v_trigger in
    select trg.tgname
    from pg_catalog.pg_trigger as trg
    where trg.tgrelid = 'public.messages'::regclass
      and not trg.tgisinternal
      and trg.tgfoid = to_regprocedure('public.aani_notify_story_reply()')
  loop
    execute format('drop trigger if exists %I on public.messages', v_trigger.tgname);
  end loop;
end $$;

drop function if exists public.aani_notify_story_reply();

-- ---------------------------------------------------------------------------
-- 3) إشعار الرسائل العامة: رد الستوري فقط لا يُنشئ إشعاراً.
--    التمييز: story_reply = true أو الوسم القديم. مشاركة الستوري ([story:...]
--    مع story_id) والرسالة العادية تُنشئ إشعار message كما كانت تماماً.
--    لا تُنشأ مشغّلات هنا: قاعدة أزالت aani_message_notification_after_insert
--    عمداً لا يجوز أن تعود إليها الإشعارات.
-- ---------------------------------------------------------------------------
create or replace function public.aani_notify_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_story_reply boolean;
begin
  -- قراءة الحقول عبر to_jsonb تتفادى أي اختلاف في بنية الجدول بين البيئات.
  v_is_story_reply := coalesce(to_jsonb(new) ->> 'story_reply', '') in ('true', 't', '1')
    or coalesce(new.content, '') like '[story-reply]%';

  -- رد ستوري: بطاقته في المحادثة نفسها، بلا إشعار عام.
  if v_is_story_reply then return new; end if;

  if new.sender_id is null
    or new.recipient_id is null
    or new.sender_id = new.recipient_id
    or coalesce(new.content, '') like '[aani-call:v1]%'
    or exists (
      select 1
      from public.profiles as recipient
      where recipient.id = new.recipient_id
        and recipient.notification_settings::jsonb->'messages' = 'false'::jsonb
    ) then
    return new;
  end if;

  insert into public.notifications (user_id, actor_id, type, content, reference_id)
  values (new.recipient_id, new.sender_id, 'message', 'أرسل لك رسالة', new.id);

  return new;
end;
$$;
revoke all on function public.aani_notify_on_message_insert() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) شبكة أمان متوافقة مع بنية الإشعارات الفعلية.
--    إشعار رد الستوري القديم لم يكن يحمل messages.id: مشغّل
--    aani_notify_story_reply() كان يضع story_id في reference_id وentity_id مع
--    content_kind = 'story'، والواجهة كانت تكتب metadata.kind = 'story_reply'.
--    لذلك نغطي الحالتين:
--      أ) type = 'reply'  : إشعار يشير إلى ستوري (reference/entity) أو يحمل
--         content_kind = 'story'/'highlight' أو metadata.kind = story_reply/
--         highlight_reply ⇒ يُحجب.
--      ب) type = 'message': يُحجب فقط إذا كانت الرسالة المشار إليها برد ستوري
--         بعلامته الصريحة أو الوسم القديم. مشاركة الستوري والرسالة العادية
--         تمرّان كما هما.
--    الحذف في القسم 2 هو الضمان الأساسي؛ هذه شبكة دفاع ثانية لأي مسار آخر.
-- ---------------------------------------------------------------------------
create or replace function public.aani_block_story_reply_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := coalesce(new.type, '');
  v_content_kind text;
  v_metadata_kind text;
  v_reference_id uuid;
  v_entity_id uuid;
  v_message_row jsonb;
begin
  if v_type not in ('message', 'reply') then return new; end if;

  v_content_kind := to_jsonb(new) ->> 'content_kind';
  v_metadata_kind := to_jsonb(new) -> 'metadata' ->> 'kind';

  begin
    v_reference_id := nullif(to_jsonb(new) ->> 'reference_id', '')::uuid;
  exception
    when others then
      v_reference_id := null;
  end;

  begin
    v_entity_id := nullif(to_jsonb(new) ->> 'entity_id', '')::uuid;
  exception
    when others then
      v_entity_id := null;
  end;

  if v_type = 'reply' then
    if coalesce(v_content_kind, '') in ('story', 'highlight')
      or coalesce(v_metadata_kind, '') in ('story_reply', 'highlight_reply') then
      return null;
    end if;

    if v_reference_id is not null and exists (
      select 1 from public.stories as story where story.id = v_reference_id
    ) then
      return null;
    end if;

    if v_entity_id is not null and exists (
      select 1 from public.stories as story where story.id = v_entity_id
    ) then
      return null;
    end if;

    return new;
  end if;

  -- type = 'message'
  if v_reference_id is null then return new; end if;

  select to_jsonb(msg)
    into v_message_row
  from public.messages as msg
  where msg.id = v_reference_id;

  if v_message_row is null then return new; end if;

  if coalesce(v_message_row ->> 'story_reply', '') in ('true', 't', '1')
    or coalesce(v_message_row ->> 'content', '') like '[story-reply]%' then
    return null;
  end if;

  return new;
end;
$$;
revoke all on function public.aani_block_story_reply_notifications() from public, anon, authenticated;

drop trigger if exists aani_block_story_reply_notifications_trg on public.notifications;
create trigger aani_block_story_reply_notifications_trg
before insert on public.notifications
for each row execute function public.aani_block_story_reply_notifications();

commit;

-- تحقق (قراءة فقط) بعد التطبيق:
-- 1) الأعمدة الجديدة:
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'messages'
--    and column_name in ('story_id', 'story_media_url', 'story_thumbnail_url',
--                        'story_media_type', 'story_reply')
--  order by column_name;
-- 2) مشغّلات messages (المتوقع ألا يظهر aani_notify_story_reply_trg):
-- select t.tgname, p.proname, t.tgenabled
--   from pg_trigger t
--   join pg_proc p on p.oid = t.tgfoid
--  where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal
--  order by t.tgname;
-- 3) الدوال (to_regprocedure يعيد NULL عند الغياب):
-- select to_regprocedure('public.aani_notify_story_reply()') as story_reply_function,
--        to_regprocedure('public.aani_notify_on_message_insert()') as message_function,
--        to_regprocedure('public.aani_block_story_reply_notifications()') as safety_function;
-- 4) وجود شبكة الأمان على notifications:
-- select t.tgname, p.proname
--   from pg_trigger t
--   join pg_proc p on p.oid = t.tgfoid
--  where t.tgrelid = 'public.notifications'::regclass
--    and t.tgname = 'aani_block_story_reply_notifications_trg';
-- 5) إشعارات رد ستوري قديمة (لا تُحذف، للعلم فقط):
-- select count(*) from public.notifications where type = 'reply';
