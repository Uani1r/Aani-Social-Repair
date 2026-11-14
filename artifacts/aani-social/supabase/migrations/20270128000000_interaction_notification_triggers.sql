-- إشعارات التفاعلات من جهة قاعدة البيانات (بديل الإدخالات اليدوية في الواجهة).
-- Idempotent بالكامل: create or replace functions + drop trigger if exists.
--
-- التدقيق الذي بُني عليه (المخطط الفعلي):
--   public.likes(post_id, user_id)                      PK(post_id,user_id)
--   public.comments(id, post_id, user_id, parent_id, content, image_url, created_at)
--   public.comment_likes(comment_id, user_id)           PK(comment_id,user_id)
--   public.reposts(post_id, user_id)                    unique(post_id,user_id)
--   public.follows(follower_id, following_id)           PK(follower_id,following_id)
--   public.notifications(user_id, actor_id, type, content, reference_id, entity_id,
--                        comment_id, is_read, content_kind)
--   public.profiles.notification_settings jsonb {messages, followers, interactions, stories}
--   public.aani_is_user_blocked(uuid, uuid) موجودة (20261115000000)
--   public.aani_attach_notification_content_metadata() يملأ content_kind قبل الإدراج (20261230000000)
--
-- غير مشمول عن قصد: الرسائل (20261226000000)، طلبات المتابعة (20261129000000)،
-- والمنشن (يبقى إدخاله اليدوي الحالي) — لا مصدر ثانٍ لها.
-- لا يُلمس أي مشغّل عدّادات قائم.

begin;

-- 1) هل يوجد إشعار مطابق فعلاً؟ تُستخدم فقط للتعليقات/الردود (مفتاح comment_id
--    الفريد لكل حدث). إشعارات الإعجاب/الريبوست/المتابعة لا تستخدمها إطلاقاً،
--    لأن الاعتماد على قيود PK/UNIQUE في جداول التفاعل هو الضمان الصحيح.
create or replace function public.aani_notification_exists(
  p_user_id uuid,
  p_actor_id uuid,
  p_type text,
  p_reference_id uuid,
  p_comment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.notifications as n
    where n.user_id = p_user_id
      and n.actor_id = p_actor_id
      and n.type = p_type
      and coalesce(n.reference_id, n.entity_id) is not distinct from p_reference_id
      and n.comment_id is not distinct from p_comment_id
  );
$$;
revoke all on function public.aani_notification_exists(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;

-- 2) احترام تصنيفات إعدادات الإشعارات (default true)
-- قراءة آمنة: قيم JSON غير الصالحة/NULL/المفاتيح الغائبة تُعيد true بدل رفع استثناء
-- يُفشل عملية الإعجاب/التعليق/المتابعة.
-- notification_settings قد يكون json أو jsonb، لذا نُحوِّله صراحةً إلى jsonb
-- قبل jsonb_typeof و ->> كي تعمل الدالة مع النوعين.
create or replace function public.aani_notifications_enabled(
  p_user_id uuid,
  p_category text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select case jsonb_typeof(p.notification_settings::jsonb -> p_category)
               when 'boolean' then (p.notification_settings::jsonb ->> p_category)::boolean
               else true
             end
      from public.profiles as p
      where p.id = p_user_id
    ),
    true
  );
$$;
revoke all on function public.aani_notifications_enabled(uuid, text) from public, anon, authenticated;

-- 3) إعجاب بمنشور (ليس تعليقاً: comment_id = null)
create or replace function public.aani_notify_post_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_post_type text;
begin
  select post.user_id, post.type into v_owner, v_post_type
  from public.posts as post
  where post.id = new.post_id;

  if v_owner is null or v_owner = new.user_id then return new; end if;
  if public.aani_is_user_blocked(new.user_id, v_owner) then return new; end if;
  if not public.aani_notifications_enabled(v_owner, 'interactions') then return new; end if;
  -- لا فحص تاريخي لسجل الإشعارات هنا: سطر likes نشط واحد لكل (post,user)
  -- بفضل PK، والمُشغّل واحد لكل حدث (drop trigger if exists)، فلا تكرار للحدث
  -- النشط. إعادة الإعجاب بعد إلغائه = سطر جديد ⇒ إشعار جديد مشروع.

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.user_id, 'like', 'أعجب بمنشورك', new.post_id, new.post_id, null, v_post_type);

  return new;
end;
$$;
revoke all on function public.aani_notify_post_like() from public, anon, authenticated;

drop trigger if exists aani_notify_post_like_trg on public.likes;
create trigger aani_notify_post_like_trg
  after insert on public.likes
  for each row execute function public.aani_notify_post_like();

-- 4) تعليق أو رد
create or replace function public.aani_notify_post_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_post_type text;
  v_parent_author uuid;
begin
  select post.user_id, post.type into v_owner, v_post_type
  from public.posts as post
  where post.id = new.post_id;

  -- رد على تعليق شخص آخر
  if new.parent_id is not null then
    select parent.user_id into v_parent_author
    from public.comments as parent
    where parent.id = new.parent_id;

    if v_parent_author is not null
       and v_parent_author <> new.user_id
       and not public.aani_is_user_blocked(new.user_id, v_parent_author)
       and public.aani_notifications_enabled(v_parent_author, 'interactions')
       and not public.aani_notification_exists(v_parent_author, new.user_id, 'reply', new.post_id, new.id) then
      insert into public.notifications
        (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
      values
        (v_parent_author, new.user_id, 'reply', 'رد على تعليقك', new.post_id, new.post_id, new.id, v_post_type);
    end if;
  end if;

  -- تعليق على منشور شخص آخر (لا يكرر إشعار صاحب التعليق الأصلي في حالة الرد)
  if v_owner is null
     or v_owner = new.user_id
     or v_owner = v_parent_author then
    return new;
  end if;
  if public.aani_is_user_blocked(new.user_id, v_owner) then return new; end if;
  if not public.aani_notifications_enabled(v_owner, 'interactions') then return new; end if;
  if public.aani_notification_exists(v_owner, new.user_id, 'comment', new.post_id, new.id) then return new; end if;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.user_id, 'comment', 'علّق على منشورك', new.post_id, new.post_id, new.id, v_post_type);

  return new;
