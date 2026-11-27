#!/usr/bin/env bash
# =====================================================================
# اختبار تزامن حقيقي لـ Sandbox المالي — جلستان متزامنتان (ليست تتابعية).
#
# السيناريو: مفتاح idempotency واحد ('race-concurrent-key') يُستخدم بالتزامن
# من عمليتين مختلفتين على نفس المستخدم (USER_A):
#   - الجلسة A: grant_coins(userA, ...) كـ founder
#   - الجلسة B: top_up(userA, ...)    كـ userA
#
# تتحقق الدالتان الماليتان من القفل الاستشاري نفسه أولاً:
#   pg_advisory_xact_lock(hashtext('sandbox:user:' || user_id))
# ثم قفل idempotency على المفتاح. كلتاهما تعمل على USER_A، لذا تتنافسان
# أولاً على قفل المستخدم المشترك (sandbox:user:USER_A).
#
# الإثبات (هذا هو جوهر الاختبار — لا نكتفي بالفائز الواحد):
#   1) جلسة ثالثة (holder) تفتح معاملة وتأخذ القفل الاستشاري نفسه
#      (sandbox:user:USER_A) وتحتفظ به حتى تُؤمر بالإفراج (flag release).
#   2) نُطلق A وB، فيحاول كل منهما أخذ القفل نفسه ويُحجب فعلياً.
#      نتحقق عبر pg_stat_activity + pg_locks أن كليهما في حالة انتظار
#      (wait_event_type='Lock' وقفل advisory غير ممنوح على نفس المفتاح) قبل
#      الإفراج عن القفل. هذا يثبت أنهما انتظرتا القفل المالي المشترك فعلاً.
#   3) بعد الإفراج، يتنافسان: ينجح أحدهما فقط ويُرفض الآخر بـ SQLSTATE 40901
#      (نتحقق منه صراحةً)، مع فائز واحد فقط عبر ledger/top_ups ولا قيد مكرر.
#
# المهلات والتنظيف:
#   - كل جلسة/holder لها statement_timeout، وحاجز الانتظار له حد أقصى.
#   - trap على EXIT يُنهي أي backend متبقٍّ (يحرّر القفل) ويحذف جدول التحكم.
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
CTRL_TABLE='public._sandbox_race_ctrl'

# مفتاح القفل الاستشاري المشترك الذي تستخدمه الدوال المالية (قفل المستخدم).
LOCK_EXPR="hashtext('sandbox:user:' || '$USER_A')"
# pg_advisory_xact_lock(bigint) يخزّن: classid = النصف الأعلى 32 بت، objid = النصف
# الأدنى 32 بت، objsubid = 1. hashtext يُرجع int4 موقّعاً ويُوسَّع إلى bigint،
# لذا نحسب classid/objid من المفتاح 64-بت مباشرةً (يعمل مع القيم السالبة).
LOCK_KEY="(($LOCK_EXPR)::bigint)"
LOCK_MATCH="l.locktype='advisory' and l.objsubid=1 and l.classid = (($LOCK_KEY >> 32) & 4294967295)::oid and l.objid = ($LOCK_KEY & 4294967295)::oid"

OUT_DIR="$(mktemp -d)"
HOLD_PID=''; PID_A=''; PID_B=''

cleanup() {
  set +e
  # إنهاء أي backend متبقٍّ أولاً (يحرّر القفل الاستشاري لو كان محتجزاً).
  psql "$DATABASE_URL" -q -c \
    "select pg_terminate_backend(pid) from pg_stat_activity
      where application_name in ('sandbox_race_holder','sandbox_race_A','sandbox_race_B');" >/dev/null 2>&1
  [ -n "$HOLD_PID" ] && kill "$HOLD_PID" 2>/dev/null
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  psql "$DATABASE_URL" -q -c "drop table if exists $CTRL_TABLE;" >/dev/null 2>&1
  rm -rf "$OUT_DIR"
  set -e
}
trap cleanup EXIT

echo "== [concurrency] cleaning any prior race rows and control table =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from sandbox.ledger where idempotency_key in ('$RACE_KEY','$RACE_KEY:credit');
   delete from sandbox.top_ups where idempotency_key = '$RACE_KEY';
   drop table if exists $CTRL_TABLE;
   create table $CTRL_TABLE (flag text primary key, val text not null default '');
   insert into $CTRL_TABLE(flag,val) values ('release','0');"

# ---------------------------------------------------------------------
# الجلسة الثالثة (holder): معاملة واحدة (-c واحدة = معاملة واحدة) تأخذ
# القفل الاستشاري للمستخدم وتحتفظ به حتى يصبح release=1، ثم تُنهي المعاملة
# (الإفراج عن القفل). مهلة قصوى 30s حتى لا تعلق أبداً.
# ---------------------------------------------------------------------
HOLDER_SQL="set statement_timeout='45s';
select pg_advisory_xact_lock($LOCK_EXPR);
do \$\$
declare v text; i integer := 0;
begin
  loop
    select val into v from $CTRL_TABLE where flag = 'release';
    exit when coalesce(v,'') = '1';
    perform pg_sleep(0.05);
    i := i + 1;
    if i > 600 then
      raise exception 'holder timeout: release flag never set (lock held too long)';
    end if;
  end loop;
end \$\$;"

# الجلسة A: founder يمنح عملات بالمفتاح المشترك (أول قفل = قفل المستخدم).
SESSION_A_SQL="set statement_timeout='20s';
set role authenticated;
select set_config('request.jwt.claims', '{\"sub\":\"$FOUNDER\"}', true);
select public.aani_sandbox_grant_coins('$USER_A', 100, '$RACE_KEY', 'race grant');"

