-- إشعارات الستوري من جهة قاعدة البيانات + إصلاح المخطط messages.story_id
--
-- سبب الحاجة إلى هذا التصحيح (من قراءة تعريفات الترحيلات نفسها لا التعليقات):
--   * العمود public.messages.story_id يُضاف في ملفين فقط:
--       20261107000000_story_mentions.sql                        (سطر 53-54)
--       20261108000000_story_followers_reshare_security.sql       (سطر 15-16)
--     وملفا الأساس (schema.sql سطر 276 / fresh_schema_cloudflare_r2.sql سطر 279)
--     ينشئان public.messages بدون story_id أصلاً. والدليل على أن ملفي الإضافة
--     لم يُطبَّقا: 20261109000000_story_views.sql سطر 16-18 ينشئ فهرساً فريداً
--     على (recipient_id, story_id) وهو مستحيل بلا العمود.
--   * المشغّل aani_message_notification_after_insert أعاد ترحيل 20270129
--     السابق إنشاءه خطأً، وهو محذوف عمداً في 20261228000000 (سطر 8-9) و
--     20261229000000 (سطر 9-10) لأن إشعارات الرسائل تُرسل عبر FCM Webhook
--     وليست سجلات في public.notifications. وكان يقرأ NEW.story_id فيُفشل كل
--     إدراج رسالة بخطأ 42703 على مخطط بلا العمود.
--
-- ما يفعله هذا الملف (معاملة واحدة، وقابل لإعادة التشغيل):
--   0) يتحقق من الشروط المسبقة (جداول + دالة الحظر بتوقيعها ونوع إرجاعها)
--      ويُفشل الترحيل فوراً إن غاب شيء بدل المتابعة على أساس خاطئ.
--   1) يضيف messages.story_id (nullable) + يرفض المتابعة إن وُجدت قيم يتيمة،
--      ثم ينشئ المفتاح الأجنبي إلى public.stories(id) ON DELETE SET NULL.
--      أي فشل في إنشاء القيد يُفشل الترحيل بالكامل (لا WHEN OTHERS هنا).
--   2) يعيد تعريف دالة إشعار الرسالة العام بجسم آمن يتخطى ردود الستوري.
--   3) يزيل مشغّل/دالة إشعار الرسالة العام إذا كانت القاعدة تتبع تصميم
--      20261228/20261229 (يُكشف ذلك من وجود aani_block_message_call_notifications
--      أو مشغّله) لأن الترحيل السابق أعاد إنشاءهما خطأً.
--   4) إشعار إعجاب الستوري وإشعار رد الستوري (content_kind = 'story').
--   5) يمنع metadata trigger من تحويل مرجع الستوري إلى منشور.
--
-- يعتمد على (موجودة فعلياً في السلسلة):
--   public.stories(id,user_id) ، public.story_likes(story_id,user_id)
--   public.messages(id,sender_id,recipient_id,content,created_at)
--   public.notifications(reference_id, entity_id, comment_id, content_kind)
--   public.profiles.notification_settings jsonb
--   public.aani_is_user_blocked(uuid,uuid)  (20261115000000)
-- لا يعتمد على 20270128000000: دالة إعدادات الستوري معرَّفة هنا باسم مستقل.

begin;

-- ---------------------------------------------------------------------------
-- 0) شروط مسبقة صريحة: تُفشل الترحيل إن لم تتحقق، بدل الفشل الصامت لاحقاً.
-- ---------------------------------------------------------------------------
do $$
declare
  v_block_check_oid oid;
  v_return_type regtype;
  v_table text;
begin
  v_block_check_oid := to_regprocedure('public.aani_is_user_blocked(uuid,uuid)');

  if v_block_check_oid is null then
    raise exception 'aani: الدالة public.aani_is_user_blocked(uuid,uuid) غير موجودة؛ طبّق 20261115000000_story_viewer_actions.sql أولاً.'
      using errcode = '42883';
  end if;

  select proc.prorettype into v_return_type
  from pg_catalog.pg_proc as proc
  where proc.oid = v_block_check_oid;

  if v_return_type is distinct from 'boolean'::regtype then
    raise exception 'aani: توقيع aani_is_user_blocked يجب أن يُعيد boolean، والموجود %.', v_return_type
      using errcode = '42804';
  end if;

  foreach v_table in array array['messages', 'stories', 'story_likes', 'profiles', 'notifications', 'user_blocks']
  loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'aani: الجدول public.% غير موجود؛ لا يمكن تطبيق ترحيل إشعارات الستوري.', v_table
        using errcode = '42P01';
    end if;
  end loop;

  -- دالة إعدادات الستوري تعتمد على هذا العمود.
  if not exists (
    select 1
    from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'profiles'
      and col.column_name = 'notification_settings'
  ) then
    raise exception 'aani: العمود public.profiles.notification_settings غير موجود؛ طبّق 20261219000000_user_preferences.sql أولاً.'
      using errcode = '42703';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) إصلاح المخطط: messages.story_id
--    nullable حتى لا تتأثر الرسائل العادية، والإضافة idempotent.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists story_id uuid;

-- قيم يتيمة (إن كان العمود موجوداً مسبقاً ببيانات) تمنع إنشاء المفتاح؛
-- نفشل برسالة واضحة بدل خطأ foreign key غامض.
do $$
begin
  if exists (
    select 1
    from public.messages as msg
    where msg.story_id is not null
      and not exists (
        select 1 from public.stories as story where story.id = msg.story_id
      )
  ) then
    raise exception 'aani: يوجد public.messages.story_id يشير إلى قصص غير موجودة؛ نظّف هذه القيم قبل تطبيق الترحيل (select * from public.messages where story_id is not null and story_id not in (select id from public.stories)).'
      using errcode = '23503';
  end if;
