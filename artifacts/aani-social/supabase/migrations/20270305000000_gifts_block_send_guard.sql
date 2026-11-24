-- =====================================================================
-- ترحيل مستقل جديد: منع إرسال الهدية إلى مستخدم محظور.
--
-- السياق:
--   الترحيل 20261124181406_aani_gifts_popularity_final مطبَّق مسبقاً على
--   إنتاج Supabase قبل إضافة منع الحظر. لذلك لا يكفي تعديل ذلك الملف القديم
--   (لن يُعاد تنفيذه). هذا الترحيل الجديد يستبدل دالة aani_send_gift فقط
--   ليضيف فحص الحظر، مع الحفاظ الكامل على:
--     * التحقق من الهوية (auth.uid) ومنع الإرسال للنفس.
--     * التحقق من المفتاح (idempotency) ومنع التكرار.
--     * قفل advisory لكل (sender, key) + قفل صف المحفظة (for update).
--     * خصم الرصيد ضمن معاملة واحدة، والإشعار الاختياري.
--
-- لا يُنشئ جداول، ولا يبذر هدايا، ولا يعيد تطبيق الترحيل القديم. آمن للتكرار
-- (create or replace). لا يغيّر أي بيانات.
-- =====================================================================
begin;

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

  -- منع إرسال هدية جديدة إلى مستخدم محظور (إن وجدت دالة الحظر).
  -- يوضع بعد فحص idempotency/المعاملة السابقة، فتظل إعادة المحاولة بنفس المفتاح
  -- تعيد المعاملة السابقة (duplicate) حتى لو حدث حظر لاحقاً، ويُمنع الحظر كل
  -- إرسال جديد قبل الخصم وإنشاء المعاملة.
  if to_regprocedure('public.aani_is_user_blocked(uuid,uuid)') is not null
     and public.aani_is_user_blocked(p_sender_id, p_recipient_id) then
    raise exception 'blocked' using errcode='42501';
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

commit;