# الجلسة B: userA يشحن بالمفتاح نفسه (أول قفل = قفل المستخدم).
SESSION_B_SQL="set statement_timeout='20s';
set role authenticated;
select set_config('request.jwt.claims', '{\"sub\":\"$USER_A\"}', true);
select public.aani_sandbox_top_up('$USER_A', '$PACKAGE', '$RACE_KEY', true);"

echo "== [concurrency] launching 3rd session to HOLD the shared advisory lock =="
PGAPPNAME=sandbox_race_holder psql "$DATABASE_URL" -v VERBOSITY=sqlstate -v ON_ERROR_STOP=1 \
  -c "$HOLDER_SQL" >"$OUT_DIR/holder.out" 2>&1 &
HOLD_PID=$!

# 1) انتظر حتى نرى القفل ممنوحاً فعلياً للـ holder (دليل أنه ينتظر عليه A/B لاحقاً).
echo "== [concurrency] waiting until holder is granted the advisory lock =="
HOLD_SEEN=0
for _ in $(seq 1 100); do
  N=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
    "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where a.application_name='sandbox_race_holder' and l.granted and $LOCK_MATCH;")
  if [ "${N:-0}" -ge 1 ]; then HOLD_SEEN=1; break; fi
  sleep 0.1
done
if [ "$HOLD_SEEN" -ne 1 ]; then
  echo "FAIL: holder never acquired the shared advisory lock ($LOCK_EXPR)"
  echo "----- holder output -----"; cat "$OUT_DIR/holder.out"
  exit 1
fi
echo "OK: holder holds advisory lock on sandbox:user:$USER_A"

# 2) أطلق A وB الآن (سيحاولان أخذ القفل نفسه ويُحجبان لأن الـ holder يحتجزه).
echo "== [concurrency] launching sessions A and B (they must block on the lock) =="
PGAPPNAME=sandbox_race_A psql "$DATABASE_URL" -v VERBOSITY=sqlstate -v ON_ERROR_STOP=0 \
  -c "$SESSION_A_SQL" >"$OUT_DIR/a.out" 2>&1 &
PID_A=$!
PGAPPNAME=sandbox_race_B psql "$DATABASE_URL" -v VERBOSITY=sqlstate -v ON_ERROR_STOP=0 \
  -c "$SESSION_B_SQL" >"$OUT_DIR/b.out" 2>&1 &
PID_B=$!

# 3) تحقق أن كليهما في حالة انتظار على نفس القفل الاستشاري قبل الإفراج.
#    هذا هو الإثبات المطلوب: انتظار فعلي على القفل المالي المشترك.
echo "== [concurrency] verifying BOTH A and B are WAITING on the shared advisory lock =="
WAIT_PROVEN=0
for _ in $(seq 1 150); do
  W=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
    "select count(*) from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name in ('sandbox_race_A','sandbox_race_B')
        and a.wait_event_type='Lock' and not l.granted and $LOCK_MATCH;")
  if [ "${W:-0}" -ge 2 ]; then WAIT_PROVEN=1; break; fi
  sleep 0.1
done

if [ "$WAIT_PROVEN" -eq 1 ]; then
  echo "PROVEN: both A and B are blocked waiting on advisory lock sandbox:user:$USER_A"
  echo "----- pg_locks snapshot (advisory lock + waiters) -----"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "select a.application_name, a.wait_event_type, l.granted, l.locktype, l.objid
       from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where a.application_name in ('sandbox_race_holder','sandbox_race_A','sandbox_race_B')
        and $LOCK_MATCH
      order by a.application_name;"
else
  echo "FAIL: did not observe BOTH A and B waiting on the shared advisory lock before release"
  echo "----- holder output -----"; cat "$OUT_DIR/holder.out"
  echo "----- session A output -----"; cat "$OUT_DIR/a.out"
  echo "----- session B output -----"; cat "$OUT_DIR/b.out"
  # أفرج عن القفل حتى لا تبقى الجلسات معلقة (التنظيف يتكفل بالباقي).
  psql "$DATABASE_URL" -q -c "update $CTRL_TABLE set val='1' where flag='release';"
  exit 1
fi

# 4) أفرج عن القفل ليبدأ التنافس الحقيقي.
echo "== [concurrency] releasing the lock -> real race begins =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "update $CTRL_TABLE set val='1' where flag='release';"

RC_A=0; RC_B=0; RC_H=0
wait "$PID_A" || RC_A=$?
wait "$PID_B" || RC_B=$?
wait "$HOLD_PID" || RC_H=$?
PID_A=''; PID_B=''; HOLD_PID=''

echo "----- holder output -----"; cat "$OUT_DIR/holder.out"
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

echo "== [concurrency] A=$CA B=$CB (holder_rc=$RC_H) =="

FAIL=0
if [ "$CA" = "success" ] && [ "$CB" = "conflict" ]; then
  echo "PASS: grant won, top_up rejected with SQLSTATE 40901"
elif [ "$CB" = "success" ] && [ "$CA" = "conflict" ]; then
  echo "PASS: top_up won, grant rejected with SQLSTATE 40901"
else
  echo "FAIL: expected exactly one success and one SQLSTATE 40901 conflict (A=$CA B=$CB)"
  FAIL=1
fi

# تأكد أن الـ holder خرج نظيفاً (0) — أي مهلة/خطأ فيه يشير إلى تعليق.
if [ "$RC_H" -ne 0 ]; then
  echo "FAIL: lock-holder session did not exit cleanly (rc=$RC_H)"
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