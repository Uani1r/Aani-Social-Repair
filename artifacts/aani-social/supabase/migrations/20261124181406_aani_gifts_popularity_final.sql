-- =====================================================================
-- هدايا الملف الشخصي ونقاط الشعبية (Gifts & Popularity) — الحالة النهائية.
--
-- يوحّد هذا الملف ترحيلات الهدايا الخمسة السابقة (كانت مؤرخة 2027، أي أرقام
-- مستقبلية ومتكررة/متعارضة) في ترحيل واحد مطابق للترحيل المطبَّق فعلياً على
-- قاعدة Supabase الأساسية:
--     الاسم:  aani_gifts_popularity_final
--     الرقم:  20261124181406
--
-- لذلك لا يُعاد تنفيذه على القاعدة الأساسية (النسخة نفسها مسجّلة مطبَّقة)، ولا
-- يُنشئ خصومات/معاملات مكررة: كل الأوامر idempotent (create ... if not exists /
-- create or replace / drop policy if exists / بذر شرطي).
--
-- المحتوى: الجداول والفهارس، RLS (الكتالوج/المحفظة/قراءة الهدايا حسب الخصوصية
-- والحظر)، ودوال aani_user_popularity و aani_send_gift (بقفل التزامن advisory)
-- و aani_can_read_received_gifts، مع البذر الافتراضي.
-- =====================================================================
begin;

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

-- مفتاح Idempotency لكل عملية إرسال (يمنع الخصم المزدوج عند إعادة المحاولة)
alter table public.gift_transactions
  add column if not exists idempotency_key text;

-- فهارس لاستعلام هدايا المستخدم ومحفظة الرصيد
create index if not exists gift_transactions_recipient_idx
  on public.gift_transactions (recipient_id, created_at desc);
create index if not exists gift_transactions_sender_idx
  on public.gift_transactions (sender_id, created_at desc);
create index if not exists gift_transactions_gift_idx
  on public.gift_transactions (gift_id);
create index if not exists user_wallets_user_idx on public.user_wallets (user_id);
create index if not exists gifts_active_idx on public.gifts (is_active);

-- فهرس فريد مركّب على (sender_id, idempotency_key) لكل صف غير فارغ.
create unique index if not exists gift_transactions_sender_idempotency_uidx
  on public.gift_transactions (sender_id, idempotency_key)
  where idempotency_key is not null;

alter table public.gifts enable row level security;
alter table public.user_wallets enable row level security;
alter table public.gift_transactions enable row level security;

-- كتالوج الهدايا: متاح للقراءة لكل مستخدم مسجّل (بيانات عامة غير حساسة).
drop policy if exists aani_gifts_select on public.gifts;
create policy aani_gifts_select on public.gifts
  for select to authenticated using (true);

-- المحفظة: يقرأ المستخدم رصيده فقط.
drop policy if exists aani_user_wallets_select_own on public.user_wallets;
create policy aani_user_wallets_select_own on public.user_wallets
  for select to authenticated using (auth.uid() = user_id);

-- لا يُسمح للمستخدمين بتعديل كتالوج الهدايا أو رصيدهم أو سجل المعاملات مباشرة.
-- الكتابة تتم عبر دوال RPC موثقة أدناه (security definer) ضمن معاملات واحدة.
grant select on public.gifts to authenticated;
grant select on public.user_wallets to authenticated;
grant select on public.gift_transactions to authenticated;

-- =====================================================================
-- دوال RPC آمنة
-- =====================================================================

-- إجمالي Popularity لمستخدم = مجموع نقاط الشعبية من الهدايا المستلمة.
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

