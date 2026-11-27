-- محدّد معدل مشترك لتسجيل الدخول بالهاتف.
--
-- الخريطة داخل نسخة دالة واحدة ليست حماية إنتاجية: نسخ الدالة المتعددة لا
-- تتشارك الذاكرة. هذا الجدول هو الحالة المشتركة، ودالته عبارة واحدة ذرية
-- (insert ... on conflict ... do update ... where) تجعل كل زيادة محاولة
-- مقروءة-ومكتوبة بأمان تحت التزامن.
--
-- الخصوصية: العمود bucket بصمة SHA-256 (من الخادم) لرقم الهاتف أو لعنوان IP،
-- وليس رقماً خاماً ولا كلمة مرور ولا رمز جلسة. لا شيء هنا يُسجَّل في السجلات.
--
-- RLS مفعّل بلا سياسات، وسُحبت كل صلاحيات anon/authenticated/service_role عن
-- الجدول: الوصول عبر الدالة أدناه لـ service_role فقط.

begin;

create table if not exists public.login_rate_limits (
  bucket text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  constraint login_rate_limits_bucket_format check (bucket ~ '^[a-z0-9:]{16,200}$'),
  constraint login_rate_limits_attempts_range check (attempts >= 0 and attempts <= 1000)
);

comment on table public.login_rate_limits is
  'محدّد محاولات مشترك للدخول: بصمة مفتاح (لا رقم هاتف خام) وعدد المحاولات في النافذة.';
comment on column public.login_rate_limits.bucket is
  'بصمة SHA-256 لمصدر المحاولة أو رقم الهاتف — لا تُخزَّن قيم خامة.';
comment on column public.login_rate_limits.window_started_at is
  'بداية النافذة الحالية؛ عند انتهائها تُصفَّر المحاولات.';

create index if not exists login_rate_limits_window_idx
  on public.login_rate_limits (window_started_at);

alter table public.login_rate_limits enable row level security;

revoke all on table public.login_rate_limits from public;
revoke all on table public.login_rate_limits from anon;
revoke all on table public.login_rate_limits from authenticated;
revoke all on table public.login_rate_limits from service_role;

-- استهلاك محاولة واحدة ذرياً: يسمح أو يرفض، ويعيد المتبقي وزمن الانتظار.
create or replace function public.aani_consume_login_attempt(
  p_bucket text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval;
  v_row public.login_rate_limits%rowtype;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9:]{16,200}$' then
    raise exception 'invalid_bucket' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_window' using errcode = '22023';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 1000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  -- تنظيف النوافذ المنتهية (مفهرس، ورخيص).
  delete from public.login_rate_limits where window_started_at < v_now - (v_window * 2);

  insert into public.login_rate_limits as l (bucket, window_started_at, attempts)
  values (p_bucket, v_now, 1)
  on conflict (bucket) do update
    set window_started_at = case
          when l.window_started_at <= v_now - v_window then v_now
          else l.window_started_at
        end,
        attempts = case
          when l.window_started_at <= v_now - v_window then 1
          else l.attempts + 1
        end
    where l.window_started_at <= v_now - v_window
       or l.attempts < p_max_attempts
  returning * into v_row;

  if v_row.bucket is null then
    -- النافذة مكتملة: لا صف مُعاد من العبارة السابقة.
    select * into v_row from public.login_rate_limits where bucket = p_bucket;
    if v_row.bucket is null then
      return query select true, greatest(0, p_max_attempts - 1), 0;
      return;
    end if;
    return query
      select false,
             0,
             greatest(
               1,
               ceil(extract(epoch from ((v_row.window_started_at + v_window) - v_now)))::integer
             );
    return;
  end if;

  return query select true, greatest(0, p_max_attempts - v_row.attempts), 0;
end;
$$;

comment on function public.aani_consume_login_attempt(text, integer, integer) is
  'استهلاك محاولة دخول ذري من نافذة مشتركة؛ يعيد allowed/remaining/retry_after_seconds.';

revoke all on function public.aani_consume_login_attempt(text, integer, integer) from public;
revoke all on function public.aani_consume_login_attempt(text, integer, integer) from anon;
revoke all on function public.aani_consume_login_attempt(text, integer, integer) from authenticated;
grant usage on schema public to service_role;
grant execute on function public.aani_consume_login_attempt(text, integer, integer) to service_role;

commit;
