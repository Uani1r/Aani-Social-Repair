-- =====================================================================
-- نظام Sandbox المالي التجريبي (معزول تمامًا عن الإنتاج)
--
-- الغرض: بيئة مالية مجانية تجريبية لاختبار العملات والهدايا والشحن
-- والاشتراكات وترويج المنشورات/الريلز، دون أي بوابة دفع حقيقية أو Apple IAP.
--
-- ملاحظات التصميم والأمان (مطابقة للشروط الإلزامية):
--   * كل الجداول في مخطط `sandbox` المنفصل ⇒ لا اختلاط بيانات Sandbox مع تقارير الإنتاج.
--   * الرصيد يُحسب من سجل `sandbox.ledger` المستقل؛ لا توجد محفظة أرصدة مكررة
--     ولا مسّ لجدول public.user_wallets.
--   * لا تُسجل أي هدية تجريبية في public.gift_transactions ولا تؤثر في
--     public.aani_user_popularity (نقاط الشعبية التجريبية دائمًا 0).
--   * جميع تغييرات الأرصدة تجري عبر دوال RPC security-definer ضمن معاملات ذرية
--     ومفاتيح idempotency، ولا يُسمح للعميل بإضافة عملات أو تعديل أرصدة مباشرة.
--   * هوية المؤسس تُثبت من جلسة موثقة (auth.uid) وصلاحية خادم (جدول sandbox.founders)
--     لا من أي قيمة يرسلها المتصفح.
--   * لا تُنقل عملات/هدايا/شعبية Sandbox إلى النظام الحقيقي، ولا العكس.
-- آمن للإعادة التشغيل (idempotent): يُنشئ الناقص ويُعيد إنشاء الدوال والسياسات
-- دون حذف بيانات قائمة. لا يفترض أن schema.sql يطابق القاعدة الحية مباشرة؛
-- يُطبّق هذا الترحيل كملف مستقل.
-- =====================================================================

-- المخطط المعزول لجميع جداول Sandbox.
create schema if not exists sandbox;

-- تمكين مستخدمي التطبيق من الوصول إلى مخطط sandbox عبر PostgREST API.
-- (قد يحتاج responsible Supabase project أيضًا إلى إظهار المخطط في إعدادات API.)
grant usage on schema sandbox to authenticated;

-- =====================================================================
-- دالة التحقق من هوية المؤسس (تُعرف قبل أي سياسة أو دالة تستدعيها)
-- =====================================================================
create or replace function public.aani_sandbox_is_founder()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from sandbox.founders f where f.user_id = auth.uid());
$$;
revoke all on function public.aani_sandbox_is_founder() from public, anon;
grant execute on function public.aani_sandbox_is_founder() to authenticated;

-- =====================================================================
-- 1. حزم العملات للشحن التجريبي (كتالوج عرض فقط؛ الأسعار وهمية، لا دفع حقيقي)
-- =====================================================================
create table if not exists sandbox.top_up_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  coins integer not null check (coins > 0),
  price_usd numeric not null default 0 check (price_usd >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table sandbox.top_up_packages enable row level security;
drop policy if exists sandbox_top_up_packages_select on sandbox.top_up_packages;
create policy sandbox_top_up_packages_select on sandbox.top_up_packages
  for select to authenticated using (true);
grant select on sandbox.top_up_packages to authenticated;

insert into sandbox.top_up_packages (name, coins, price_usd, is_active)
select * from (values
  ('باقة صغيرة', 500, 4.99, true),
  ('باقة متوسطة', 1500, 12.99, true),
  ('باقة كبيرة', 5000, 39.99, true),
  ('باقة ضخمة', 12000, 89.99, true)
) as v(name, coins, price_usd, is_active)
where not exists (select 1 from sandbox.top_up_packages p where p.name = v.name);

-- =====================================================================
-- 2. السجل المالي المستقل (مصدر حقيقة الرصيد التجريبي)
--    الرصيد = مجموع الأرصدة الدائنة - مجموع المدن لكل مستخدم
-- =====================================================================
create table if not exists sandbox.ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('credit','debit')),
  amount integer not null check (amount > 0),
  reference text not null,
  idempotency_key text not null unique,
  related_id uuid,
  created_at timestamptz not null default now()
);
alter table sandbox.ledger enable row level security;
drop policy if exists sandbox_ledger_select_own on sandbox.ledger;
create policy sandbox_ledger_select_own on sandbox.ledger
  for select to authenticated
  using (auth.uid() = user_id or public.aani_sandbox_is_founder());
