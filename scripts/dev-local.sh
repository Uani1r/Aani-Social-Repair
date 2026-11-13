#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-120}"
POLL_INTERVAL_SECONDS=0.25
api_pid=""
vite_pid=""
api_log="$(mktemp "${TMPDIR:-/tmp}/aani-api.XXXXXX.log")"
vite_log="$(mktemp "${TMPDIR:-/tmp}/aani-vite.XXXXXX.log")"

show_logs() {
  local name="$1"
  local log_file="$2"
  if [[ -s "$log_file" ]]; then
    printf '\n--- %s startup log (last 80 lines) ---\n' "$name" >&2
    tail -n 80 "$log_file" >&2 || true
  else
    printf '\n--- %s produced no startup log ---\n' "$name" >&2
  fi
}

stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0

  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep "$POLL_INTERVAL_SECONDS"
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_group "$vite_pid"
  stop_group "$api_pid"
  rm -f "$api_log" "$vite_log"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail_startup() {
  printf '[dev-local] ERROR: %s\n' "$1" >&2
  show_logs 'API server' "$api_log"
  show_logs 'Vite' "$vite_log"
  exit 1
}

# فحص توفر المنفذ عبر وحدة net المدمجة في Node.js: نحاول فتح TCP listener
# مؤقتاً ثم نغلقَه. نجاح الفتح = المنفذ متاح، EADDRINUSE = المنفذ مشغول،
# وأي نتيجة أخرى (خطأ في الفحص) لا تعتبر دليلاً على أن المنفذ متاح.
port_is_free() {
  local port="$1"
  local probe_out=""
  probe_out="$(node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", (err) => {
      if (err && err.code === "EADDRINUSE") { console.log("busy"); process.exit(0); }
      console.log("error:" + (err && err.code ? err.code : "unknown"));
      process.exit(0);
    });
    server.once("listening", () => {
      server.close(() => { console.log("free"); process.exit(0); });
    });
    server.listen(port, "0.0.0.0");
  ' "$port" 2>/dev/null || true)"
  [[ "$probe_out" == "free" ]]
}

stop_old_servers() {
  command -v pkill >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: pkill is required to stop stale development server runners.\n' >&2
    exit 1
  }
  command -v node >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: node is required for port availability checks (net module).\n' >&2
    exit 1
  }

  # أوقف فقط مشغّلات مساحة العمل المعروفة (pnpm run dev للواجهة وAPI وأي
  # vite dev server قديم). لا عمليات مجهولة ولا killall.
  pkill -TERM -f '[p]npm.*@workspace/api-server.*run dev' 2>/dev/null || true
  pkill -TERM -f '[p]npm.*@workspace/aani-social.*run dev' 2>/dev/null || true
  pkill -TERM -f '[v]ite --config' 2>/dev/null || true

  for _ in {1..40}; do
    if port_is_free 5000 && port_is_free 8080; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  # فحص نهائي لكل منفذ: إن بقي مشغولاً بعملية لا نستطيع تحديدها بأمان
  # نتوقف برسالة واضحة بدل قتل عمليات مجهولة قد تكون خدمات Replit.
  for port in 5000 8080; do
    if ! port_is_free "$port"; then
      printf '[dev-local] ERROR: المنفذ %s لا يزال مشغولاً بعملية غير معروفة بعد إيقاف مشغّلات مساحة العمل المعروفة. إيقاف الإقلاع احترازاً — لم تُقتل أي عملية مجهولة. ابحث عن العملية المعتية يدوياً بـ: ps aux | grep %s\n' "$port" "$port" >&2
      exit 1
    fi
  done
}

wait_for_http() {
  local name="$1"
  local pid="$2"
  local url="$3"
  local expected_status="$4"
  local on_failure="${5:-fail}"
  local status=""
  local attempts=$((STARTUP_TIMEOUT_SECONDS * 4))

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if ! kill -0 -- "-$pid" 2>/dev/null; then
      if [[ "$on_failure" == "warn" ]]; then
        printf '[dev-local] WARNING: %s process exited before becoming ready (URL: %s).\n' "$name" "$url" >&2
        return 1
      fi
      fail_startup "$name process exited before becoming ready (URL: $url)."
    fi

    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    if [[ "$status" == "$expected_status" ]]; then
      printf '[dev-local] %s ready: %s (HTTP %s)\n' "$name" "$url" "$status"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  if [[ "$on_failure" == "warn" ]]; then
    printf '[dev-local] WARNING: %s did not return HTTP %s within %ss (URL: %s; last status: %s).\n' "$name" "$expected_status" "$STARTUP_TIMEOUT_SECONDS" "$url" "${status:-no response}" >&2
    return 1
  fi
  fail_startup "$name did not return HTTP $expected_status within ${STARTUP_TIMEOUT_SECONDS}s (URL: $url; last status: ${status:-no response})."
}