end;
$$;
revoke all on function public.aani_notify_post_comment() from public, anon, authenticated;

drop trigger if exists aani_notify_post_comment_trg on public.comments;
create trigger aani_notify_post_comment_trg
  after insert on public.comments
  for each row execute function public.aani_notify_post_comment();

-- 5) إعجاب بتعليق شخص آخر (يُفرَّق عن إعجاب المنشور بـ comment_id)
create or replace function public.aani_notify_comment_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author uuid;
  v_post_id uuid;
  v_post_type text;
begin
  select comment.user_id, comment.post_id into v_author, v_post_id
  from public.comments as comment
  where comment.id = new.comment_id;

  if v_author is null or v_author = new.user_id then return new; end if;
  if public.aani_is_user_blocked(new.user_id, v_author) then return new; end if;
  if not public.aani_notifications_enabled(v_author, 'interactions') then return new; end if;
  -- comment_likes: PK(comment_id,user_id) تضمن سطراً نشطاً واحداً لكل مستخدم،
  -- فلا حاجة لفحص تاريخي؛ إعادة الإعجاب بعد الإلغاء تُنشئ إشعاراً جديداً.

  select post.type into v_post_type from public.posts as post where post.id = v_post_id;

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_author, new.user_id, 'like', 'أعجب بتعليقك', v_post_id, v_post_id, new.comment_id, v_post_type);

  return new;
end;
$$;
revoke all on function public.aani_notify_comment_like() from public, anon, authenticated;

drop trigger if exists aani_notify_comment_like_trg on public.comment_likes;
create trigger aani_notify_comment_like_trg
  after insert on public.comment_likes
  for each row execute function public.aani_notify_comment_like();

-- 6) إعادة نشر منشور شخص آخر
create or replace function public.aani_notify_repost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_post_type text;
begin
  select post.user_id, post.type into v_owner, v_post_type
  from public.posts as post
  where post.id = new.post_id;

  if v_owner is null or v_owner = new.user_id then return new; end if;
  if public.aani_is_user_blocked(new.user_id, v_owner) then return new; end if;
  if not public.aani_notifications_enabled(v_owner, 'interactions') then return new; end if;
  -- reposts: قيد unique(post_id,user_id) يمنع سطرين نشطين ⇒ لا تكرار للحدث،
  -- وإعادة النشر بعد الحذف سطر جديد ⇒ إشعار جديد.

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id, comment_id, content_kind)
  values
    (v_owner, new.user_id, 'repost', 'أعاد نشر منشورك', new.post_id, new.post_id, null, v_post_type);

  return new;
end;
$$;
revoke all on function public.aani_notify_repost() from public, anon, authenticated;

drop trigger if exists aani_notify_repost_trg on public.reposts;
create trigger aani_notify_repost_trg
  after insert on public.reposts
  for each row execute function public.aani_notify_repost();

-- 7) متابعة جديدة (لا يوجد مسار آخر يُنشئها؛ طلبات المتابعة لها مشغّلها المستقل)
create or replace function public.aani_notify_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid := new.following_id;
begin
  if v_target is null or v_target = new.follower_id then return new; end if;
  if public.aani_is_user_blocked(new.follower_id, v_target) then return new; end if;
  if not public.aani_notifications_enabled(v_target, 'followers') then return new; end if;
  -- follows: PK(follower_id,following_id) تمنع متابعة نشطة مكررة ⇒ لا تكرار
  -- للحدث، وإعادة المتابعة بعد إلغائها إشعار جديد مشروع.

  insert into public.notifications
    (user_id, actor_id, type, content, reference_id, entity_id)
  values
    (v_target, new.follower_id, 'follow', 'بدأ بمتابعتك', new.follower_id, new.follower_id);

  return new;
end;
$$;
revoke all on function public.aani_notify_follow() from public, anon, authenticated;

drop trigger if exists aani_notify_follow_trg on public.follows;
create trigger aani_notify_follow_trg
  after insert on public.follows
  for each row execute function public.aani_notify_follow();

commit;

-- تنظيف احترازي: إزالة الإصدار الزمني القديم (6 معاملات) إن كان قد طُبّق سابقاً.
-- لا يُفشل الترحيل إذا كانت هناك كائنات تعتمد عليه.
do $$
begin
  drop function if exists public.aani_notification_exists(uuid, uuid, text, uuid, uuid, timestamptz);
exception
  when dependent_objects_still_exist then null;
  when undefined_function then null;
end;
$$;

-- تحقق بعد التطبيق (اختياري):
-- select tgname, tgrelid::regclass from pg_trigger
--  where tgname in ('aani_notify_post_like_trg','aani_notify_post_comment_trg',
--                   'aani_notify_comment_like_trg','aani_notify_repost_trg','aani_notify_follow_trg');