-- لا سياسة إدراج/تحديث/حذف مباشرة للمستخدمين؛ الكتابة عبر دوال RPC آمنة فقط.
revoke all on sandbox.ledger from public, anon, authenticated;
grant select on sandbox.ledger to authenticated;
create index if not exists sandbox_ledger_user_idx on sandbox.ledger (user_id, created_at desc);
create index if not exists sandbox_ledger_idempotency_idx on sandbox.ledger (idempotency_key);

-- =====================================================================
-- 3. سجل الهدايا التجريبي (منفصل تمامًا عن public.gift_transactions)
--    popularity_points دائمًا 0 ⇒ لا نقاط شعبية حقيقية.
-- =====================================================================
create table if not exists sandbox.gift_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_id uuid not null references public.gifts (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  price_paid integer not null check (price_paid >= 0),
  popularity_points integer not null default 0 check (popularity_points = 0),
  created_at timestamptz not null default now(),
  idempotency_key text not null unique,
  is_sandbox boolean not null default true,
  constraint sandbox_gift_not_self check (sender_id <> recipient_id)
);
alter table sandbox.gift_transactions enable row level security;
drop policy if exists sandbox_gift_transactions_select_own on sandbox.gift_transactions;
create policy sandbox_gift_transactions_select_own on sandbox.gift_transactions
  for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id or public.aani_sandbox_is_founder());
revoke all on sandbox.gift_transactions from public, anon, authenticated;
grant select on sandbox.gift_transactions to authenticated;
create index if not exists sandbox_gift_recipient_idx on sandbox.gift_transactions (recipient_id, created_at desc);
create index if not exists sandbox_gift_sender_idx on sandbox.gift_transactions (sender_id, created_at desc);
create index if not exists sandbox_gift_idempotency_idx on sandbox.gift_transactions (idempotency_key);

-- =====================================================================
-- 4. سجل الشحن التجريبي (محاكاة ناجح / فاشل)
-- =====================================================================
create table if not exists sandbox.top_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  package_id uuid not null references sandbox.top_up_packages (id),
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending','completed','failed','refunded')),
  idempotency_key text not null unique,
  simulated boolean not null default true,
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table sandbox.top_ups enable row level security;
drop policy if exists sandbox_top_ups_select_own on sandbox.top_ups;
create policy sandbox_top_ups_select_own on sandbox.top_ups
  for select to authenticated
  using (auth.uid() = user_id or public.aani_sandbox_is_founder());
revoke all on sandbox.top_ups from public, anon, authenticated;
grant select on sandbox.top_ups to authenticated;
create index if not exists sandbox_top_ups_user_idx on sandbox.top_ups (user_id, created_at desc);