command -v curl >/dev/null 2>&1 || {
  printf '[dev-local] ERROR: curl is required for server readiness checks.\n' >&2
  exit 1
}
command -v setsid >/dev/null 2>&1 || {
  printf '[dev-local] ERROR: setsid is required to keep both server process groups cleanly stoppable.\n' >&2
  exit 1
}

stop_old_servers

# تثبيت الاعتماديات فقط عند الحاجة الفعلية: بلا node_modules أو غياب
# أدوات التشغيل (vite للواجهة، tsx للـAPI). التشغيل الاعتيادي بعد أول
# مرة لا يثبّت شيئاً — مسارات البناء والنشر غير متأثرة.
if [[ ! -d "$ROOT_DIR/artifacts/aani-social/node_modules" ]] \
  || [[ ! -d "$ROOT_DIR/artifacts/api-server/node_modules" ]] \
  || [[ ! -x "$ROOT_DIR/artifacts/aani-social/node_modules/.bin/vite" ]] \
  || [[ ! -x "$ROOT_DIR/artifacts/api-server/node_modules/.bin/tsx" ]]; then
  printf '[dev-local] Installing workspace dependencies (missing node_modules or runners)...\n'
  pnpm install --prefer-offline
else
  printf '[dev-local] Dependencies already installed — skipping pnpm install.\n'
fi

printf '[dev-local] Starting API server on 8080 (tsx watch, no rebuild)...\n'
setsid env PORT=8080 pnpm --filter @workspace/api-server run dev >"$api_log" 2>&1 &
api_pid=$!

printf '[dev-local] Starting Vite on 0.0.0.0:5000...\n'
setsid env PORT=5000 pnpm --filter @workspace/aani-social run dev >"$vite_log" 2>&1 &
vite_pid=$!

# فحص جاهزية Vite: أساسي — فشله يوقف السكربت (لا واجهة بدونه).
wait_for_http 'Vite homepage' "$vite_pid" 'http://127.0.0.1:5000/' '200'
wait_for_http 'Vite main module' "$vite_pid" 'http://127.0.0.1:5000/src/main.tsx' '200'

# فحص API مستقل وغير حاجب: فشله أو تأخره تحذير فقط — الواجهة تبقى
# عاملة على 5000 ولا تُوقف عملية Vite مهما حدث للـAPI.
if wait_for_http 'API server' "$api_pid" 'http://127.0.0.1:8080/api/health' '200' 'warn'; then
  printf '[dev-local] API ready on 8080.\n' >&2
else
  printf '[dev-local] WARNING: API غير جاهز على 8080 — الواجهة تبقى عاملة على 5000 وطلبات /api ستفشل حتى عودة الـAPI.\n' >&2
  show_logs 'API server' "$api_log"
fi

printf '[dev-local] Vite is serving on 5000. Monitoring both servers...\n'

# المراقبة: توقف API تحذير فقط ولا يقتل الواجهة أبداً؛ توقف Vite فادح
# (لا واجهة بدونه) فينظّف العملية الأخرى. لا عمليات مجهولة تُقتل هنا،
# والتنظيف الكامل يبقى في trap EXIT عند إيقاف المشروع.
while true; do
  if ! kill -0 -- "-$vite_pid" 2>/dev/null; then
    fail_startup "Vite process exited unexpectedly."
  fi
  if [[ -n "$api_pid" ]] && ! kill -0 -- "-$api_pid" 2>/dev/null; then
    printf '[dev-local] WARNING: API process exited — الواجهة تبقى عاملة على 5000. أعد تشغيل الـAPI لإرجاع /api.\n' >&2
    show_logs 'API server' "$api_log"
    api_pid=""
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done
