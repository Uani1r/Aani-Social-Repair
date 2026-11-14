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
--
-- ترتيب التطبيق: 20270129000000 ثم 20270130000000.
-- إعادة تطبيق 20270129000000 بعد هذا الملف تستبدل دالة الإعجاب بنسخة بلا
-- metadata؛ إن حدث ذلك فأعد تطبيق هذا الملف بعده لإرجاع نسخة metadata.

begin;

-- 0) وجود الجداول الأساسية قبل أي ALTER TABLE.
--    التحقق بعد ALTER لا يحمي: ALTER نفسه يفشل إن غاب الجدول.
do $$
begin
  if to_regclass('public.stories') is null
     or to_regclass('public.notifications') is null
     or to_regclass('public.user_blocks') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.story_likes') is null then
    raise exception 'aani: جدول أساسي مفقود (stories/notifications/user_blocks/profiles/story_likes).'
      using errcode = '42P01';
  end if;
end $$;

-- 1) الصورة المصغرة للستوري
alter table public.stories
  add column if not exists thumbnail_url text;

-- 2) بيانات منظمة للإشعار + ضمان الأعمدة التي يكتبها هذا الترحيل.
--    كلها add column if not exists: لا تغيّر نوعاً قائماً ولا تحذف بيانات،
--    وتضمن أن INSERT أدناه يعمل حتى على قاعدة تخطّت بعض ترحيلات الإشعارات.
alter table public.notifications
  add column if not exists reference_id uuid,
  add column if not exists entity_id uuid,
  add column if not exists comment_id uuid,
  add column if not exists content_kind text,
  add column if not exists metadata jsonb;

-- 2.1) تحقق صريح من وجود الأعمدة ومن أنواعها الفعلية. ADD COLUMN IF NOT EXISTS
--      لا يكفي: عمود قائم بنوع مختلف (text بدل uuid مثلاً) سيقبل الإدراج لكنه
--      يكسر الاستعلامات لاحقاً. نوقف الترحيل عند أي غياب أو نوع غير متوقع،
--      ولا نفترض بنية user_blocks: عمود حظر واحد فقط بالضبط.
do $$
declare
  v_missing text;
  v_bad_type text;
  v_blocked_count integer;
