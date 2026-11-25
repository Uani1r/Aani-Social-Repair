-- =====================================================================
-- شحن رصيد المحفظة (Wallet Top-Up) — ترحيل مستقل وآمن.
--
-- الغرض: توفير مدخل خادم آمن (RPC) لإضافة رصيد عملات إلى محفظة المستخدم
-- فقط بعد التحقق من نجاح الدفع من جهة الخادم. لا يُسمح للعميل بتعديل
-- رصيد المحفظة مباشرة؛ كل إضافة تمر عبر هذه الدالة ضمن معاملة واحدة.
--
--重要: لا يفترض هذا الترحيل مزود دفع معين (Stripe / Razorpay / PayPal / …)
-- ولا ينشئ عملية دفع وهمية. الدالة تقبل مرجع دفع خارجي (payment_reference)
-- يُsupplyه مزود الدفع بعد نجاح عملية الدفع. منطق التحقق الفعلي من مزود
-- الدفع يحتاج تكاملاً منفصلاً (انظر ملاحظات التكامل في PopularityGiftsSheet.tsx
-- و lib/gifts.ts). لا يُدعى أي نجاح للشحن قبل إكمال هذا التكامل.
--
-- الترحيل مستقل: لا يعيد إنشاء جداول أو دوال موجودة، ولا ينفّذ SQL على
-- قاعدة الإنتاج أثناء النشر، ومتوافق مع الترحيل المطبّق حالياً
-- (20261124181406_aani_gifts_popularity_final و 20270305000000_gifts_block_send_guard).
-- =====================================================================
begin;

-- جدول تسجيل عمليات شحن الرصيد (idempotency عبر payment_reference).
create table if not exists public.wallet_top_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount integer not null check (amount > 0),
  payment_reference text not null unique,
  payment_provider text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'refunded')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

-- فهارس للوصول السريع حسب المستخدم والمرجع.
create index if not exists wallet_top_ups_user_idx on public.wallet_top_ups (user_id, created_at desc);
create index if not exists wallet_top_ups_reference_idx on public.wallet_top_ups (payment_reference);

-- تفعيل RLS على جدول التسجيل.
-- التسجيل خادمي فقط: لا يُسمح للمستخدمين (authenticated) بإدراج سجلات مباشرة.
alter table public.wallet_top_ups enable row level security;

-- لا توجد سياسة إدراج لمستخدمي التطبيق على هذا الجدول.
-- يتم الإدراج حصرياً من جانب الخادم الموثوق (service_role / دور إداري)
-- بعد التحقق من نجاح الدفع مع مزود الدفع الفعلي.

drop policy if exists aani_wallet_top_ups_insert_own on public.wallet_top_ups;

drop policy if exists aani_wallet_top_ups_select_own on public.wallet_top_ups;
create policy aani_wallet_top_ups_select_own on public.wallet_top_ups
  for select to authenticated
  using (auth.uid() = user_id);

-- لا سياسة تحديث/حذف للمستخدمين على هذا الجدول (السجل دائم وغير قابل للتعديل).

-- صلاحيات الجدول: SELECT للمستخدم على سجلاته فقط؛ REVOKE صريح لـ INSERT/UPDATE/DELETE.
revoke insert, update, delete on public.wallet_top_ups from public;
revoke insert, update, delete on public.wallet_top_ups from anon;
revoke insert, update, delete on public.wallet_top_ups from authenticated;
-- ضمان عدم وجود صلاحية INSERT/UPDATE/DELETE حتى لو منحت سابقاً.
revoke all on public.wallet_top_ups from public;
revoke all on public.wallet_top_ups from anon;
revoke all on public.wallet_top_ups from authenticated;
grant select on public.wallet_top_ups to authenticated;

-- =====================================================================
-- دالة RPC لشحن المحفظة — غير متاحة حتى تكامل مزود دفع فعلي من جهة الخادم.
--
-- تحذير أمني (مهم):
--   هذه الدالة لا تضيف أي رصيد بناءً على مدخلات يرسلها العميل (مبلغ، مرجع دفع،
--   مزود دفع). إلى أن يُدمج مزود دفع فعلي وتُُنفّذ عملية تحقق خادم-خادم موثوقة
--   من نجاح الدفع، تُرفع هذه الدالة استثناءً وت refuse أي إضافة للرصيد.
--
-- عند التكامل المستقبلي:
--   1. يُستدعى هذا RPC من خادم موثوق فقط (service_role / دور إداري)، وليس من
--      واجهة المستخدم مباشرة.
--   2. يجب على الخادم التحقق من نجاح الدفع مع المزود المحدد باستخدام مرجع الدفع
--      قبل استدعاء هذه الدالة.
--   3. تُمنح execute على هذه الدالة للدور الخادم الموثوق فقط.
-- =====================================================================
create or replace function public.aani_wallet_top_up(
  p_amount integer,
  p_payment_reference text,
  p_payment_provider text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- الشحن معطل إلى حين تكامل مزود دفع فعلي من جهة الخادم.
  -- لا تُضاف أي عملات استناداً إلى مرجع أو مزود يرسلهما العميل.
  raise exception
    'خدمة شحن الرصيد غير متاحة حتى تكامل مزود دفع فعلي من جهة الخادم. لا يُضاف أي رصيد.';
end;
$$;

-- لا تُمنح execute على هذه الدالة لمستخدمي التطبيق (authenticated).
-- يتم الاستدعاء حصرياً من جانب الخادم الموثوق بعد التحقق من نجاح الدفع.
revoke all on function public.aani_wallet_top_up(integer, text, text) from public, anon, authenticated;

-- تنبيه realtime لبث تحديث الرصيد (عند توفر النشر).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'wallet_top_ups'
     ) then
    execute 'alter publication supabase_realtime add table public.wallet_top_ups';
  end if;
end $$;

commit;