-- =====================================================================
-- 5. سجل الاستردادات التجريبية (قيد فريد يمنع استرداد نفس الشحن مرتين)
-- =====================================================================
create table if not exists sandbox.refunds (
  id uuid primary key default gen_random_uuid(),
  top_up_id uuid not null references sandbox.top_ups (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  amount integer not null check (amount > 0),
  reason text not null,
  created_at timestamptz not null default now(),
  constraint sandbox_refunds_one_per_topup unique (top_up_id)
);
alter table sandbox.refunds enable row level security;
drop policy if exists sandbox_refunds_select_own on sandbox.refunds;
create policy sandbox_refunds_select_own on sandbox.refunds
  for select to authenticated
  using (auth.uid() = user_id or public.aani_sandbox_is_founder());
revoke all on sandbox.refunds from public, anon, authenticated;
grant select on sandbox.refunds to authenticated;
create index if not exists sandbox_refunds_top_up_idx on sandbox.refunds (top_up_id);

-- =====================================================================
-- 6. حزم الاشتراك التجريبي
-- =====================================================================
create table if not exists sandbox.subscription_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  coins_price integer not null check (coins_price >= 0),
  duration_days integer not null check (duration_days > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table sandbox.subscription_packages enable row level security;
drop policy if exists sandbox_subscription_packages_select on sandbox.subscription_packages;
create policy sandbox_subscription_packages_select on sandbox.subscription_packages
  for select to authenticated using (true);
grant select on sandbox.subscription_packages to authenticated;

insert into sandbox.subscription_packages (name, coins_price, duration_days, is_active)
select * from (values
  ('اشتراك أسبوعي', 100, 7, true),
  ('اشتراك شهري', 300, 30, true),
  ('اشتراك سنوي', 3000, 365, true)
) as v(name, coins_price, duration_days, is_active)
where not exists (select 1 from sandbox.subscription_packages p where p.name = v.name);

-- =====================================================================
-- 7. اشتراكات المستخدمين التجريبية
-- =====================================================================
create table if not exists sandbox.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  package_id uuid not null references sandbox.subscription_packages (id),
  status text not null default 'active' check (status in ('active','expired','cancelled')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  renewed_at timestamptz,
  cancelled_at timestamptz,
  auto_renew boolean not null default true,
  coins_charged integer not null check (coins_charged >= 0)
);
alter table sandbox.subscriptions enable row level security;
drop policy if exists sandbox_subscriptions_select_own on sandbox.subscriptions;
create policy sandbox_subscriptions_select_own on sandbox.subscriptions
  for select to authenticated
  using (auth.uid() = user_id or public.aani_sandbox_is_founder());
revoke all on sandbox.subscriptions from public, anon, authenticated;
grant select on sandbox.subscriptions to authenticated;
create index if not exists sandbox_subscriptions_user_idx on sandbox.subscriptions (user_id, status);

-- =====================================================================
-- 8. حزم الترويج التجريبي (منشورات / ريلز)
-- =====================================================================
create table if not exists sandbox.promotion_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  target_type text not null check (target_type in ('post','reel')),
  coins_price integer not null check (coins_price >= 0),
  duration_days integer not null check (duration_days > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table sandbox.promotion_packages enable row level security;
drop policy if exists sandbox_promotion_packages_select on sandbox.promotion_packages;
create policy sandbox_promotion_packages_select on sandbox.promotion_packages
  for select to authenticated using (true);
grant select on sandbox.promotion_packages to authenticated;

insert into sandbox.promotion_packages (name, target_type, coins_price, duration_days, is_active)
select * from (values
  ('ترويج منشور - أسبوع', 'post', 200, 7, true),
  ('ترويج ريل - أسبوع', 'reel', 250, 7, true),
  ('ترويج منشور - شهر', 'post', 700, 30, true),
  ('ترويج ريل - شهر', 'reel', 900, 30, true)
) as v(name, target_type, coins_price, duration_days, is_active)
where not exists (select 1 from sandbox.promotion_packages p where p.name = v.name);

-- =====================================================================
-- 9. حملات الترويج التجريبية (مع idempotency key لمنع التكرار)
--    target_id مرجع إنتاجي بدون قيد FK لتجنب الإقران القوي مع الإنتاج.
-- =====================================================================
create table if not exists sandbox.promotions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  package_id uuid not null references sandbox.promotion_packages (id),
  target_type text not null check (target_type in ('post','reel')),
  target_id uuid not null,
  idempotency_key text not null unique,
  status text not null default 'active' check (status in ('active','ended','failed')),
  started_at timestamptz not null default now(),
  ends_at timestamptz,
  coins_deducted integer not null check (coins_deducted >= 0),
  failure_reason text,
  created_at timestamptz not null default now()
);
alter table sandbox.promotions enable row level security;
drop policy if exists sandbox_promotions_select_own on sandbox.promotions;
create policy sandbox_promotions_select_own on sandbox.promotions
  for select to authenticated
  using (auth.uid() = user_id or public.aani_sandbox_is_founder());
revoke all on sandbox.promotions from public, anon, authenticated;
grant select on sandbox.promotions to authenticated;
create index if not exists sandbox_promotions_user_idx on sandbox.promotions (user_id, created_at desc);
create index if not exists sandbox_promotions_idempotency_idx on sandbox.promotions (idempotency_key);

-- =====================================================================
-- 10. مؤسسو Sandbox (قائمة سماح من جانب الخادم فقط)
--     تُضاف الصفوف عبر SQL 측서-side فقط؛ لا يرسل المتصفح أي ادعاء بمنصب المؤسس.
--     الجدول فارغ افتراضيًا: يضيف مسؤول القاعدة معرفات المؤسسين reales عبر SQL.
-- =====================================================================
create table if not exists sandbox.founders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table sandbox.founders enable row level security;
drop policy if exists sandbox_founders_select_own on sandbox.founders;
create policy sandbox_founders_select_own on sandbox.founders
  for select to authenticated
  using (auth.uid() = user_id);
revoke all on sandbox.founders from public, anon, authenticated;
grant select on sandbox.founders to authenticated;

-- =====================================================================
-- 11. سجل إجراءات المسؤول (تدقيق): الفاعل، الوقت، السبب، النتيجة
-- =====================================================================
create table if not exists sandbox.admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.profiles (id),
  action text not null,
  target_type text not null,
  target_id uuid,
  reason text not null,
  result text not null check (result in ('ok','error')),
  created_at timestamptz not null default now()
);
alter table sandbox.admin_actions enable row level security;
drop policy if exists sandbox_admin_actions_select on sandbox.admin_actions;
create policy sandbox_admin_actions_select on sandbox.admin_actions
  for select to authenticated
  using (auth.uid() = actor_user_id or public.aani_sandbox_is_founder());
revoke all on sandbox.admin_actions from public, anon, authenticated;
grant select on sandbox.admin_actions to authenticated;
create index if not exists sandbox_admin_actions_actor_idx on sandbox.admin_actions (actor_user_id, created_at desc);

-- =====================================================================
-- دوال RPC آمنة (security-definer) في المخطط العام لاستدعائها من العميل عبر rpc()
-- جميعها تتحقق من الجلسة (auth.uid) وصلاحيات الخادم، لا تثق في مدخلات المتصفح للأرصدة.
-- =====================================================================

-- الرصيد التجريبي لمستخدم (يُحسب من السجل، لا محفظة مكررة).
-- لا يمكن لأي مستخدم قراءة رصيد مستخدم آخر؛ الاستثناء المؤسس المصرح له.
create or replace function public.aani_sandbox_balance(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden: cannot read another user sandbox balance' using errcode='42501';
  end if;
  select coalesce(sum(case when type = 'credit' then amount else -amount end), 0)::integer
  into v_balance
  from sandbox.ledger
  where user_id = p_user_id;
  return v_balance;
end;
$$;
revoke all on function public.aani_sandbox_balance(uuid) from public, anon;
grant execute on function public.aani_sandbox_balance(uuid) to authenticated;

-- منح عملات تجريبية (مؤسس فقط) مع قفل على مستوى المستخدم + idempotency + قفل استشاري للمعاملة.
create or replace function public.aani_sandbox_grant_coins(
  p_user_id uuid,
  p_amount integer,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if not public.aani_sandbox_is_founder() then
    raise exception 'founder required' using errcode='42501';
  end if;
  if p_amount <= 0 then raise exception 'invalid amount' using errcode='22023'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  -- قفل على مستوى المستخدم لمنع عمليات منافسة على نفس المستخدم.
  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || p_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:grant:' || p_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key) then
    if not exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key and user_id = p_user_id and amount = p_amount and reference = p_reason) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    select public.aani_sandbox_balance(p_user_id) into v_balance;
    return jsonb_build_object('ok',true,'duplicate',true,'amount',p_amount,'balance',v_balance);
  end if;

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (p_user_id, 'credit', p_amount, p_reason, p_idempotency_key, null);

  select public.aani_sandbox_balance(p_user_id) into v_balance;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'grant_coins', 'user', p_user_id, p_reason, 'ok');

  return jsonb_build_object('ok',true,'duplicate',false,'amount',p_amount,'balance',v_balance);
end;
$$;
revoke all on function public.aani_sandbox_grant_coins(uuid,integer,text,text) from public, anon;
grant execute on function public.aani_sandbox_grant_coins(uuid,integer,text,text) to authenticated;

-- خصم عملات تجريبية (المالك أو المؤسس) مع قفل على مستوى المستخدم + idempotency + قفل استشاري.
-- القفل على مستوى المستخدم يضمن أن عمليتي خصم مختلفتين لنفس المستخدم تتسلسلان،
-- فلا تتجاوزا الرصيد المتاح معًا.
create or replace function public.aani_sandbox_deduct_coins(
  p_user_id uuid,
  p_amount integer,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_amount <= 0 then raise exception 'invalid amount' using errcode='22023'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  -- قفل على مستوى المستخدم يمنع عمليتي خصم مختلفتين من تجاوز الرصيد.
  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || p_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:deduct:' || p_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key) then
    if not exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key and user_id = p_user_id and amount = p_amount and reference = p_reason) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    select public.aani_sandbox_balance(p_user_id) into v_balance;
    return jsonb_build_object('ok',true,'duplicate',true,'amount',p_amount,'balance',v_balance);
  end if;

  select public.aani_sandbox_balance(p_user_id) into v_balance;
  if v_balance < p_amount then raise exception 'insufficient sandbox balance' using errcode='42001'; end if;

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (p_user_id, 'debit', p_amount, p_reason, p_idempotency_key, null);

  select public.aani_sandbox_balance(p_user_id) into v_balance;

  return jsonb_build_object('ok',true,'duplicate',false,'amount',p_amount,'balance',v_balance);
end;
$$;
revoke all on function public.aani_sandbox_deduct_coins(uuid,integer,text,text) from public, anon;
grant execute on function public.aani_sandbox_deduct_coins(uuid,integer,text,text) to authenticated;

-- إرسال هدية تجريبية: خصم من رصيد Sandbox فقط، لا نقاط شعبية، سجل منفصل.
create or replace function public.aani_sandbox_send_gift(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_gift_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_price integer;
  v_balance integer;
  v_existing sandbox.gift_transactions%rowtype;
  v_tx sandbox.gift_transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_sender_id then raise exception 'forbidden' using errcode='42501'; end if;
  if p_sender_id = p_recipient_id then raise exception 'self' using errcode='22023'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:gift:' || p_sender_id::text || ':' || p_idempotency_key));

  select * into v_existing from sandbox.gift_transactions
  where sender_id = p_sender_id and idempotency_key = p_idempotency_key
  limit 1;
  if found then
    return jsonb_build_object('ok',true,'duplicate',true,'transaction_id',v_existing.id,
      'price_paid',v_existing.price_paid,'popularity_points',v_existing.popularity_points,'sandbox',true);
  end if;

  select price into v_price from public.gifts where id = p_gift_id and is_active = true;
  if not found then raise exception 'gift unavailable' using errcode='42704'; end if;

  -- الخصم من الرصيد التجريبي قبل تسجيل المعاملة (ضمان الاتساق عند إعادة المحاولة).
  -- deduct_coins تضيف قفلًا على مستوى المستخدم.
  perform public.aani_sandbox_deduct_coins(p_sender_id, v_price, p_idempotency_key || ':gift', 'sandbox gift send');

  select public.aani_sandbox_balance(p_sender_id) into v_balance;

  insert into sandbox.gift_transactions (gift_id, sender_id, recipient_id, price_paid, popularity_points, created_at, idempotency_key, is_sandbox)
  values (p_gift_id, p_sender_id, p_recipient_id, v_price, 0, now(), p_idempotency_key, true)
  returning * into v_tx;

  return jsonb_build_object('ok',true,'duplicate',false,'transaction_id',v_tx.id,'price_paid',v_price,
    'popularity_points',0,'sandbox',true,'balance',v_balance);
end;
$$;
revoke all on function public.aani_sandbox_send_gift(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.aani_sandbox_send_gift(uuid,uuid,uuid,text) to authenticated;

-- شحن تجريبي (محاكاة ناجح / فاشل): يختار العميل باقة فقط؛ المبلغ من الكتالوج.
-- تُضاف العملات فقط عند النجاح، ويُمنع التكرار عبر idempotency.
create or replace function public.aani_sandbox_top_up(
  p_user_id uuid,
  p_package_id uuid,
  p_idempotency_key text,
  p_simulate_success boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_coins integer;
  v_balance integer;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_user_id then raise exception 'forbidden' using errcode='42501'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || p_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:topup:' || p_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.top_ups where idempotency_key = p_idempotency_key) then
    if not exists (select 1 from sandbox.top_ups where idempotency_key = p_idempotency_key and user_id = p_user_id and package_id = p_package_id) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    return jsonb_build_object('ok',true,'duplicate',true,'status',
      (select status from sandbox.top_ups where idempotency_key = p_idempotency_key));
  end if;

  select coins into v_coins from sandbox.top_up_packages where id = p_package_id and is_active = true;
  if not found then raise exception 'package unavailable' using errcode='42704'; end if;

  if p_simulate_success then
    -- إضافة العملات فقط عند النجاح (سجل ledger مستقر عبر idempotency).
    insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
    values (p_user_id, 'credit', v_coins, 'sandbox top-up', p_idempotency_key || ':credit', null)
    on conflict (idempotency_key) do nothing;

    insert into sandbox.top_ups (user_id, package_id, amount, status, idempotency_key, simulated, created_at, completed_at)
    values (p_user_id, p_package_id, v_coins, 'completed', p_idempotency_key, true, now(), now());

    select public.aani_sandbox_balance(p_user_id) into v_balance;

    return jsonb_build_object('ok',true,'duplicate',false,'status','completed','amount',v_coins,
      'balance',v_balance,'simulated',true);
  else
    insert into sandbox.top_ups (user_id, package_id, amount, status, idempotency_key, simulated, failure_reason, created_at)
    values (p_user_id, p_package_id, v_coins, 'failed', p_idempotency_key, true, 'محاكاة فشل الشحن', now());

    return jsonb_build_object('ok',false,'duplicate',false,'status','failed','amount',v_coins,
      'balance',null,'simulated',true,'error','شحن تجريبي فاشل (محاكاة)');
  end if;
end;
$$;
revoke all on function public.aani_sandbox_top_up(uuid,uuid,text,boolean) from public, anon;
grant execute on function public.aani_sandbox_top_up(uuid,uuid,text,boolean) to authenticated;

-- استرداد تجريبي (مؤسس فقط): ذري، مقاوم للتكرار والتزامن.
-- يقفل صف الشحن (FOR UPDATE)، يتحقق من حالته قبل الخصم، ويمنع استرداد الشحن مرتين.
create or replace function public.aani_sandbox_refund_top_up(
  p_top_up_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_amount integer;
  v_status text;
begin
  if not public.aani_sandbox_is_founder() then
    raise exception 'founder required' using errcode='42501';
  end if;

  -- قفل صف الشحن للتزامن ومنع استرداد مزدوج Concurrent.
  select user_id, amount, status into v_user_id, v_amount, v_status
  from sandbox.top_ups where id = p_top_up_id
  for update;

  if not found then raise exception 'top-up not found' using errcode='42704'; end if;
  if v_status <> 'completed' then raise exception 'only completed top-ups can be refunded' using errcode='42001'; end if;
  if exists (select 1 from sandbox.refunds where top_up_id = p_top_up_id) then
    raise exception 'top-up already refunded' using errcode='42001';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || v_user_id::text));

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (v_user_id, 'debit', v_amount, 'sandbox refund: ' || p_reason, gen_random_uuid()::text, p_top_up_id);

  update sandbox.top_ups set status = 'refunded' where id = p_top_up_id;

  insert into sandbox.refunds (top_up_id, user_id, amount, reason)
  values (p_top_up_id, v_user_id, v_amount, p_reason);

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'refund_top_up', 'top_up', p_top_up_id, p_reason, 'ok');

  return jsonb_build_object('ok',true,'status','refunded','amount',v_amount,'user_id',v_user_id);
end;
$$;
revoke all on function public.aani_sandbox_refund_top_up(uuid,text) from public, anon;
grant execute on function public.aani_sandbox_refund_top_up(uuid,text) to authenticated;

-- تفعيل اشتراك تجريبي (خصم عملات تجريبية، مزايا Sandbox فقط).
-- يدعم idempotency ولا يولد مفتاحًا عشوائيًا جديدًا عند كل إعادة محاولة.
create or replace function public.aani_sandbox_activate_subscription(
  p_user_id uuid,
  p_package_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_coins integer;
  v_days integer;
  v_balance integer;
  v_sub_id uuid;
  v_status text;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || p_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:sub:' || p_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key) then
    select related_id, amount into v_sub_id, v_coins
    from sandbox.ledger where idempotency_key = p_idempotency_key;
    if v_sub_id is null or not exists (
      select 1 from sandbox.subscriptions s
      where s.id = v_sub_id and s.user_id = p_user_id and s.package_id = p_package_id
    ) or not exists (
      select 1 from sandbox.ledger where idempotency_key = p_idempotency_key and user_id = p_user_id and reference = 'sandbox subscription activate'
    ) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    select status into v_status from sandbox.subscriptions where id = v_sub_id;
    select public.aani_sandbox_balance(p_user_id) into v_balance;
    return jsonb_build_object('ok',true,'duplicate',true,'coins_charged',v_coins,'balance',v_balance,'status',v_status,'subscription_id',v_sub_id);
  end if;

  select coins_price, duration_days into v_coins, v_days
  from sandbox.subscription_packages where id = p_package_id and is_active = true;
  if not found then raise exception 'package unavailable' using errcode='42704'; end if;

  select public.aani_sandbox_balance(p_user_id) into v_balance;
  if v_balance < v_coins then raise exception 'insufficient sandbox balance' using errcode='42001'; end if;

  insert into sandbox.subscriptions (user_id, package_id, status, started_at, ended_at, auto_renew, coins_charged)
  values (p_user_id, p_package_id, 'active', now(), now() + (v_days || ' days')::interval, true, v_coins)
  returning id into v_sub_id;

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (p_user_id, 'debit', v_coins, 'sandbox subscription activate', p_idempotency_key, v_sub_id);

  select public.aani_sandbox_balance(p_user_id) into v_balance;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'activate_subscription', 'subscription', null, 'sandbox activate', 'ok');

  return jsonb_build_object('ok',true,'duplicate',false,'coins_charged',v_coins,'balance',v_balance,'status','active');
end;
$$;
revoke all on function public.aani_sandbox_activate_subscription(uuid,uuid,text) from public, anon;
grant execute on function public.aani_sandbox_activate_subscription(uuid,uuid,text) to authenticated;

-- إلغاء اشتراك تجريبي.
create or replace function public.aani_sandbox_cancel_subscription(
  p_subscription_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;

  select user_id into v_user_id from sandbox.subscriptions where id = p_subscription_id;
  if not found then raise exception 'subscription not found' using errcode='42704'; end if;
  if auth.uid() <> v_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden' using errcode='42501';
  end if;

  update sandbox.subscriptions
  set status = 'cancelled', cancelled_at = now()
  where id = p_subscription_id;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'cancel_subscription', 'subscription', p_subscription_id, 'sandbox cancel', 'ok');

  return jsonb_build_object('ok',true,'status','cancelled');
end;
$$;
revoke all on function public.aani_sandbox_cancel_subscription(uuid) from public, anon;
grant execute on function public.aani_sandbox_cancel_subscription(uuid) to authenticated;

-- تجديد اشتراك تجريبي (خصم عملات وتاريخ انتهاء جديد).
-- يقبل p_idempotency_key لمنع توليد مفتاح عشوائي جديد عند كل إعادة محاولة.
create or replace function public.aani_sandbox_renew_subscription(
  p_subscription_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_package_id uuid;
  v_coins integer;
  v_days integer;
  v_balance integer;
  v_status text;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;

  select user_id, package_id into v_user_id, v_package_id from sandbox.subscriptions where id = p_subscription_id;
  if not found then raise exception 'subscription not found' using errcode='42704'; end if;
  if auth.uid() <> v_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden' using errcode='42501';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || v_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:subrenew:' || v_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key) then
    if not exists (select 1 from sandbox.ledger where idempotency_key = p_idempotency_key and user_id = v_user_id and reference = 'sandbox subscription renew' and related_id = p_subscription_id) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    select amount into v_coins from sandbox.ledger where idempotency_key = p_idempotency_key;
    select status into v_status from sandbox.subscriptions where id = p_subscription_id;
    select public.aani_sandbox_balance(v_user_id) into v_balance;
    return jsonb_build_object('ok',true,'duplicate',true,'coins_charged',v_coins,'balance',v_balance,'status',v_status,'subscription_id',p_subscription_id);
  end if;

  select coins_price, duration_days into v_coins, v_days
  from sandbox.subscription_packages where id = v_package_id and is_active = true;
  if not found then raise exception 'package unavailable' using errcode='42704'; end if;

  select public.aani_sandbox_balance(v_user_id) into v_balance;
  if v_balance < v_coins then raise exception 'insufficient sandbox balance' using errcode='42001'; end if;

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (v_user_id, 'debit', v_coins, 'sandbox subscription renew', p_idempotency_key, p_subscription_id);

  update sandbox.subscriptions
  set status = 'active', renewed_at = now(),
      ended_at = now() + (v_days || ' days')::interval
  where id = p_subscription_id;

  select public.aani_sandbox_balance(v_user_id) into v_balance;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'renew_subscription', 'subscription', p_subscription_id, 'sandbox renew', 'ok');

  return jsonb_build_object('ok',true,'coins_charged',v_coins,'balance',v_balance,'status','active');
end;
$$;
revoke all on function public.aani_sandbox_renew_subscription(uuid,text) from public, anon;
grant execute on function public.aani_sandbox_renew_subscription(uuid,text) to authenticated;

-- إنشاء حملة ترويج تجريبية (خصم عملات تجريبية).
-- يتحقق من:
--   * تطابق نوع الحملة مع نوع الباقة (post/post، reel/reel).
--   * ملكية المستخدم للهدف (المنشور في public.posts).
--   * وجود الهدف وصلاحيته.
create or replace function public.aani_sandbox_create_promotion(
  p_user_id uuid,
  p_package_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_coins integer;
  v_days integer;
  v_balance integer;
  v_package_target_type text;
  v_target_owner uuid;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_user_id then raise exception 'forbidden' using errcode='42501'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('sandbox:user:' || p_user_id::text));
  perform pg_advisory_xact_lock(hashtext('sandbox:promo:' || p_user_id::text || ':' || p_idempotency_key));

  if exists (select 1 from sandbox.promotions where idempotency_key = p_idempotency_key) then
    if not exists (select 1 from sandbox.promotions where idempotency_key = p_idempotency_key and user_id = p_user_id and package_id = p_package_id and target_type = p_target_type and target_id = p_target_id) then
      raise exception 'idempotency key conflict' using errcode='40901';
    end if;
    return jsonb_build_object('ok',true,'duplicate',true,'status',(select status from sandbox.promotions where idempotency_key = p_idempotency_key));
  end if;

  select target_type, coins_price, duration_days
  into v_package_target_type, v_coins, v_days
  from sandbox.promotion_packages where id = p_package_id and is_active = true;
  if not found then raise exception 'package unavailable' using errcode='42704'; end if;

  -- تطابق نوع الحملة مع نوع الباقة.
  if p_target_type <> v_package_target_type then
    raise exception 'promotion target type does not match package target type' using errcode='42001';
  end if;

  -- وجود الهدف وملكية المستخدم له (المنشور في public.posts).
  -- الريل غير موجود كجدول منفصل في المخطط الحالي، لذا لا يُطبق عليه FK صلب.
  if p_target_type = 'post' then
    select user_id into v_target_owner from public.posts where id = p_target_id;
    if not found then raise exception 'target post not found' using errcode='42704'; end if;
    if v_target_owner <> p_user_id then
      raise exception 'not the owner of the target post' using errcode='42501';
    end if;
  elsif p_target_type = 'reel' then
    select user_id into v_target_owner from public.posts where id = p_target_id and type = 'reel';
    if not found then raise exception 'target reel not found' using errcode='42704'; end if;
    if v_target_owner <> p_user_id then
      raise exception 'not the owner of the target reel' using errcode='42501';
    end if;
  else
    raise exception 'invalid target type' using errcode='22023';
  end if;

  select public.aani_sandbox_balance(p_user_id) into v_balance;
  if v_balance < v_coins then raise exception 'insufficient sandbox balance' using errcode='42001'; end if;

  insert into sandbox.ledger (user_id, type, amount, reference, idempotency_key, related_id)
  values (p_user_id, 'debit', v_coins, 'sandbox promotion create', p_idempotency_key, null);

  insert into sandbox.promotions (user_id, package_id, target_type, target_id, status, started_at, ends_at, coins_deducted, idempotency_key)
  values (p_user_id, p_package_id, p_target_type, p_target_id, 'active', now(), now() + (v_days || ' days')::interval, v_coins, p_idempotency_key);

  select public.aani_sandbox_balance(p_user_id) into v_balance;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'create_promotion', 'promotion', null, 'sandbox create promotion', 'ok');

  return jsonb_build_object('ok',true,'duplicate',false,'coins_deducted',v_coins,'balance',v_balance,'status','active');