begin
  -- الجداول تحققت قبل أي ALTER في الكتلة 0 أعلاه.

  select string_agg(required.column_name, ', ')
    into v_missing
  from (
    values ('user_id'), ('actor_id'), ('type'), ('content'),
           ('reference_id'), ('entity_id'), ('comment_id'),
           ('content_kind'), ('metadata')
  ) as required(column_name)
  where not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'notifications'
      and col.column_name = required.column_name
  );

  if v_missing is not null then
    raise exception 'aani: أعمدة notifications المطلوبة غير موجودة: %', v_missing
      using errcode = '42703';
  end if;

  if not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'stories'
      and col.column_name = 'thumbnail_url'
  ) then
    raise exception 'aani: العمود public.stories.thumbnail_url غير موجود.'
      using errcode = '42703';
  end if;

  -- الأعمدة التي تستخدمها دالة الإعجاب في stories: id, user_id, media_type
  -- (بالإضافة إلى thumbnail_url أعلاه) وأنواعها.
  if not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'stories'
      and col.column_name = 'id'
      and col.data_type = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'stories'
      and col.column_name = 'user_id'
      and col.data_type = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'stories'
      and col.column_name = 'media_type'
      and col.data_type = 'text'
  ) then
    raise exception 'aani: public.stories يجب أن يحتوي id uuid وuser_id uuid وmedia_type text.'
      using errcode = '42703';
  end if;

  -- story_likes: الأعمدة التي يقرأها المشغّل عبر NEW.
  if not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'story_likes'
      and col.column_name = 'story_id'
      and col.data_type = 'uuid'
  ) or not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'story_likes'
      and col.column_name = 'user_id'
      and col.data_type = 'uuid'
  ) then
    raise exception 'aani: public.story_likes يجب أن يحتوي story_id uuid وuser_id uuid.'
      using errcode = '42703';
  end if;

  select string_agg(format('%s.%s (%s)', col.table_name, col.column_name, col.data_type), ', ')
    into v_bad_type
  from information_schema.columns as col
  where col.table_schema = 'public'
    and (
      (col.table_name = 'notifications'
        and col.column_name in ('user_id', 'actor_id', 'reference_id', 'entity_id', 'comment_id')
        and col.data_type <> 'uuid')
      or (col.table_name = 'notifications'
        and col.column_name in ('type', 'content', 'content_kind')
        and col.data_type <> 'text')
      or (col.table_name = 'notifications'
        and col.column_name = 'metadata'
        and col.data_type <> 'jsonb')
      or (col.table_name = 'stories'
        and col.column_name = 'thumbnail_url'
        and col.data_type <> 'text')
    );

  if v_bad_type is not null then
    raise exception 'aani: أنواع أعمدة غير متوقعة، أصلح الأنواع يدوياً قبل الترحيل: %', v_bad_type
      using errcode = '42804';
  end if;

  -- user_blocks: يجب وجود blocker_id uuid، وعمود حظر واحد فقط من الاثنين.
  if not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'user_blocks'
      and col.column_name = 'blocker_id'
      and col.data_type = 'uuid'
  ) then
    raise exception 'aani: public.user_blocks.blocker_id مفقود أو ليس uuid.'
      using errcode = '42703';
  end if;

  select count(*)
    into v_blocked_count
  from information_schema.columns as col
  where col.table_schema = 'public'
    and col.table_name = 'user_blocks'
    and col.column_name in ('blocked_id', 'blocked_user_id');

  if v_blocked_count = 0 then
    raise exception 'aani: public.user_blocks لا يحتوي blocked_id ولا blocked_user_id.'
      using errcode = '42703';
  elsif v_blocked_count > 1 then
    raise exception 'aani: public.user_blocks يحتوي العمودين blocked_id و blocked_user_id معاً؛ مخطط ملتبس يُرفض حتى لو كان أحدهما فقط uuid.'
      using errcode = '42702';
  end if;

  -- بعد التأكد من وجود عمود واحد فقط، نتحقق أن نوعه uuid.
  if not exists (
    select 1 from information_schema.columns as col
    where col.table_schema = 'public'
      and col.table_name = 'user_blocks'
      and col.column_name in ('blocked_id', 'blocked_user_id')
      and col.data_type = 'uuid'
  ) then
    raise exception 'aani: عمود الحظر الوحيد في public.user_blocks ليس uuid.'
      using errcode = '42804';
  end if;
end $$;

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

-- تحقق (قراءة فقط) بعد التطبيق:
-- 1) الأعمدة:
-- select table_name, column_name, is_nullable, data_type
--   from information_schema.columns
--  where table_schema='public'
--    and ((table_name='stories' and column_name='thumbnail_url')
--      or (table_name='notifications' and column_name in
--          ('user_id','actor_id','type','content','reference_id','entity_id','comment_id','content_kind','metadata')))
--  order by table_name, ordinal_position;
-- 2) مشغّلات story_likes (المتوقع: aani_blocked_story_likes_trg + aani_notify_story_like_trg فقط):
-- select t.tgname, p.proname, t.tgenabled
--   from pg_trigger t
--   join pg_proc p on p.oid = t.tgfoid
--  where t.tgrelid='public.story_likes'::regclass and not t.tgisinternal
--  order by t.tgname;
-- 3) الدوال (لا تفشل الاستعلامات عند غياب دالة: to_regprocedure يعيد NULL):
-- select p.oid::regprocedure as signature,
--        pg_get_userbyid(p.proowner) as owner,
--        p.prosecdef as security_definer,
--        p.proconfig as settings,
--        p.proacl as acl
--   from pg_catalog.pg_proc as p
--  where p.oid = any (
--    array_remove(array[
--      to_regprocedure('public.aani_set_story_thumbnail(uuid,text)'),
--      to_regprocedure('public.aani_notify_story_like()'),
--      to_regprocedure('public.aani_story_notifications_enabled(uuid)')
--    ]::oid[], null::oid)
--  );
-- 4) لا مسار LIKE آخر على story_likes:
-- select t.tgname, p.proname
--   from pg_trigger t join pg_proc p on p.oid=t.tgfoid
--  where t.tgrelid='public.story_likes'::regclass and not t.tgisinternal
--    and p.prosrc ~* 'notifications';
-- 5) بنية story_likes:
-- select column_name, data_type, is_nullable from information_schema.columns
--  where table_schema='public' and table_name='story_likes' order by ordinal_position;
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid='public.story_likes'::regclass;
