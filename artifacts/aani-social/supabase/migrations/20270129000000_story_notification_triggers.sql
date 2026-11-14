-- إشعارات الستوري من جهة قاعدة البيانات + إصلاح المخطط messages.story_id
--
-- حالة قاعدة الإنتاج التي بُني عليها هذا التصحيح (فحص مباشر أجراه المالك):
--   * public.messages.story_id غير موجود.
--   * المشغّلان aani_message_notification_after_insert وaani_notify_story_reply_trg
--     موجودان، ودالتاهما تقرآن NEW.story_id مباشرة ⇒ كل إدراج رسالة معرّض
--     لخطأ 42703 "record new has no field story_id".
--   * aani_block_message_call_notifications() غير موجودة ⇒ القاعدة على تصميم
--     20261226000000 (إشعار عام لكل رسالة)، وليس تصميم 20261228/20261229.
--   * aani_is_user_blocked(uuid,uuid) موجودة لكنها تشترط أن يكون auth.uid()
--     أحد الطرفين، لذلك لا تصلح وحدها لإدراج بلا JWT. فحص الحظر في هذا الملف
--     يقرأ public.user_blocks مباشرة (بالاتجاهين) داخل دالة SECURITY DEFINER،
--     فيعمل سواء وُجد JWT أم لا.
--   * أعمدة public.user_blocks تختلف بين البيئات: الإنتاج يستخدم
--     (blocker_id, blocked_id, created_at) بينما 20261115000000 في المستودع
--     يستخدم blocked_user_id. هذا الملف يقبل المخططين: يفحص وجود أحدهما
--     ويتوقف إن وُجدا معاً (التباس) أو غابا معاً، ويقرأ الحظر عبر to_jsonb
--     فلا يُثبَّت اسم عمود واحد في جسم الدالة.
--   * لا توجد في الإنتاج مشغّلات حظر بديلة على messages أو story_likes،
--     وفحص الحظر هنا هو الضمان الفعلي لعدم إنشاء إشعار لطرفين محظورين.
--
-- سبب غياب العمود: يُضاف في 20261107000000_story_mentions.sql (سطر 53-54) و
-- 20261108000000_story_followers_reshare_security.sql (سطر 15-16) فقط، وملفا
-- الأساس (schema.sql سطر 276 / fresh_schema_cloudflare_r2.sql سطر 279) ينشئان
-- public.messages بدونه. والدليل على أن ملفي الإضافة لم يُطبَّقا: 20261109000000
-- (سطر 16-18) ينشئ فهرساً فريداً على (recipient_id, story_id) وهو مستحيل بلا العمود.
--
-- ما يفعله هذا الملف (معاملة واحدة، قابل لإعادة التشغيل):
--   0) شروط مسبقة صريحة تُفشل الترحيل إن غاب جدول أو دالة أو عمود.
--   1) يضيف messages.story_id (nullable) + يرفض القيم اليتيمة + يتحقق من المفتاح
--      الأجنبي بدقة (public.stories(id), عمود محلي واحد هو story_id,
--      ON DELETE SET NULL). أي قيد مخالف يشمل story_id يوقف الترحيل برسالة
--      واضحة بدل تجاوزه بصمت. ولا يوجد أي exception handler يخفي فشل القيد.
--   2) مسار القاعدة القديمة محفوظ: ما دام aani_block_message_call_notifications()
--      غائباً يبقى مشغّل الرسائل العام aani_message_notification_after_insert
--      كما هو، لكن دالته تُعاد تعريفها بجسم آمن يقرأ story_id عبر to_jsonb(new)
--      (لا NEW.story_id مباشرة) ولا يُنشئ إشعار message لردود الستوري.
--      وإذا وُجد تصميم 20261228/20261229 في قاعدة أخرى (دالة الحجب أو مشغّلها)
--      تُزال كل المشغّلات التي تستدعي تلك الدالة ثم الدالة نفسها.
--   3) إشعار إعجاب الستوري وإشعار رد الستوري (content_kind = 'story').
--   4) metadata trigger لا يحوّل مرجع الستوري إلى منشور.
--
-- يعتمد على: public.stories(id,user_id) ، public.story_likes(story_id,user_id)
--   public.messages(id,sender_id,recipient_id,content,created_at)
--   public.notifications(reference_id, entity_id, comment_id, content_kind)
--   public.profiles.notification_settings jsonb
--   public.user_blocks(blocker_id, blocked_id) أو (blocker_id, blocked_user_id)
-- لا يعتمد على 20270128000000: دالة إعدادات الستوري معرَّفة هنا باسم مستقل.

begin;