-- إرسال هدية: التحقق من الرصيد والصلاحية والخصم ضمن معاملة واحدة، مع مفتاح
-- Idempotency وقفل صف المحفظة (for update) وقفل advisory لكل (sender, key)
-- لمنع الخصم المزدوج والإرسال المتزامن المكرر.
create or replace function public.aani_send_gift(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_gift_id uuid,
  p_idempotency_key text default null
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
  if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if;
  if auth.uid() <> p_sender_id then raise exception 'forbidden' using errcode='42501'; end if;
  if p_sender_id = p_recipient_id then raise exception 'self' using errcode='22023'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key required' using errcode='22023';
  end if;

  -- advisory lock per (sender, key)
  perform pg_advisory_xact_lock(hashtext(p_sender_id::text || ':' || p_idempotency_key));

  select * into v_existing from public.gift_transactions
  where sender_id = p_sender_id and idempotency_key = p_idempotency_key
  limit 1;
  if found then
    return jsonb_build_object('ok',true,'duplicate',true,'transaction_id',v_existing.id,'price_paid',v_existing.price_paid,'popularity_points',v_existing.popularity_points);
  end if;

  select price, popularity_points into v_price, v_points from public.gifts where id=p_gift_id and is_active=true;
  if not found then raise exception 'gift unavailable' using errcode='42704'; end if;

  insert into public.user_wallets (user_id,balance,updated_at) values (p_sender_id,0,now()) on conflict (user_id) do nothing;
  select balance into v_balance from public.user_wallets where user_id=p_sender_id for update;
  if v_balance < v_price then raise exception 'insufficient balance' using errcode='42001'; end if;

  update public.user_wallets set balance=balance-v_price, updated_at=now() where user_id=p_sender_id;

  insert into public.gift_transactions (gift_id,sender_id,recipient_id,price_paid,popularity_points,created_at,idempotency_key)
  values (p_gift_id,p_sender_id,p_recipient_id,v_price,v_points,now(),p_idempotency_key)
  returning * into v_tx;

  begin
    insert into public.notifications (user_id,actor_id,type,content,reference_id,created_at)
    values (p_recipient_id,p_sender_id,'gift','تلقيت هديةً جديدة.',v_tx.id,now());
  exception when others then
    raise warning 'gift notification failed: %', SQLERRM;
  end;

  return jsonb_build_object('ok',true,'duplicate',false,'transaction_id',v_tx.id,'balance',v_balance-v_price,'price_paid',v_price,'popularity_points',v_points);
end;
$$;
revoke all on function public.aani_send_gift(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.aani_send_gift(uuid,uuid,uuid,text) to authenticated;

-- =====================================================================
-- سياسة قراءة الهدايا المستلمة لزائر الملف (الخصوصية + الحظر)
-- =====================================================================

-- دالة مساعدة: هل يجوز للمشاهد (p_viewer_id) قراءة الهدايا المستلمة من
-- المستلم (p_recipient_id)؟ الخصوصية فقط؛ الحظر في حارس منفصل أدناه.
create or replace function public.aani_can_read_received_gifts(
  p_recipient_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as owner
    where owner.id = p_recipient_id
      and (
        (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and p_recipient_id = p_viewer_id
        )
        or (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = p_recipient_id
            )
          )
        )
      )
  );
$$;
revoke all on function public.aani_can_read_received_gifts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.aani_can_read_received_gifts(uuid, uuid) to authenticated;

drop policy if exists aani_gift_transactions_select_received on public.gift_transactions;
create policy aani_gift_transactions_select_received on public.gift_transactions
  for select to authenticated
  using (public.aani_can_read_received_gifts(recipient_id, (select auth.uid())));

-- حارس الحظر (restrictive) يُنشأ فقط عند وجود aani_is_user_blocked (الإنتاج).
do $$
begin
  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_is_user_blocked'
  ) then
    raise warning
      'الدالة aani_is_user_blocked غائبة: تم تخطي حارس الحظر على gift_transactions.';
    return;
  end if;

  execute 'drop policy if exists aani_gift_transactions_block_guard on public.gift_transactions';
  execute $policy$
    create policy aani_gift_transactions_block_guard on public.gift_transactions
      as restrictive for select to authenticated
      using (not public.aani_is_user_blocked((select auth.uid()), recipient_id))
  $policy$;
end $$;

-- بذر كتالوج الهدايا الافتراضي (idempotent)
insert into public.gifts (name, price, popularity_points, image_url, is_active)
select * from (values
  ('وردة', 5, 1, null, true),
  ('قلب', 10, 2, null, true),
  ('تاج', 25, 5, null, true),
  ('جوهرة', 50, 12, null, true),
  ('تاج ذهبي', 100, 30, null, true)
) as v(name, price, popularity_points, image_url, is_active)
where not exists (select 1 from public.gifts g where g.name = v.name);

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
commit;
