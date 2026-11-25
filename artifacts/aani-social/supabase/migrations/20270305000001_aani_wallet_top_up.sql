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
  status text not null default 'completed' check (status in ('completed', 'failed', 'refunded')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

-- فهارس للوصول السريع حسب المستخدم والمرجع.
create index if not exists wallet_top_ups_user_idx on public.wallet_top_ups (user_id, created_at desc);
create index if not exists wallet_top_ups_reference_idx on public.wallet_top_ups (payment_reference);

-- تفعيل RLS: لا يستطيع المستخدم إلا الإضافة/القراءة لعملياته الخاصة فقط.
alter table public.wallet_top_ups enable row level security;

drop policy if exists aani_wallet_top_ups_insert_own on public.wallet_top_ups;
create policy aani_wallet_top_ups_insert_own on public.wallet_top_ups
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists aani_wallet_top_ups_select_own on public.wallet_top_ups;
create policy aani_wallet_top_ups_select_own on public.wallet_top_ups
  for select to authenticated
  using (auth.uid() = user_id);

-- لا سياسة تحديث/حذف للمستخدمين على هذا الجدول (السجل دائم وغير قابل للتعديل).

grant insert on public.wallet_top_ups to authenticated;
grant select on public.wallet_top_ups to authenticated;

-- =====================================================================
-- دالة RPC آمنة لشحن المحفظة بعد التحقق من نجاح الدفع من جهة الخادم.
--
-- ملاحظة التكامل (مطلوبة قبل النشر على الإنتاج):
--   قبل استدعاء هذه الدالة، يجب على العميل/الخادم التحقق من نجاح الدفع
--   مباشرة مع مزود الدفع المحدد (p_payment_provider) باستخدام مرجع الدفع
--   (p_payment_reference). فقط بعد تأكيد النجاح من جهة الخادم، يُستدعى
--   هذا RPC لإضافة الرصيد. هذه الدالة لا تتصل بأي مزود دفع بنفسها،
--   ولا تفترض وجوده، ولا تنشئ عملية دفع وهمية.
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
declare
  v_user_id uuid := auth.uid();
  v_existing public.wallet_top_ups%rowtype;
  v_balance integer;
begin
  -- التحقق من الهوية.
  if v_user_id is null then
    raise exception 'auth required' using errcode = '42501';
  end if;

  -- التحقق من صحة المدخلات.
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;
  if p_payment_reference is null or length(trim(p_payment_reference)) = 0 then
    raise exception 'payment reference required' using errcode = '22023';
  end if;
  if p_payment_provider is null or length(trim(p_payment_provider)) = 0 then
    raise exception 'payment provider required' using errcode = '22023';
  end if;

  -- قفل advisory لكل (user, reference) لمنع الطلبات المتزامنة المكررة.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || ':' || p_payment_reference));

  -- فحص idempotency: إن كان المرجع مستخدماً سابقاً، أعد نفس النتيجة دون إضافة مكررة.
  select * into v_existing from public.wallet_top_ups
  where payment_reference = p_payment_reference
  limit 1;
  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'transaction_id', v_existing.id,
      'amount', v_existing.amount,
      'balance', (select balance from public.user_wallets where user_id = v_user_id)
    );
  end if;

  -- التأكد من وجود صف محفظة للمستخدم (إنشاء بصفر إن لم يوجد).
  insert into public.user_wallets (user_id, balance, updated_at)
  values (v_user_id, 0, now())
  on conflict (user_id) do nothing;

  select balance into v_balance from public.user_wallets where user_id = v_user_id for update;

  -- إضافة الرصيد (يُفترض أن التحقق من نجاح الدفع مع المزود تم بالفعل من جهة
  -- الخادم قبل استدعاء هذه الدالة؛ لا إضافة وهمية هنا، الرصيد يُضاف فعلياً).
  update public.user_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = v_user_id;

  select balance into v_balance from public.user_wallets where user_id = v_user_id;

  -- تسجيل عملية الشحن (سجل دائم، غير قابل للتعديل من العميل).
  insert into public.wallet_top_ups (
    user_id, amount, payment_reference, payment_provider, status, created_at, verified_at
  )
  values (
    v_user_id, p_amount, p_payment_reference, p_payment_provider, 'completed', now(), now()
  )
  returning * into v_existing;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'transaction_id', v_existing.id,
    'amount', p_amount,
    'balance', v_balance,
    'payment_reference', p_payment_reference,
    'payment_provider', p_payment_provider
  );
end;
$$;

-- إلغاء جميع الصلاحيات ومنح التنفيذ للمستخدمين المصادق عليهم فقط.
revoke all on function public.aani_wallet_top_up(integer, text, text) from public, anon;
grant execute on function public.aani_wallet_top_up(integer, text, text) to authenticated;

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