-- ---------------------------------------------------------------------------
-- 0) شروط مسبقة صريحة: تُفشل الترحيل إن لم تتحقق، بدل الفشل الصامت لاحقاً.
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_blocked_column_count integer;
begin
  foreach v_table in array array['messages', 'stories', 'story_likes', 'profiles', 'notifications', 'user_blocks']
  loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'aani: الجدول public.% غير موجود؛ لا يمكن تطبيق ترحيل إشعارات الستوري.', v_table
        using errcode = '42P01';
    end if;
  end loop;

  -- فحص الحظر أدناه يعتمد مباشرة على أعمدة user_blocks، لا على دالة تعتمد
  -- على auth.uid(). العمود الثاني يختلف بين المخططين، فنقبل أياً منهما
  -- ونرفض الالتباس (وجود الاثنين) أو غيابهما.
  if not exists (
    select 1
    from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'user_blocks'
      and col.column_name = 'blocker_id'
  ) then
    raise exception 'aani: الجدول public.user_blocks لا يحتوي العمود blocker_id؛ لا يمكن فحص الحظر.'
      using errcode = '42703';
  end if;

  -- count(*) — أي "عدد كل الصفوف" — يحسب عمودَي الحظر المحتملين الموجودين فعلاً.
  select count(*)
  into v_blocked_column_count
  from information_schema.columns as col
  where col.table_schema = 'public'
    and col.table_name = 'user_blocks'
    and col.column_name in ('blocked_id', 'blocked_user_id');

  if v_blocked_column_count = 0 then
    raise exception 'aani: الجدول public.user_blocks لا يحتوي أي عمود من (blocked_id, blocked_user_id)؛ لا يمكن فحص الحظر.'
      using errcode = '42703';
  elsif v_blocked_column_count > 1 then
    raise exception 'aani: الجدول public.user_blocks يحتوي العمودين blocked_id و blocked_user_id معاً؛ مخطط ملتبس. أوقف الترحيل وحدّد العمود الصحيح يدوياً.'
      using errcode = '42702';
  end if;

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

-- المفتاح الأجنبي: تحقق دقيق من التعريف المطلوب:
--   عمود محلي واحد هو messages.story_id
--   → public.stories(id)
--   → ON DELETE SET NULL (confdeltype = 'n')
-- أي قيد FK آخر يشمل story_id (عمود إضافي، جدول/عمود مرجعي مختلف، أو سلوك حذف
-- مختلف) يوقف الترحيل. لا exception handler يخفي فشل الإنشاء.
do $$
declare
  v_story_attnum smallint;
  v_id_attnum smallint;
  v_mismatched_name text;
  v_mismatched_def text;
  v_matching boolean;
begin
  select att.attnum into v_story_attnum
  from pg_catalog.pg_attribute as att
  where att.attrelid = 'public.messages'::regclass
    and att.attname = 'story_id'
    and not att.attisdropped;

  select att.attnum into v_id_attnum
  from pg_catalog.pg_attribute as att
  where att.attrelid = 'public.stories'::regclass
    and att.attname = 'id'
    and not att.attisdropped;

  if v_story_attnum is null or v_id_attnum is null then
    raise exception 'aani: تعذّر تحديد العمودين public.messages.story_id و public.stories.id.'
      using errcode = '42703';
  end if;

  -- 1) أي قيد FK يشمل story_id ولا يطابق التعريف المطلوب تماماً يوقف الترحيل.
  select con.conname, pg_get_constraintdef(con.oid)
  into v_mismatched_name, v_mismatched_def
  from pg_catalog.pg_constraint as con
  join pg_catalog.pg_class as tbl on tbl.oid = con.conrelid
  join pg_catalog.pg_namespace as ns on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'messages'
    and con.contype = 'f'
    and v_story_attnum = any (con.conkey)
    and not (
      con.confrelid = 'public.stories'::regclass
      and con.conkey = array[v_story_attnum]::smallint[]
      and con.confkey = array[v_id_attnum]::smallint[]
      and con.confdeltype = 'n'
    )
  limit 1;

  if v_mismatched_name is not null then
    raise exception 'aani: يوجد قيد مفتاح أجنبي على messages.story_id لا يطابق المطلوب (public.stories(id) ON DELETE SET NULL): % — %. أوقف الترحيل ونظّف القيد يدوياً.',
      v_mismatched_name, v_mismatched_def
      using errcode = '42804';
  end if;

  -- 2) هل القيد المطابق موجود (بأي اسم)؟
  select exists (
    select 1
    from pg_catalog.pg_constraint as con
    join pg_catalog.pg_class as tbl on tbl.oid = con.conrelid
    join pg_catalog.pg_namespace as ns on ns.oid = tbl.relnamespace
    where ns.nspname = 'public'
      and tbl.relname = 'messages'
      and con.contype = 'f'
      and con.confrelid = 'public.stories'::regclass
      and con.conkey = array[v_story_attnum]::smallint[]
      and con.confkey = array[v_id_attnum]::smallint[]
      and con.confdeltype = 'n'
  ) into v_matching;

  if not v_matching then
    alter table public.messages
      add constraint aani_messages_story_id_fkey
      foreign key (story_id) references public.stories (id) on delete set null;
  end if;
