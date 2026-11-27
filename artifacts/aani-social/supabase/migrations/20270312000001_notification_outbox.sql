-- طابور إشعارات الدفع: public.notification_outbox
--
-- أساس ضمان عدم ضياع أحداث Push: الحدث يُسجَّل في هذه الجدول داخل المعاملة
-- نفسها التي تُسجّل الحدث الأصلي (رسالة/مكالمة/إشعار اجتماعي)، ثم يعالجه
-- عامل الخادم لاحقاً. لا اتصال بـFirebase من قاعدة البيانات.
--
--   * dedupe_key فريد: الحدث نفسه لا يُسجَّل مرتين.
--   * الحالات: pending / processing / sent / failed.
--   * attempts وavailable_at لإعادة المحاولة مع Backoff من العامل.
--   * locked_at/locked_by مع مدة قفل: المهمة المتروكة تعود بعد انقطاع العامل.
--   * aani_claim_notification_outbox تحجز دفعة بـFOR UPDATE SKIP LOCKED،
--     فلا يعالج عاملان الحدث نفسه.
--   * aani_complete_notification_outbox تُنهي المهمة (sent/failed) أو تُعيدها
--     إلى pending مع تأخير Backoff.
--
-- RLS مفعّلة بلا أي سياسة → anon وauthenticated ممنوعان تماماً،
-- والوصول التشغيلي لـservice_role وحده.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  event_type text not null check (event_type in ('message', 'call', 'notification')),
  payload jsonb not null default '{}'::jsonb,
  aggregate_type text,
  aggregate_id uuid,
  reference_id uuid,
  dedupe_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint notification_outbox_dedupe_key_key unique (dedupe_key)
);

create index if not exists notification_outbox_due_idx
  on public.notification_outbox (status, available_at)
  where status in ('pending', 'processing');

create index if not exists notification_outbox_recipient_idx
  on public.notification_outbox (recipient_user_id, created_at desc);

alter table public.notification_outbox enable row level security;
-- لا سياسات RLS إطلاقاً → رفض افتراضي للمستخدمين العاديين.
revoke all on table public.notification_outbox from public, anon, authenticated;
grant select, insert, update on table public.notification_outbox to service_role;

-- حجز دفعة مهام للعامل: يتخطى الصفوف المقفلة، ويستعيد الأقفال المنتهية.
create or replace function public.aani_claim_notification_outbox(
  p_worker text,
  p_limit integer default 20,
  p_lock_ttl interval default interval '2 minutes'
) returns setof public.notification_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker text := nullif(btrim(coalesce(p_worker, '')), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_ttl interval := coalesce(p_lock_ttl, interval '2 minutes');
begin
  if v_worker is null then
    raise exception 'aani_claim_notification_outbox: worker name required' using errcode = '22023';
  end if;
  if v_ttl < interval '5 seconds' then
    v_ttl := interval '5 seconds';
  end if;

  return query
  with claimed as (
    select pending.id
    from public.notification_outbox as pending
    where (pending.status = 'pending' and pending.available_at <= now())
       or (
         pending.status = 'processing'
         and pending.locked_at is not null
         and pending.locked_at < now() - v_ttl
       )
    order by pending.available_at asc, pending.created_at asc
    for update skip locked
    limit v_limit
  )
  update public.notification_outbox as task
  set status = 'processing',
      locked_at = now(),
      locked_by = v_worker,
      attempts = task.attempts + 1
  from claimed
  where task.id = claimed.id
  returning task.*;
end
$$;

revoke all on function public.aani_claim_notification_outbox(text, integer, interval) from public, anon, authenticated;
grant execute on function public.aani_claim_notification_outbox(text, integer, interval) to service_role;

-- إنهاء مهمة: sent، أو failed مع إعادة محاولة (Backoff) أو فشل نهائي.
-- لا يُقبل الإنهاء إلا من العامل نفسه: المهمة يجب أن تكون processing،
-- وlocked_by يجب أن يطابق p_worker تماماً، وp_worker لا يكون فارغاً.
-- هذا يمنع عاملين من إنهاء المهمة نفسها أو من إنهاء مهمة ليست له.
create or replace function public.aani_complete_notification_outbox(
  p_id uuid,
  p_status text,
  p_worker text,
  p_error text default null,
  p_provider_message_id text default null,
  p_retry_delay_seconds integer default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_worker text := nullif(btrim(coalesce(p_worker, '')), '');
  v_delay integer := coalesce(p_retry_delay_seconds, 0);
  v_count integer := 0;
begin
  if v_worker is null then
    raise exception 'aani_complete_notification_outbox: worker name required' using errcode = '42501';
  end if;
  if v_status not in ('sent', 'failed', 'pending') then
    raise exception 'aani_complete_notification_outbox: unknown status %', v_status using errcode = '22023';
  end if;
  if v_delay < 0 then
    v_delay := 0;
  elsif v_delay > 86400 then
    v_delay := 86400;
  end if;

  update public.notification_outbox as task
  set status = case
        when v_status = 'sent' then 'sent'
        when v_status = 'pending' then 'pending'
        when v_delay > 0 then 'pending'
        else 'failed'
      end,
      sent_at = case when v_status = 'sent' then now() else task.sent_at end,
      available_at = case
        when v_status = 'sent' then task.available_at
        when v_delay > 0 then now() + make_interval(secs => v_delay)
        else task.available_at
      end,
      locked_at = null,
      locked_by = null,
      last_error = case
        when v_status = 'sent' then null
        else left(coalesce(p_error, ''), 1000)
      end,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), task.provider_message_id)
  where task.id = p_id
    -- لا إنهاء لمهمة غير محجوزة، ولا لمهمة يحمل قفلها عامل آخر.
    and task.status = 'processing'
    and task.locked_by = v_worker;
  get diagnostics v_count = row_count;
  return v_count > 0;
end
$$;

revoke all on function public.aani_complete_notification_outbox(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.aani_complete_notification_outbox(uuid, text, text, text, text, integer) to service_role;

notify pgrst, 'reload schema';

commit;
