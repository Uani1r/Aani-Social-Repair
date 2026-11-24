-- =====================================================================
-- هدايا الملف الشخصي ونقاط الشعبية (Gifts & Popularity)
-- آمن للإعادة التشغيل (idempotent): يُنشئ الجداول الناقصة فقط ولا يحذف
-- أي بيانات موجودة. لا يُعدّل جداول أو سياسات قائمة.
-- =====================================================================

-- كتالوج الهدايا المتاحة للإرسال (تُدار عبر الخادم فقط)
create table if not exists public.gifts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price integer not null default 0 check (price >= 0),
  popularity_points integer not null default 0 check (popularity_points >= 0),
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- رصيد العملات لكل مستخدم (يُحدّث فقط عبر دوال RPC آمنة)
create table if not exists public.user_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- سجل إرسال واستلام الهدايا: يربط المرسل والمستلم والهدية
create table if not exists public.gift_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_id uuid not null references public.gifts (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  price_paid integer not null check (price_paid >= 0),
  popularity_points integer not null check (popularity_points >= 0),
  created_at timestamptz not null default now(),
  constraint gift_transactions_not_self check (sender_id <> recipient_id)
);

-- فهارس لاستعلام هدايا المستخدم ومحفظة الرصيد
create index if not exists gift_transactions_recipient_idx
  on public.gift_transactions (recipient_id, created_at desc);
create index if not exists gift_transactions_sender_idx
  on public.gift_transactions (sender_id, created_at desc);
create index if not exists gift_transactions_gift_idx
  on public.gift_transactions (gift_id);
create index if not exists user_wallets_user_idx on public.user_wallets (user_id);
create index if not exists gifts_active_idx on public.gifts (is_active);

alter table public.gifts enable row level security;
alter table public.user_wallets enable row level security;
alter table public.gift_transactions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gifts' and policyname = 'aani_gifts_select') then
    create policy aani_gifts_select on public.gifts
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_wallets' and policyname = 'aani_user_wallets_select_own') then
    create policy aani_user_wallets_select_own on public.user_wallets
      for select to authenticated using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gift_transactions' and policyname = 'aani_gift_transactions_select_own') then
    create policy aani_gift_transactions_select_own on public.gift_transactions
      for select to authenticated
      using (auth.uid() = sender_id or auth.uid() = recipient_id);
  end if;
end $$;

-- لا يُسمح للمستخدمين بتعديل كتالوج الهدايا أو رصيدهم أو سجل المعاملات مباشرة.
-- الكتابة تتم عبر دوال RPC موثقة أدناه (security definer) ضمن معاملات واحدة.
grant select on public.gifts to authenticated;
grant select on public.user_wallets to authenticated;
grant select on public.gift_transactions to authenticated;

-- =====================================================================
-- دوال RPC آمنة
-- =====================================================================

-- إجمالي Popularity لمستخدم = مجموع نقاط الشعبية من الهدايا المستلمة.
-- بيانات عامة تُعرض على بطاقة الملف الشخصي عبر استعلام خفيف.
create or replace function public.aani_user_popularity(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(gt.popularity_points), 0)::integer
  from public.gift_transactions gt
  where gt.recipient_id = p_user_id;
$$;
revoke all on function public.aani_user_popularity(uuid) from public, anon;
grant execute on function public.aani_user_popularity(uuid) to authenticated;

-- إرسال هدية من المرسل إلى المستلم مقابل خصم رصيد المرسل.
-- جميع التحريات والخصم والإيداع تُنفّذ في معاملة واحدة مع قفل صف المحفظة
-- لمنع الخصم المزدوج والإرسال المكرر في حال الطلبات المتزامنة.
create or replace function public.aani_send_gift(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_gift_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_price integer;
  v_points integer;
  v_balance integer;
  v_existing public.gift_transactions%rowtype;
  v_tx public.gift_transactions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'التسجيل مطلوب لإرسال هدية' using errcode = '42501';
  end if;

  if auth.uid() <> p_sender_id then
    raise exception 'لا يمكن إرسال هدية نيابة عن مستخدم آخر' using errcode = '42501';
  end if;

  if p_sender_id = p_recipient_id then
    raise exception 'لا يمكن إرسال هدية إلى نفسك' using errcode = '22023';
  end if;

  select price, popularity_points into v_price, v_points
  from public.gifts
  where id = p_gift_id and is_active = true;

  if not found then
    raise exception 'الهدية غير متاحة حالياً' using errcode = '42704';
  end if;

  -- ضمان وجود صف محفظة للمرسل ثم قفله لهذه المعاملة (منع سباق الرصيد)
  insert into public.user_wallets (user_id, balance, updated_at)
  values (p_sender_id, 0, now())
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.user_wallets
  where user_id = p_sender_id
  for update;

  if v_balance < v_price then
    raise exception 'رصيدك غير كافٍ لإرسال هذه الهدية.' using errcode = '42001';
  end if;

  -- منع الإرسال المكرر: هدية متشابهة (نفس المرسل والمستلم والهدية) durante آخر 10 دقائق
  select * into v_existing
  from public.gift_transactions
  where sender_id = p_sender_id
    and recipient_id = p_recipient_id
    and gift_id = p_gift_id
    and created_at > now() - interval '10 minutes'
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'transaction_id', v_existing.id,
      'balance', v_balance,
      'price_paid', v_existing.price_paid,
      'popularity_points', v_existing.popularity_points
    );
  end if;

  update public.user_wallets
  set balance = balance - v_price, updated_at = now()
  where user_id = p_sender_id;

  insert into public.gift_transactions (
    gift_id, sender_id, recipient_id, price_paid, popularity_points, created_at
  )
  values (p_gift_id, p_sender_id, p_recipient_id, v_price, v_points, now())
  returning * into v_tx;

  -- إشعار للمستلم (لا يفشل الإرسال في حال تعذر الإشعارات لأسباب عرضية محصورة)
  begin
    insert into public.notifications (user_id, actor_id, type, content, reference_id, created_at)
    values (
      p_recipient_id, p_sender_id, 'gift',
      'تلقيت هديةً جديدة.',
      v_tx.id,
      now()
    );
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'transaction_id', v_tx.id,
    'balance', v_balance - v_price,
    'price_paid', v_price,
    'popularity_points', v_points
  );
end;
$$;
revoke all on function public.aani_send_gift(uuid, uuid, uuid) from public, anon;
grant execute on function public.aani_send_gift(uuid, uuid, uuid) to authenticated;

-- تنبيه realtime: بث المعاملات الجديدة لتحديث العدادات مباشرة عند التوفر
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'gift_transactions'
     ) then
    execute 'alter publication supabase_realtime add table public.gift_transactions';
  end if;
end $$;

alter table public.gift_transactions replica identity full;
