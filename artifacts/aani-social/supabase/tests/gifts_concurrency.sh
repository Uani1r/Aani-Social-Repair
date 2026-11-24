#!/usr/bin/env bash
# =====================================================================
# اختبار تزامن حقيقي: جلستان متزامنتان بنفس idempotency key.
#
# آلية الحاجز (barrier): جدول weights_test_barrier — كل جلسة تُدرج صفها
# (committed) ثم تنتظر حتى يصبح عدد الصفوف = 2، فتبدأ الجلستان الإرسال في
# اللحظة نفسها تقريباً وتتداخلان فعلياً داخل الدالة (قفل advisory لكل
# sender+key يضمن التسلسل: واحدة تنشئ المعاملة والأخرى تنتظر ثم تعيد duplicate).
#
# يتحقق (ويفشل عند أي إخلال):
#   * واحدة فقط duplicate=false، والأخرى duplicate=true.
#   * الرصيد = 90 (خصم واحد).
#   * عدد المعاملات = 1.
#
# الاستخدام:
#   supabase/tests/gifts_concurrency.sh <database_url>
# أو عبر متغيرات PG* (PGDATABASE=...).
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
create table if not exists public.gifts_test_barrier (id text primary key);
delete from public.gifts_test_barrier;
SQL

wait_for_barrier() {
  local i n
  for i in $(seq 1 250); do
    n="$("${PSQL[@]}" -tAc "select count(*) from public.gifts_test_barrier;")"
    if [ "$n" = "2" ]; then return 0; fi
    sleep 0.02
  done
  echo "FAIL: barrier timeout (count=$n)"; return 1
}

session() {
  local id="$1"
  "${PSQL[@]}" -c "insert into public.gifts_test_barrier (id) values ('$id') on conflict do nothing;" >/dev/null
  wait_for_barrier || return 1
  "${PSQL[@]}" -c "set request.jwt.claims = '{\"sub\":\"$SENDER\"}'; select public.aani_send_gift('$SENDER','$RECIPIENT','$GIFT','$KEY');" \
    >"$OUT_DIR/conc_$id.out" 2>&1
}

echo "== two concurrent sends (barrier-synchronized, same key) =="
session a & PID_A=$!
session b & PID_B=$!
RC=0
wait "$PID_A" || RC=1
wait "$PID_B" || RC=1
if [ "$RC" != "0" ]; then echo "FAIL: a session errored"; cat "$OUT_DIR"/conc_*.out; exit 1; fi

echo "---- session A ----"; cat "$OUT_DIR/conc_a.out"
echo "---- session B ----"; cat "$OUT_DIR/conc_b.out"

echo "== verify =="
BAL="$("${PSQL[@]}" -tAc "select balance from public.user_wallets where user_id = '$SENDER';")"
CNT="$("${PSQL[@]}" -tAc "select count(*) from public.gift_transactions where sender_id = '$SENDER' and idempotency_key = '$KEY';")"
DUP_FALSE=$(grep -c '"duplicate": false' "$OUT_DIR"/conc_a.out "$OUT_DIR"/conc_b.out | awk -F: '{s+=$2} END{print s+0}')
DUP_TRUE=$(grep -c '"duplicate": true' "$OUT_DIR"/conc_a.out "$OUT_DIR"/conc_b.out | awk -F: '{s+=$2} END{print s+0}')
echo "balance=$BAL count=$CNT duplicate_false=$DUP_FALSE duplicate_true=$DUP_TRUE"

FAIL=0
[ "$BAL" = "90" ] || { echo "FAIL: expected balance 90, got $BAL"; FAIL=1; }
[ "$CNT" = "1" ]  || { echo "FAIL: expected 1 transaction, got $CNT"; FAIL=1; }
[ "$DUP_FALSE" = "1" ] || { echo "FAIL: expected exactly one non-duplicate, got $DUP_FALSE"; FAIL=1; }
[ "$DUP_TRUE" = "1" ]  || { echo "FAIL: expected exactly one duplicate, got $DUP_TRUE"; FAIL=1; }
if [ "$FAIL" != "0" ]; then exit 1; fi
echo "PASS: concurrent same-key send -> one transaction, one duplicate, balance 90"