#!/usr/bin/env bash
# =====================================================================
# مشغّل اختبارات Sandbox المالي محلياً (Postgres) لإنتاج سجل ونتائج قابلة
# للتحقق. يُطبَّق على قاعدة اختبار مؤقتة فقط — لا Supabase سحابي ولا إنتاج.
#
# الترتيب:
#   1. bootstrap (أدوار + auth + storage + extensions + realtime)
#   2. fresh_schema_cloudflare_r2.sql (المخطط الأساسي — الحالة النهائية)
#   3. ترحيل الهدايا 20261124181406 (gifts/wallets — يعتمد عليه المالي)
#   4. الترحيل المالي 20270306000000_aani_sandbox_financial.sql
#   5. بيانات الاختبار sandbox_seed.sql
#   6. الاختبارات الـ28 (sandbox_isolation.test.sql) عبر اتصال إداري + SET ROLE
#   7. اختبار التزامن الحقيقي (جلستان) sandbox_concurrency.sh
#
# ملاحظة: لا نطبّق جميع الترحيلات التاريخية لأن fresh_schema يمثّل الحالة النهائية
# المكافئة لها؛ تطبيقها فوقه يتعارض (تغيير نوع دالة موجودة). نطبّق فقط ما يلزم
# للترحيل المالي: المخطط الأساسي + ترحيل الهدايا + الترحيل المالي.
#
# أي فشل في أي خطوة => خروج غير صفري (لا || true ولا إخفاء أخطاء).
# المتطلبات: psql، DATABASE_URL (اتصال إداري مالك للجداول).
# =====================================================================
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (admin connection to the test DB)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:?LOG_DIR is required}"
mkdir -p "$LOG_DIR"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1)

run_step() {
  local name="$1"; shift
  echo "===== STEP: $name ====="
  "$@"
  echo "===== OK: $name ====="
}

# 1) bootstrap
run_step "bootstrap" "${PSQL[@]}" -q -f "$SCRIPT_DIR/sandbox_bootstrap.sql" 2>&1 | tee "$LOG_DIR/01_bootstrap.log"

# 2) المخطط الأساسي (fresh_schema — الحالة النهائية لمشروع جديد فارغ)
run_step "fresh_schema" "${PSQL[@]}" -q -f "$SCRIPT_DIR/../fresh_schema_cloudflare_r2.sql" 2>&1 | tee "$LOG_DIR/02_fresh_schema.log"

# 3) ترحيل الهدايا (gifts/wallets/gift_transactions) — الترحيل المالي يعتمد عليه.
run_step "gifts_migration" "${PSQL[@]}" -q -f "$SCRIPT_DIR/../migrations/20261124181406_aani_gifts_popularity_final.sql" 2>&1 | tee "$LOG_DIR/03_gifts_migration.log"

# 4) الترحيل المالي 20270306000000 (الأخير — يضيف مخطط sandbox).
run_step "financial_migration" "${PSQL[@]}" -q -f "$SCRIPT_DIR/../migrations/20270306000000_aani_sandbox_financial.sql" 2>&1 | tee "$LOG_DIR/04_financial_migration.log"

# 5) بيانات الاختبار
run_step "seed" "${PSQL[@]}" -q -f "$SCRIPT_DIR/sandbox_seed.sql" 2>&1 | tee "$LOG_DIR/05_seed.log"

# 5) الاختبارات الـ28 — بدون ON_ERROR_STOP لجمع كل النتائج، ثم نحكم على الفشل.
#    كل عبارة DO مستقلة؛ الاستثناء يُفشل تلك العبارة فقط وتتابع البقية.
echo "===== STEP: isolation_tests ====="
TEST_LOG="$LOG_DIR/06_isolation_tests.log"
set +e
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f "$SCRIPT_DIR/sandbox_isolation.test.sql" 2>&1 | tee "$TEST_LOG"
PSQL_RC=${PIPESTATUS[0]}
set -e

# عدد الاختبارات الفاشلة من السجل — كل فشل يطبع "Test N failed".
# نستخرج أرقام الاختبارات الفاشلة الفريدة (1..28)؛ Test 0 فحص إعداد أولي.
# أي خطأ SQL لا يطابق نمط "Test N failed" يُحتسب فشلاً إضافياً (لا إخفاء).
FAIL_COUNT=$(awk 'match($0, /Test [0-9]+ failed/) { s=substr($0,RSTART,RLENGTH); gsub(/[^0-9]/,"",s); seen[s]=1 } END { n=0; for (k in seen) n++; print n }' "$TEST_LOG")
STRAY_ERRORS=$(awk '/ERROR/ && !/Test [0-9]+ failed/ {c++} END{print c+0}' "$TEST_LOG")
TOTAL_TESTS=30
if [ "$FAIL_COUNT" -eq 0 ] && [ "$STRAY_ERRORS" -eq 0 ] && [ "$PSQL_RC" -eq 0 ]; then
  PASSED="$TOTAL_TESTS"; FAILED=0
else
  FAILED=$(( FAIL_COUNT + STRAY_ERRORS )); PASSED=$(( TOTAL_TESTS - FAILED ))
  if [ "$PASSED" -lt 0 ]; then PASSED=0; fi
fi
SKIPPED=0

echo "===== SUMMARY (isolation) ====="
echo "total=$TOTAL_TESTS passed=$PASSED failed=$FAILED skipped=$SKIPPED"

# 6) اختبار التزامن الحقيقي
echo "===== STEP: concurrency ====="
set +e
bash "$SCRIPT_DIR/sandbox_concurrency.sh" 2>&1 | tee "$LOG_DIR/07_concurrency.log"
CONC_RC=${PIPESTATUS[0]}
set -e

# سجل ملخص
{
  echo "Sandbox Financial test run"
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "isolation_total=$TOTAL_TESTS"
  echo "isolation_passed=$PASSED"
  echo "isolation_failed=$FAILED"
  echo "isolation_skipped=$SKIPPED"
  echo "concurrency_rc=$CONC_RC"
} > "$LOG_DIR/summary.txt"

# الحكم النهائي: أي فشل => غير صفري.
if [ "$FAILED" -ne 0 ] || [ "$PSQL_RC" -ne 0 ] || [ "$CONC_RC" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"