end $$;

-- المفتاح الأجنبي: يُنشأ فقط إن لم يكن هناك قيد FK قائم يشمل story_id.
-- لا يوجد أي exception handler هنا: أي تعذّر يُفشل الترحيل ويعيد المعاملة كاملة.
do $$
begin
  if not exists (
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
  ) then
    alter table public.messages
      add constraint aani_messages_story_id_fkey
      foreign key (story_id) references public.stories (id) on delete set null;
  end if;
end $$;

-- شرط لاحق: لا ينجح الترحيل إلا إذا كان القيد موجوداً فعلاً بعد المحاولة.
do $$
begin
  if not exists (
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
  ) then
    raise exception 'aani: لم يُنشأ مفتاح أجنبي على public.messages.story_id؛ أوقف الترحيل.'
      using errcode = '42804';
  end if;
end $$;

create index if not exists aani_messages_story_idx
  on public.messages (story_id);

-- ملاحظة (لا يُنشأ هنا): الفهرس الفريد aani_messages_story_unique من
-- 20261109000000 سطر 16-18 غير مطلوب لإشعارات الستوري، وإنشاؤه على قاعدة
-- قائمة قد يفشل إن كانت فيها بطاقات ستوري مكررة. للتحقق قبل أي إنشاء يدوي:
--   select recipient_id, story_id, count(*)
--     from public.messages
--    where story_id is not null and content not like '[story-reply]%'
--    group by recipient_id, story_id having count(*) > 1;
-- وإن كانت النتيجة فارغة يمكن إنشاؤه بأمان:
--   create unique index if not exists aani_messages_story_unique
--     on public.messages (recipient_id, story_id)
--    where story_id is not null and content not like '[story-reply]%';

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
--    story_id يُقرأ عبر to_jsonb(new) فلا يمكن أن يفشل إدراج رسالة حتى لو
--    كان العمود غائباً في نسخة أقدم. شروط إشعارات الرسائل العادية نفسها
--    تماماً (نفس السجل الواحد لكل رسالة حيث يكون ذلك التصميم مطبَّقاً).
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

-- استعادة تصميم 20261228000000 + 20261229000000.
-- الكشف لا يعتمد على اسم الترحيل بل على أثر فعلي في الكتالوج:
--   * وجود الدالة aani_block_message_call_notifications() (أنشأها 20261229)، أو
--   * وجود مشغّلها aani_block_message_call_notifications على public.notifications.
-- وجود أحدهما يعني أن القاعدة تعمل بتصميم «لا سجل إشعار لكل رسالة»، وهو ما
-- يمنع أيضاً أي إشعار message مكرر لردود الستوري. عندها نحذف المشغّل والدالة
-- اللذين أعاد ترحيل 20270129 السابق إنشاءهما خطأً.
-- غيابهما يعني قاعدة قديمة على تصميم 20261226000000: لا نحذف مشغّلها القائم،
-- لكن الدالة أعلاه صارت آمنة وتتخطى ردود الستوري، فلا فشل ولا تكرار.
do $$
declare
  v_has_block_function boolean := to_regprocedure('public.aani_block_message_call_notifications()') is not null;
  v_notifications regclass := to_regclass('public.notifications');
  v_has_block_trigger boolean := false;
  v_message_trigger record;
begin
  if v_notifications is not null then
    select exists (
      select 1
      from pg_catalog.pg_trigger as trg
      where trg.tgrelid = v_notifications
        and trg.tgname = 'aani_block_message_call_notifications'
        and not trg.tgisinternal
    ) into v_has_block_trigger;
  end if;

  if v_has_block_function or v_has_block_trigger then
    -- نحذف كل مشغّل على messages يستدعي هذه الدالة تحديداً (لا غيرها)، ثم الدالة.
    for v_message_trigger in
      select trg.tgname
      from pg_catalog.pg_trigger as trg
      where trg.tgrelid = 'public.messages'::regclass
        and not trg.tgisinternal
        and trg.tgfoid = 'public.aani_notify_on_message_insert()'::regprocedure
    loop
      execute format('drop trigger if exists %I on public.messages', v_message_trigger.tgname);
    end loop;

    begin
      drop function if exists public.aani_notify_on_message_insert();
    exception
      when dependent_objects_still_exist then
        raise warning 'aani: دالة aani_notify_on_message_insert ما زالت مرتبطة بكائن آخر ولم تُحذف؛ مشغّلاتها على messages أُزيلت على أي حال.';
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) رد على ستوري
--    كل رسالة رد حدث مستقل ⇒ ردود متعددة على الستوري نفسها = إشعار لكل رد
--    (الفهرس الجزئي aani_messages_story_unique يستثني [story-reply] صراحةً).
--    فحص الحظر يستخدم aani_is_user_blocked(uuid,uuid) الذي يُعيد true فقط
--    عندما يكون auth.uid() أحد الطرفين — وهو الحال دائماً هنا لأن المشغّل
--    يعمل بإدراج من صاحب الرد نفسه. (الإدراج من service_role بلا JWT لا
--    يُخضِع الحظر؛ الحماية المكافئة موجودة في aani_blocked_messages_trg
--    التي ترفع 42501 عند الحظر قبل الإدراج.)
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
--    - لا إشعار لإعجاب صاحب الستوري بستوره (استدعاء الحظر بالترتيب
--      (المُعجِب, صاحب الستوري) مطابق لدلالة aani_is_user_blocked).
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
