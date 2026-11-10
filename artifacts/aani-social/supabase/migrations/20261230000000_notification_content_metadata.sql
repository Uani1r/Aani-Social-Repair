-- إرفاق بيانات المحتوى (metadata) بسجلات الإشعارات:
--   content_kind: نوع المحتوى الحقيقي (post / reel / photo / video / text)
--   ويُضمن وجود معرّف المنشور في reference_id لإشعارات (like / comment /
--   reply / mention / repost / post_like) سواء كان الإشعار عن منشور أو
--   عن تعليق داخل منشور (يُحلَّل post_id عبر جدول comments).
begin;

alter table public.notifications add column if not exists content_kind text;

-- تعبئة content_kind تلقائياً عند الإدراج (تُدار الرسائل/المكالمات بترحيل 20261229)
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

-- تعبئة السجلات القديمة ببيانات المحتوى
update public.notifications n
set content_kind = p.type
from public.posts p
where lower(n.type) in ('like', 'post_like', 'comment', 'reply', 'mention', 'repost')
  and coalesce(n.reference_id, n.entity_id) = p.id;

update public.notifications n
set content_kind = p.type
from public.comments c
join public.posts p on p.id = c.post_id
where lower(n.type) in ('like', 'comment', 'reply', 'mention')
  and n.comment_id = c.id;

notify pgrst, 'reload schema';

commit;