end $$;

-- شرط لاحق: لا ينجح الترحيل إلا إذا كان التعريف المطلوب موجوداً فعلاً.
do $$
declare
  v_story_attnum smallint;
  v_id_attnum smallint;
begin
  select att.attnum into v_story_attnum
  from pg_catalog.pg_attribute as att
  where att.attrelid = 'public.messages'::regclass
    and att.attname = 'story_id'
    and not att.attisdropped;

  select att.attnum into v_id_attnum
  from pg_catalog.pg_attribute as att
  where att.attrelid = 'public.stories'::regclass
    and att.attname = 'id'
    and not att.attisdropped;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    join pg_catalog.pg_class as tbl on tbl.oid = con.conrelid
    join pg_catalog.pg_namespace as ns on ns.oid = tbl.relnamespace
    where ns.nspname = 'public'
      and tbl.relname = 'messages'
      and con.contype = 'f'
      and con.confrelid = 'public.stories'::regclass
      and con.conkey = array[v_story_attnum]::smallint[]
      and con.confkey = array[v_id_attnum]::smallint[]
      and con.confdeltype = 'n'
  ) then
    raise exception 'aani: لا يوجد بعد التنفيذ مفتاح أجنبي مطابق على messages.story_id → stories(id) ON DELETE SET NULL؛ أوقف الترحيل.'
      using errcode = '42804';
  end if;
end $$;

create index if not exists aani_messages_story_idx
  on public.messages (story_id);

-- ملاحظة (لا يُنشأ هنا): الفهرس الفريد aani_messages_story_unique من
-- 20261109000000 سطر 16-18 غير مطلوب لإشعارات الستوري، وإنشاؤه على قاعدة
-- قائمة قد يفشل إن كانت فيها بطاقات ستوري مكررة. فحص التكرارات أولاً:
--   select recipient_id, story_id, count(*)
--     from public.messages
--    where story_id is not null and content not like '[story-reply]%'
--    group by recipient_id, story_id having count(*) > 1;
-- وإن كانت النتيجة فارغة يمكن إنشاؤه يدوياً:
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
--    notification_settings قد يكون json أو jsonb، لذا نُحوِّله صراحةً إلى jsonb
--    قبل jsonb_typeof و ->> كي تعمل الدالة مع النوعين.
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
      select case jsonb_typeof(p.notification_settings::jsonb -> 'stories')
               when 'boolean' then (p.notification_settings::jsonb ->> 'stories')::boolean
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
-- 5) إشعار الرسالة العام (مسار القاعدة القديمة — الإنتاج الحالي)
--    المشغّل الحالي aani_message_notification_after_insert يبقى كما هو، لكن
--    دالته تُعاد تعريفها هنا بحيث:
--      * لا تقرأ NEW.story_id مباشرة إطلاقاً (تقرأ to_jsonb(new) فلا تفشل
--        أبداً على مخطط بلا العمود).
--      * تتخطى ردود الستوري عندما يكون مستقبلها صاحب الستوري، فلا إشعار
--        message مكرر مع إشعار الرد.
--      * تحافظ على شروط إشعارات الرسائل العادية كما هي في 20261226000000.
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

-- في قاعدة الإنتاج الحالية (لا aani_block_message_call_notifications) لا يدخل
-- هذا الفرع إطلاقاً ⇒ المشغّل يبقى. أما قاعدة تتبع تصميم 20261228/20261229
-- فتُزال منها كل المشغّلات على messages التي تستدعي الدالة أعلاه ثم الدالة.
-- لا نُنشئ المشغّل إن كان غائباً: قاعدة طبّقت 20261228 عمداً بلا 20261229 لا
-- يجوز أن نُعيد فيه إشعار الرسائل.
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
--    المشغّل الحالي aani_notify_story_reply_trg يبقى، وتُعاد دالته بجسم آمن
--    يقرأ story_id عبر to_jsonb(new) بدل NEW.story_id.
--    كل رسالة رد حدث مستقل ⇒ ردود متعددة على الستوري نفسها = إشعار لكل رد.
--    فحص الحظر يقرأ public.user_blocks مباشرة (بالاتجاهين) داخل SECURITY DEFINER
--    فيتجاوز RLS ولا يعتمد على auth.uid()، ويعمل سواء وُجد JWT أم لا.
--    العمود الثاني يُقرأ عبر to_jsonb فيقبل blocked_id وblocked_user_id.
--    لا توجد في الإنتاج مشغّلات حظر بديلة على messages، فهذا الفحص هو الضمان.
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
  -- حظر بين المرسل وصاحب الستوري، بالاتجاهين، من الجدول مباشرة (لا auth.uid).
  -- العمود الثاني يُقرأ عبر to_jsonb فيعمل مع blocked_id وblocked_user_id معاً.
  if exists (
    select 1
    from public.user_blocks as blk
    where (
      blk.blocker_id = new.sender_id
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = v_owner::text
    ) or (
      blk.blocker_id = v_owner
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = new.sender_id::text
    )
  ) then
    return new;
  end if;
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
--    - لا إشعار عند حظر بين المُعجِب وصاحب الستوري (فحص مباشر بـEXISTS).
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
  -- حظر بين المُعجِب وصاحب الستوري، بالاتجاهين، من الجدول مباشرة (لا auth.uid).
  -- العمود الثاني يُقرأ عبر to_jsonb فيعمل مع blocked_id وblocked_user_id معاً.
  if exists (
    select 1
    from public.user_blocks as blk
    where (
      blk.blocker_id = new.user_id
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = v_owner::text
    ) or (
      blk.blocker_id = v_owner
      and coalesce(to_jsonb(blk) ->> 'blocked_id', to_jsonb(blk) ->> 'blocked_user_id') = new.user_id::text
    )
  ) then
    return new;
  end if;
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

