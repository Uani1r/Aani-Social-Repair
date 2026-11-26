#!/usr/bin/env bash
# =====================================================================
# اختبار تزامن حقيقي لـ Sandbox المالي — جلستان متزامنتان (ليست تتابعية).
#
# السيناريو: مفتاح idempotency واحد ('race-concurrent-key') يُستخدم بالتزامن
# من عمليتين مختلفتين على نفس المستخدم:
#   - الجلسة A: grant_coins(userA, ...) كـ founder
#   - الجلسة B: top_up(userA, ...)    كـ userA
#
# الإثبات:
#   1) حاجز تزامن حقيقي (rendezvous): كل جلسة تسجّل وصولها في جدول حاجز
#      وتنتظر حتى تصل الجلسة الثانية (n>=2) قبل نداء الدالة المالية. هذا يضمن
#      أن الجلستين كانتا حيتين ومتزامنتين فعلاً عند لحظة التسابق — لا تتابعاً.
#   2) الأقفال الاستشارية (pg_advisory_xact_lock على المفتاح) تُسلسل العمليتين،
#      فينجح أحدهما فقط ويُرفض الآخر بـ SQLSTATE 40901 (نتحقق منه صراحةً).
#   3) فائز واحد فقط عبر جدولي ledger/top_ups، ولا قيد مالي مكرر.
#
# المتطلبات: psql، ومتغير DATABASE_URL باتصال إداري (مالك الجداول).
# لا يُطبَّق على الإنتاج — قاعدة اختبار محلية مؤقتة فقط.
# =====================================================================
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (admin connection to the test DB)}"

USER_A='00000000-0000-0000-0000-0000000000a1'
FOUNDER='00000000-0000-0000-0000-0000000000a4'
PACKAGE='00000000-0000-0000-0000-0000000000c1'
RACE_KEY='race-concurrent-key'
BARRIER_TABLE='public._sandbox_race_barrier'

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "== [concurrency] cleaning any prior race rows and barrier =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from sandbox.ledger where idempotency_key in ('$RACE_KEY','$RACE_KEY:credit');
   delete from sandbox.top_ups where idempotency_key = '$RACE_KEY';
   drop table if exists $BARRIER_TABLE;
   create table $BARRIER_TABLE (k text primary key, n integer not null default 0);"

# كل خطوة = معاملة مستقلة (psql -c واحدة = معاملة واحدة) لتجنّب قفل الصف عبر
# الجلسات. الحاجز: سجّل الوصول ثم انتظر وصول الثانية (n>=2) قبل النداء المالي.
barrier_arrive() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "insert into $BARRIER_TABLE(k,n) values ('race',1)
       on conflict (k) do update set n = $BARRIER_TABLE.n + 1;"
}
barrier_wait() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "do \$\$
     declare v integer; i integer := 0;
     begin
       loop
         select n into v from $BARRIER_TABLE where k = 'race';
         exit when v >= 2;
         perform pg_sleep(0.02);
         i := i + 1;
         if i > 250 then
           raise exception 'barrier timeout: second session never arrived (n=%)', v;
         end if;
       end loop;
     end \$\$;"
}

# الجلسة A: founder يمنح عملات بالمفتاح المشترك (VERBOSITY sqlstate لإظهار 40901).
SESSION_A_SQL="\\set VERBOSITY sqlstate
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$FOUNDER\"}', true);
SELECT public.aani_sandbox_grant_coins('$USER_A', 100, '$RACE_KEY', 'race grant');"

# الجلسة B: userA يشحن بالمفتاح نفسه.
SESSION_B_SQL="\\set VERBOSITY sqlstate
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
SELECT public.aani_sandbox_top_up('$USER_A', '$PACKAGE', '$RACE_KEY', true);"

run_session() {
  local sql="$1" out="$2"
  barrier_arrive
  barrier_wait
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c "$sql" >"$out" 2>&1
}

echo "== [concurrency] launching two concurrent sessions (rendezvous barrier) =="
run_session "$SESSION_A_SQL" "$OUT_DIR/a.out" &
PID_A=$!
run_session "$SESSION_B_SQL" "$OUT_DIR/b.out" &
PID_B=$!

RC_A=0; RC_B=0
wait "$PID_A" || RC_A=$?
wait "$PID_B" || RC_B=$?

echo "----- session A output -----"; cat "$OUT_DIR/a.out"
echo "----- session B output -----"; cat "$OUT_DIR/b.out"

# التصنيف: نجاح (يحتوي ok:true) أو تعارض صريح بـ SQLSTATE 40901.
classify() {
  local f="$1"
  if grep -qE '(^|[^0-9])40901([^0-9]|$)' "$f"; then
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
  echo "PASS: grant won, top_up rejected with SQLSTATE 40901"
elif [ "$CB" = "success" ] && [ "$CA" = "conflict" ]; then
  echo "PASS: top_up won, grant rejected with SQLSTATE 40901"
else
  echo "FAIL: expected exactly one success and one SQLSTATE 40901 conflict (A=$CA B=$CB)"
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

# تنظيف جدول الحاجز (تنظيف فقط؛ لا يؤثر على نتيجة الاختبار).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table if exists $BARRIER_TABLE;"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "== [concurrency] PASS =="