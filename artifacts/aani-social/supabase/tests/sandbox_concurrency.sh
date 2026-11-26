#!/usr/bin/env bash
# =====================================================================
# اختبار تزامن حقيقي لـ Sandbox المالي — جلستان متزامنتان (ليست تتابعية).
#
# السيناريو: مفتاح idempotency واحد ('race-concurrent-key') يُستخدم بالتزامن
# من عمليتين مختلفتين على نفس المستخدم:
#   - الجلسة A: grant_coins(userA, ...) كـ founder
#   - الجلسة B: top_up(userA, ...)    كـ userA
# الأقفال الاستشارية (pg_advisory_xact_lock على المفتاح) تُسلسل العمليتين،
# فينجح أحدهما فقط ويُرفض الآخر بـ SQLSTATE 40901.
#
# المتطلبات: psql، ومتغير DATABASE_URL باتصال إداري (مالك الجداول).
# لا يُطبَّق على الإنتاج — قاعدة اختبار مؤقتة فقط.
# =====================================================================
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (admin connection to the test DB)}"

USER_A='00000000-0000-0000-0000-0000000000a1'
FOUNDER='00000000-0000-0000-0000-0000000000a4'
PACKAGE='00000000-0000-0000-0000-0000000000c1'
RACE_KEY='race-concurrent-key'

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "== [concurrency] cleaning any prior race rows =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from sandbox.ledger where idempotency_key in ('$RACE_KEY','$RACE_KEY:credit');
   delete from sandbox.top_ups where idempotency_key = '$RACE_KEY';"

# الجلسة A: founder يمنح عملات بالمفتاح المشترك.
SESSION_A_SQL="SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$FOUNDER\"}', true);
SELECT public.aani_sandbox_grant_coins('$USER_A', 100, '$RACE_KEY', 'race grant');"

# الجلسة B: userA يشحن بالمفتاح نفسه.
SESSION_B_SQL="SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SELECT public.aani_sandbox_top_up('$USER_A', '$PACKAGE', '$RACE_KEY', true);"

echo "== [concurrency] launching two concurrent sessions =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c "$SESSION_A_SQL" >"$OUT_DIR/a.out" 2>&1 &
PID_A=$!
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c "$SESSION_B_SQL" >"$OUT_DIR/b.out" 2>&1 &
PID_B=$!

RC_A=0; RC_B=0
wait "$PID_A" || RC_A=$?
wait "$PID_B" || RC_B=$?

echo "----- session A output -----"; cat "$OUT_DIR/a.out"
echo "----- session B output -----"; cat "$OUT_DIR/b.out"

# التصنيف: نجاح (يحتوي ok:true) أو تعارض 40901.
classify() {
  local f="$1"
  if grep -q 'SQLSTATE: 40901' "$f" || grep -qi 'idempotency key conflict' "$f"; then
    echo "conflict"
  elif grep -q '"ok": true' "$f" || grep -q '"ok":true' "$f"; then
    echo "success"
  else
    echo "error"
  fi
}

CA="$(classify "$OUT_DIR/a.out")"
CB="$(classify "$OUT_DIR/b.out")"

echo "== [concurrency] A=$CA B=$CB =="

FAIL=0
if [ "$CA" = "success" ] && [ "$CB" = "conflict" ]; then
  echo "PASS: grant won, top_up rejected with 40901"
elif [ "$CB" = "success" ] && [ "$CA" = "conflict" ]; then
  echo "PASS: top_up won, grant rejected with 40901"
else
  echo "FAIL: expected exactly one success and one 40901 conflict (A=$CA B=$CB)"
  FAIL=1
fi

# التحقق النهائي: فائز واحد فقط عبر الجدولين (لا ازدواج ولا تعارض متروك).
WINNERS=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
  "select
     (select count(*) from sandbox.ledger where idempotency_key = '$RACE_KEY')
   + (select count(*) from sandbox.top_ups where idempotency_key = '$RACE_KEY');")
echo "== [concurrency] winner rows (ledger RACE_KEY + top_ups RACE_KEY) = $WINNERS =="
if [ "$WINNERS" != "1" ]; then
  echo "FAIL: expected exactly 1 winner row across ledger/top_ups, got $WINNERS"
  FAIL=1
fi

# تأكد من عدم وجود قيد credit مكرر (الازدواج الحقيقي).
CREDIT_COUNT=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
  "select count(*) from sandbox.ledger where idempotency_key = '$RACE_KEY:credit';")
echo "== [concurrency] credit rows for race key = $CREDIT_COUNT =="
if [ "$CREDIT_COUNT" -gt 1 ]; then
  echo "FAIL: expected at most 1 credit row, got $CREDIT_COUNT"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "== [concurrency] PASS =="