-- ===========================================================================
-- استعلامات تحقق بعد التنفيذ (قراءة فقط)
-- ===========================================================================
-- 1) العمود موجود وnullable:
-- select column_name, is_nullable, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'messages' and column_name = 'story_id';
--
-- 2) المفتاح الأجنبي المطابق (يجب أن يظهر عمود محلي واحد story_id،
--    مرجع stories(id)، وON DELETE SET NULL):
-- select con.conname, pg_get_constraintdef(con.oid) as definition
--   from pg_catalog.pg_constraint as con
--   join pg_catalog.pg_class as tbl on tbl.oid = con.conrelid
--   join pg_catalog.pg_namespace as ns on ns.oid = tbl.relnamespace
--  where ns.nspname = 'public' and tbl.relname = 'messages' and con.contype = 'f';
--
-- 3) المشغّلات على messages (المتوقع على الإنتاج: aani_message_notification_after_insert
--    يبقى موجوداً، وaani_notify_story_reply_trg موجود):
-- select tgname, pg_get_triggerdef(oid) as definition
--   from pg_catalog.pg_trigger
--  where tgrelid = 'public.messages'::regclass and not tgisinternal;
--
-- 4) كل دالة مرتبطة بمشغّل على messages، وهل تقرأ NEW.story_id مباشرة؟
--    الفحص يُعيد صفاً لكل مشغّل مع قيمة منطقية، فلا يمكن أن تُقرأ "صفر صفوف"
--    كنجاح. التعبير ~* يتجاهل حالة الأحرف و\s* يسمح بأي مسافات أو أسطر جديدة
--    بين new و . و story_id. المتوقع: كل القيم false.
-- select t.tgname,
--        p.proname,
--        (p.prosrc ~* 'new\s*\.\s*story_id') as reads_new_story_id_directly
--   from pg_catalog.pg_trigger as t
--   join pg_catalog.pg_proc as p on p.oid = t.tgfoid
--  where t.tgrelid = 'public.messages'::regclass
--    and not t.tgisinternal
--  order by t.tgname;
--
-- 5) الدالتان تقرآن to_jsonb (المتوقع: صفّان):
-- select p.proname
--   from pg_catalog.pg_proc as p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('aani_notify_on_message_insert', 'aani_notify_story_reply')
--    and p.prosrc ~* 'to_jsonb';
--
-- 6) الدالتان تفحصان public.user_blocks وتقرآن العمودين المحتملين (المتوقع: صفّان):
-- select p.proname
--   from pg_catalog.pg_proc as p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('aani_notify_story_reply', 'aani_notify_story_like')
--    and p.prosrc ~* 'user_blocks'
--    and p.prosrc ~* 'blocked_id'
--    and p.prosrc ~* 'blocked_user_id';
--
-- 7) الدالتان لم تعودا تعتمدان على aani_is_user_blocked (المتوقع: صفر صفوف):
-- select p.proname
--   from pg_catalog.pg_proc as p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('aani_notify_story_reply', 'aani_notify_story_like')
--    and p.prosrc ~* 'aani_is_user_blocked';
--
-- 8) اختبار دخاني اختياري داخل معاملة تُلغى (لا يترك أثراً). يختار أول حسابين
--    موجودين؛ إن رفضه مشغّل طلبات المراسلة فتلك حماية قائمة وليست خطأً:
-- begin;
-- insert into public.messages (sender_id, recipient_id, content)
-- select first_profile.id, second_profile.id, 'aani-test normal message'
--   from (select id from public.profiles order by created_at limit 1) as first_profile
--   cross join (select id from public.profiles order by created_at offset 1 limit 1) as second_profile;
-- rollback;