end;
$$;
revoke all on function public.aani_sandbox_create_promotion(uuid,uuid,text,uuid,text) from public, anon;
grant execute on function public.aani_sandbox_create_promotion(uuid,uuid,text,uuid,text) to authenticated;

-- إنهاء / فشل حملة ترويج تجريبية.
create or replace function public.aani_sandbox_end_promotion(
  p_promotion_id uuid,
  p_success boolean default true,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_status text;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;

  select user_id into v_user_id from sandbox.promotions where id = p_promotion_id;
  if not found then raise exception 'promotion not found' using errcode='42704'; end if;
  if auth.uid() <> v_user_id and not public.aani_sandbox_is_founder() then
    raise exception 'forbidden' using errcode='42501';
  end if;

  if p_success then
    v_status := 'ended';
  else
    v_status := 'failed';
  end if;

  update sandbox.promotions
  set status = v_status, ends_at = now(),
      failure_reason = case when p_success then null else p_failure_reason end
  where id = p_promotion_id;

  insert into sandbox.admin_actions (actor_user_id, action, target_type, target_id, reason, result)
  values (auth.uid(), 'end_promotion', 'promotion', p_promotion_id, 'sandbox end promotion', 'ok');

  return jsonb_build_object('ok',true,'status',v_status);
end;
$$;
revoke all on function public.aani_sandbox_end_promotion(uuid,boolean,text) from public, anon;
grant execute on function public.aani_sandbox_end_promotion(uuid,boolean,text) to authenticated;

-- =====================================================================
-- ملاحظة النشر: هذا الترحيل SQL يُطبّق على قاعدة Supabase المستهدفة عبر
-- واجهة إدارة قاعدة البيانات (SQL Editor) أو أداة ترحيل Supabase. لا يُفترض
-- أن schema.sql يطابق القاعدة الحية تمامًا؛ يُنفّذ هذا الملف كمصدر منفصل.
-- =====================================================================
