-- ============================================================================
-- مخطط رسائل مصغّر لاختبار ترحيل توافق الردود في CI على PostgreSQL نظيف.
--
-- هذا ليس مخطط الإنتاج: فيه فقط ما يلمسه ترحيل
-- 20270228000001_messages_reply_compat_and_thread_indexes.sql واختبار
-- messages_reply_compat.test.sql:
--   * public.profiles كمرجع للمفاتيح الأجنبية،
--   * public.messages بالأعمدة التي يستخدمها الترحيل والاختبار،
--   * الحالة "القديمة": reply_to_id موجود، وreply_to_message_id مضاف
--     بفهرسه القديم aani_messages_reply_to_idx، ودالة/triggers التحقق من
--     هدف الرد كما أنشأها الترحيل 20261205000000.
--
-- لا يُطبَّق على أي قاعدة بيانات من هذا المستودع؛ يُنشأ في حاوية CI مؤقتة
-- وحدها.
-- ============================================================================

begin;

create table public.profiles (
  id uuid primary key,
  username text
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  reply_to_id uuid references public.messages (id) on delete set null,
  constraint messages_not_self_check check (sender_id <> recipient_id)
);

create index messages_sender_created_at_idx
  on public.messages (sender_id, created_at);
create index messages_recipient_created_at_idx
  on public.messages (recipient_id, created_at);

-- من الترحيل 20261205000000: العمود الجديد وفهرسه القديم ودالة/triggers التحقق.
alter table public.messages
  add column reply_to_message_id uuid references public.messages (id) on delete set null;

create index aani_messages_reply_to_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

create or replace function public.aani_validate_message_reply_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reply_to_message_id is not null and not exists (
    select 1
    from public.messages as parent
    where parent.id = new.reply_to_message_id
      and (
        (parent.sender_id = new.sender_id and parent.recipient_id = new.recipient_id)
        or (parent.sender_id = new.recipient_id and parent.recipient_id = new.sender_id)
      )
  ) then
    raise exception 'Reply target must belong to the same conversation' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger aani_validate_message_reply_target_insert
  before insert on public.messages
  for each row execute function public.aani_validate_message_reply_target();

create trigger aani_validate_message_reply_target_update
  before update of reply_to_message_id, sender_id, recipient_id on public.messages
  for each row execute function public.aani_validate_message_reply_target();

-- بيانات أولية: محادثتان مختلفتان حتى يستطيع الاختبار تجربة رفض الرد عبرهما.
insert into public.profiles (id, username) values
  ('00000000-0000-0000-0000-000000000001', 'test-a'),
  ('00000000-0000-0000-0000-000000000002', 'test-b'),
  ('00000000-0000-0000-0000-000000000003', 'test-c'),
  ('00000000-0000-0000-0000-000000000004', 'test-d');

insert into public.messages (sender_id, recipient_id, content) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'seed conversation one'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004', 'seed conversation two');

commit;
