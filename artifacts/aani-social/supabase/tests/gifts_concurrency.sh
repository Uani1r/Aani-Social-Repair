#!/usr/bin/env bash
# =====================================================================
# اختبار تزامن حقيقي: جلستان متزامنتان بنفس idempotency key.
# يتحقق من خصم واحد ومعاملة واحدة فقط.
#
# الاستخدام:
#   supabase/tests/gifts_concurrency.sh <database_url>
# أو:
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... \
#     supabase/tests/gifts_concurrency.sh
# (إن لم يُمرَّر وسيط، يُستخدم اتصال البيئة الافتراضي.)
# =====================================================================
set -euo pipefail

DB_URL="${1:-}"
PSQL=(psql)
if [ -n "$DB_URL" ]; then PSQL+=( "$DB_URL" ); fi
PSQL+=( -v ON_ERROR_STOP=1 -q )

SENDER='11111111-1111-1111-1111-111111111111'
RECIPIENT='22222222-2222-2222-2222-222222222222'
GIFT='55555555-5555-5555-5555-555555555555'
KEY="concurrent-key-$$"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "== reset =="
"${PSQL[@]}" <<SQL
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('$SENDER', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c_sender@test.local', '', now(), now(), now()),
  ('$RECIPIENT', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c_recipient@test.local', '', now(), now(), now())
on conflict (id) do nothing;
insert into public.profiles (id, username, is_private) values
  ('$SENDER', 'c_sender', false),
  ('$RECIPIENT', 'c_recipient', false)
on conflict (id) do nothing;
insert into public.gifts (id, name, price, popularity_points, is_active) values
  ('$GIFT', 'TEST_GIFT', 10, 2, true)
on conflict (id) do nothing;
insert into public.user_wallets (user_id, balance) values ('$SENDER', 100)
  on conflict (user_id) do update set balance = 100;
delete from public.gift_transactions where idempotency_key = '$KEY';
SQL

echo "== two concurrent sends (same key) =="
send_once() {
  "${PSQL[@]}" -c "set request.jwt.claims = '{\"sub\":\"$SENDER\"}'; select public.aani_send_gift('$SENDER','$RECIPIENT','$GIFT','$KEY');" \
    >"$OUT_DIR/conc_$1.out" 2>&1
}
send_once a &
PID_A=$!
send_once b &
PID_B=$!
wait "$PID_A"
wait "$PID_B"

echo "---- session A ----"; cat "$OUT_DIR/conc_a.out"
echo "---- session B ----"; cat "$OUT_DIR/conc_b.out"

echo "== verify =="
BAL=$("${PSQL[@]}" -tAc "select balance from public.user_wallets where user_id = '$SENDER';")
CNT=$("${PSQL[@]}" -tAc "select count(*) from public.gift_transactions where sender_id = '$SENDER' and idempotency_key = '$KEY';")
echo "balance=$BAL count=$CNT"

if [ "$BAL" != "90" ]; then echo "FAIL: expected balance 90, got $BAL"; exit 1; fi
if [ "$CNT" != "1" ]; then echo "FAIL: expected 1 transaction, got $CNT"; exit 1; fi
echo "PASS: concurrent same-key send debited once and created one transaction"