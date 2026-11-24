-- Drop bad policy
drop policy if exists aani_gift_transactions_select_received on public.gift_transactions;

-- Composite unique idempotency
alter table public.gift_transactions drop constraint if exists gift_transactions_idempotency_key_uidx;
drop index if exists public.gift_transactions_idempotency_key_uidx;
create unique index if not exists gift_transactions_sender_idempotency_uidx
  on public.gift_transactions (sender_id, idempotency_key)
  where idempotency_key is not null;

-- RLS: only recipient's gifts visible; sender private hidden. Use profile visibility via simple policy: recipient can see own received; (visibility/privacy handled app-level/blocking not in RLS here)
create policy aani_gift_transactions_select_received on public.gift_transactions
  for select to authenticated
  using (recipient_id = auth.uid() or sender_id = auth.uid());

-- Remove old 3-param overload if exists
drop function if exists public.aani_send_gift(uuid, uuid, uuid);

-- Recreate function with concurrent handling
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

  if p_idempotency_key is not null then
    select * into v_existing from public.gift_transactions
    where sender_id = p_sender_id and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return jsonb_build_object('ok',true,'duplicate',true,'transaction_id',v_existing.id,'price_paid',v_existing.price_paid,'popularity_points',v_existing.popularity_points);
    end if;
  end if;

  select price, popularity_points into v_price, v_points from public.gifts where id=p_gift_id and is_active=true;
  if not found then raise exception 'gift unavailable' using errcode='42704'; end if;

  insert into public.user_wallets (user_id,balance,updated_at) values (p_sender_id,0,now()) on conflict (user_id) do nothing;

  select balance into v_balance from public.user_wallets where user_id=p_sender_id for update;
  if v_balance < v_price then raise exception 'insufficient balance' using errcode='42001'; end if;

  update public.user_wallets set balance=balance-v_price, updated_at=now() where user_id=p_sender_id;

  begin
    insert into public.gift_transactions (gift_id,sender_id,recipient_id,price_paid,popularity_points,created_at,idempotency_key)
    values (p_gift_id,p_sender_id,p_recipient_id,v_price,v_points,now(),p_idempotency_key)
    returning * into v_tx;
  exception when unique_violation then
    select * into v_existing from public.gift_transactions where sender_id=p_sender_id and idempotency_key=p_idempotency_key limit 1;
    return jsonb_build_object('ok',true,'duplicate',true,'transaction_id',v_existing.id,'price_paid',v_existing.price_paid,'popularity_points',v_existing.popularity_points);
  end;

  begin
    insert into public.notifications (user_id,actor_id,type,content,reference_id,created_at)
    values (p_recipient_id,p_sender_id,'gift','تلقيت هديةً جديدة.',v_tx.id,now());
  exception when others then null;
  end;

  return jsonb_build_object('ok',true,'duplicate',false,'transaction_id',v_tx.id,'balance',v_balance-v_price,'price_paid',v_price,'popularity_points',v_points);
end;
$$;
revoke all on function public.aani_send_gift(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.aani_send_gift(uuid,uuid,uuid,text) to authenticated;
