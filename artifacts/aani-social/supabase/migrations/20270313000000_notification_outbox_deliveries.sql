-- تسليم مهمة outbox لكل جهاز: public.notification_outbox_deliveries
--
-- مشكلة بلا هذا الجدول: العامل يرسل المهمة إلى كل الأجهزة ثم يُنهي المهمة.
-- فإذا فشل جهاز واحد فشلاً مؤقتاً وأُعيدت المهمة، أُعيد الإرسال إلى كل
-- الأجهزة — بما فيها التي نجحت — فيصل الإشعار نفسه مرتين.
--
-- الحل: صف تسليم واحد لكل (مهمة، جهاز) بمفتاح فريد، وبحالة لكل صف:
--   * pending: لم ينجح بعد — يُرسَل في المحاولة القادمة.
--   * sent: نجح الإرسال — لا يُرسَل ثانية أبداً.
--   * skipped: جهاز غائب أو رمزه غير صالح (يُلغى بـrevoked_at).
--   * failed: فشل نهائي غير قابل لإعادة المحاولة.
-- إعادة المحاولة تُرسل فقط صفوف pending، فلا يتكرر الإشعار على جهاز نجح.
--
--   * aani_ensure_notification_deliveries تُنشئ الصفوف الناقصة لكل جهاز نشط
--     (provider='fcm' وrevoked_at is null) داخل معاملة واحدة، وتعيد صفوف
--     المهمة. المفتاح الفريد يمنع أي تكرار عند استدعائها أكثر من مرة.
--   * aani_complete_notification_delivery تُنهي صفاً واحداً (أو تعيده إلى
--     pending)، ولا تقبل إلا صفاً ما زال pending، وتُلغي رمز الجهاز عند
--     invalid token بـrevoked_at دون حذف سجله.
--
-- RLS مفعّلة بلا أي سياسة → anon وauthenticated ممنوعان تماماً، والوصول
-- التشغيلي لـservice_role وحده.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

create table if not exists public.notification_outbox_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox (id) on delete cascade,
  device_token_id uuid not null references public.device_tokens (id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint notification_outbox_deliveries_pair_key unique (outbox_id, device_token_id)
);

-- قراءة ما تبقّى للمهمة، وعدّاد إجمالي لما لم يُرسَل بعد.
create index if not exists notification_outbox_deliveries_task_idx
  on public.notification_outbox_deliveries (outbox_id, status);

create index if not exists notification_outbox_deliveries_status_idx
  on public.notification_outbox_deliveries (status);

alter table public.notification_outbox_deliveries enable row level security;
-- لا سياسات RLS إطلاقاً → رفض افتراضي للمستخدمين العاديين.
revoke all on table public.notification_outbox_deliveries from public, anon, authenticated;
grant select, insert, update on table public.notification_outbox_deliveries to service_role;

-- إنشاء صفوف التسليم الناقصة لكل جهاز نشط للمستلم، وإعادة صفوف المهمة.
-- ON CONFLICT DO NOTHING مع المفتاح الفريد يعني: الاستدعاء الثاني لا يضيف
-- صفاً ولا يعيد صفاً أُرسل إلى pending.
create or replace function public.aani_ensure_notification_deliveries(
  p_outbox_id uuid
) returns setof public.notification_outbox_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  if p_outbox_id is null then
    raise exception 'aani_ensure_notification_deliveries: outbox id required' using errcode = '22023';
  end if;

  select task.recipient_user_id into v_recipient
  from public.notification_outbox as task
  where task.id = p_outbox_id;

  -- مهمة غير موجودة: لا شيء لتسليمه.
  if v_recipient is null then
    return;
  end if;

  insert into public.notification_outbox_deliveries (
    outbox_id, device_token_id, recipient_user_id
  )
  select p_outbox_id, device.id, v_recipient
  from public.device_tokens as device
  where device.user_id = v_recipient
    and device.provider = 'fcm'
    and device.revoked_at is null
  on conflict on constraint notification_outbox_deliveries_pair_key do nothing;

  return query
  select delivery.*
  from public.notification_outbox_deliveries as delivery
  where delivery.outbox_id = p_outbox_id
  order by delivery.created_at asc, delivery.id asc;
end
$$;

revoke all on function public.aani_ensure_notification_deliveries(uuid) from public, anon, authenticated;
grant execute on function public.aani_ensure_notification_deliveries(uuid) to service_role;

-- إنهاء صف تسليم واحد: sent / skipped / failed، أو pending لإعادة المحاولة.
-- لا يُقبل إلا صف ما زال pending، فلا يُعاد إرسال ما نجح ولا يُنهى مرتين.
-- p_revoke_token يضبط device_tokens.revoked_at للجهاز صاحب الصف، ولا يحذفه.
create or replace function public.aani_complete_notification_delivery(
  p_delivery_id uuid,
  p_status text,
  p_error text default null,
  p_provider_message_id text default null,
  p_revoke_token boolean default false
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_device uuid;
  v_count integer := 0;
begin
  if p_delivery_id is null then
    raise exception 'aani_complete_notification_delivery: delivery id required' using errcode = '22023';
  end if;
  if v_status not in ('pending', 'sent', 'skipped', 'failed') then
    raise exception 'aani_complete_notification_delivery: unknown status %', v_status using errcode = '22023';
  end if;

  update public.notification_outbox_deliveries as delivery
  set status = v_status,
      attempts = delivery.attempts + 1,
      last_error = case
        when v_status = 'sent' then null
        else nullif(left(coalesce(p_error, ''), 1000), '')
      end,
      provider_message_id = coalesce(
        nullif(btrim(coalesce(p_provider_message_id, '')), ''),
        delivery.provider_message_id
      ),
      -- العودة إلى pending تمسح sent_at: الصف لم ينجح بعد.
      sent_at = case when v_status = 'sent' then now() else null end,
      updated_at = now()
  where delivery.id = p_delivery_id
    and delivery.status = 'pending'
  returning delivery.device_token_id into v_device;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    return false;
  end if;

  if coalesce(p_revoke_token, false) then
    update public.device_tokens as device
    set revoked_at = now(), updated_at = now()
    where device.id = v_device
      and device.revoked_at is null;
  end if;

  return true;
end
$$;

revoke all on function public.aani_complete_notification_delivery(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.aani_complete_notification_delivery(uuid, text, text, text, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
