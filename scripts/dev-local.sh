#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-120}"
POLL_INTERVAL_SECONDS=0.25
api_pgid=""
vite_pgid=""
api_check_pid=""

# ملف حالة خارج المستودع يسجّل مجموعات العمليات (PGID) التي أنشأها هذا
# السكربت، كي يوقف التشغيل التالي تلك المجموعات تحديداً — وليس أي عملية
# تشبهها في الاسم. وجوده يجعل التنظيف مرتبطاً بمجموعاتنا لا بأسماء عامة.
STATE_FILE="${TMPDIR:-/tmp}/aani-dev-local-$(printf '%s' "$ROOT_DIR" | tr -c 'A-Za-z0-9' '_').state"

# نمط يميّز مشغّلات هذه مساحة العمل داخل مجموعة عملية واحدة:
#   * مغلفات pnpm باسم الحزمة (@workspace/aani-social، @workspace/api-server)
#   * أبناء vite/tsx بمسار الحزمة داخل المستودع أو باسم المشغّل tsx
# يُطبَّق فقط على أعضاء مجموعة أثبتنا ملكيتها، فلا يمس أي عملية خارجها.
workspace_runner_pattern='(@workspace/(aani-social|api-server)|artifacts/(aani-social|api-server)|tsx)'

# أرقام أعضاء المجموعات التي أثبتنا انتماءها لهذه مساحة العمل: PGID ← " PID PID ..."
# يحفظ الانتماء بعد خروج الزعيم أو تغيّر أفراد المجموعة.
declare -A group_known_pids=()

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

# --- فحص مجموعات العمليات ----------------------------------------------------
# setsid يجعل PID = PGID = معرف الجلسة. نفحص الزعيم وأفراد المجموعة بصورة
# مستقلة: خروج الزعيم لا يعني خروج المجموعة (قد يبقى الابن حياً)، وخروج كل
# الأعضاء لا يعني أن رقم المجموعة لن يُعاد استخدامه من عملية أخرى.

# نستثني عمليات الزومبي (STAT يبدأ بـZ): لا تُحتسب عضواً حياً، كي لا يُخفي
# بقايا عملية ميتة انتهاء المجموعة فعلياً.
group_member_pids() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 0
  ps -eo pid=,pgid=,stat= 2>/dev/null \
    | awk -v g="$pgid" '$2 + 0 == g + 0 && $3 !~ /^Z/ { print $1 }'
}

group_member_cmdlines() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 0
  ps -eo pgid=,stat=,args= 2>/dev/null \
    | awk -v g="$pgid" '$1 + 0 == g + 0 && $2 !~ /^Z/ { $1 = ""; $2 = ""; sub(/^[[:space:]]+/, ""); print }'
}

group_has_members() {
  local pgid="${1:-}"
  local pids=""
  [[ -n "$pgid" ]] || return 1
  pids="$(group_member_pids "$pgid")"
  [[ -n "$pids" ]]
}

# هل الزعيم (PID == PGID) ما زال حياً؟ نطابق PGID الفعلي أيضاً كي لا تعطي
# إعادة استخدام PID نتيجة خاطئة، ونستثني الزومبي (STAT يبدأ بـZ).
group_leader_alive() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 1
  local info=""
  local actual=""
  local state=""
  info="$(ps -p "$pgid" -o pgid=,stat= 2>/dev/null || true)"
  [[ -n "$info" ]] || return 1
  read -r actual state <<<"$info"
  [[ -n "$actual" && -n "$state" ]] || return 1
  [[ "$actual" == "$pgid" && "$state" != Z* ]]
}

group_member_cwds() {
  local pgid="${1:-}"
  local pid=""
  [[ -n "$pgid" ]] || return 0
  command -v readlink >/dev/null 2>&1 || return 0
  [[ -d /proc ]] || return 0
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    readlink -f "/proc/$pid/cwd" 2>/dev/null || true
  done < <(group_member_pids "$pgid")
}

# الانتماء يُثبت بأحد أمرين: سطر أوامر أحد الأعضاء يشير إلى الحزمة/المشغّل،
# أو مجلد عمل أحد الأعضاء داخل هذا المستودع (أبناء vite/tsx يعملون داخل مجلد
# الحزمة حتى لو كان الملف المنفَّذ داخل مخزن pnpm في جذر مساحة العمل).
group_matches_workspace() {
  local pgid="${1:-}"
  local lines=""
  local cwd=""
  [[ -n "$pgid" ]] || return 1
  lines="$(group_member_cmdlines "$pgid" || true)"
  if [[ -n "$lines" ]] && grep -Eq -- "$workspace_runner_pattern" <<<"$lines"; then
    return 0
  fi
  while IFS= read -r cwd; do
    [[ -n "$cwd" ]] || continue
    if [[ "$cwd" == "$ROOT_DIR" || "$cwd" == "$ROOT_DIR"/* ]]; then
      return 0
    fi
  done < <(group_member_cwds "$pgid")
  return 1
}

group_known_pids_of() {
  local pgid="${1:-}"
  local known=""
  if [[ -n "$pgid" ]]; then
    known="${group_known_pids[$pgid]:-}"
  fi
  printf '%s' "$known"
}

group_has_known_member() {
  local pgid="${1:-}"
  local pid=""
  local known=""
  known="$(group_known_pids_of "$pgid")"
  [[ -n "$known" ]] || return 1
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ "$known" == *" $pid "* ]]; then
      return 0
    fi
  done < <(group_member_pids "$pgid")
  return 1
}

remember_group_members() {
  local pgid="${1:-}"
  local pid=""
  local known=""
  [[ -n "$pgid" ]] || return 0
  known="$(group_known_pids_of "$pgid")"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ "$known" != *" $pid "* ]]; then
      known="$known $pid"
    fi
  done < <(group_member_pids "$pgid")
  group_known_pids["$pgid"]="$known"
}

# هل المجموعة لمشغّلات هذه مساحة العمل؟ إما بمطابقة سطر أوامر أحد أعضائها،
# أو بوجود عضو معروف لدينا من قياس سابق. الثانية تُبقي المجموعة معروفة بعد
# خروج الزعيم، فيظل التنظيف ممكناً.
group_is_ours() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 1
  group_has_members "$pgid" || return 1
  if group_matches_workspace "$pgid"; then
    return 0
  fi
  group_has_known_member "$pgid"
}

# إيقاف مجموعة كاملة (بما فيها الأبناء) بلا اعتماد على بقاء الزعيم حياً،
# وبلا إشارة إلى مجموعة لا نستطيع إثبات أنها لنا.
stop_group() {
  local pgid="${1:-}"
  local attempt=""
  [[ -n "$pgid" ]] || return 0

  if ! group_has_members "$pgid"; then
    wait "$pgid" 2>/dev/null || true
    group_known_pids["$pgid"]=""
    return 0
  fi

  if ! group_is_ours "$pgid"; then
    printf '[dev-local] WARNING: المجموعة %s لم يثبت أنها لمشغّلات هذه مساحة العمل (إعادة استخدام PGID؟) — لن تُقتل.\n' "$pgid" >&2
    return 0
  fi

  kill -TERM -- "-$pgid" 2>/dev/null || true
  for attempt in {1..20}; do
    if ! group_has_members "$pgid"; then
      break
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
  if group_has_members "$pgid"; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  wait "$pgid" 2>/dev/null || true
  group_known_pids["$pgid"]=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_group "$vite_pgid"
  stop_group "$api_pgid"
  if [[ -n "$api_check_pid" ]]; then
    kill "$api_check_pid" 2>/dev/null || true
  fi
  rm -f "$api_log" "$vite_log" "$STATE_FILE"
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

# يُوقف مجموعات تشغيل سابقة سجّلها هذا السكربت (ملف الحالة) — تنظيف مرتبط
# بمجموعاتنا نحن، ويشمل الأبناء حتى لو خرج الزعيم.
stop_recorded_groups() {
  [[ -f "$STATE_FILE" ]] || return 0
  local pgid=""
  while IFS= read -r pgid; do
    [[ "$pgid" =~ ^[0-9]+$ ]] || continue
    if group_is_ours "$pgid"; then
      printf '[dev-local] Stopping process group %s left by a previous run...\n' "$pgid" >&2
      stop_group "$pgid"
    fi
  done <"$STATE_FILE"
  rm -f "$STATE_FILE"
}

# يوقف فقط عمليات tsx/vite التي تعمل داخل هذا المستودع (بفحص مجلد العمل عبر
# /proc، أو بوجود مسار المستودع في سطر الأوامر). لا يمس أي عملية خارجه،
# ولا يستخدم killall ولا أنماطاً عريضة.
stop_workspace_runner_processes() {
  [[ -d /proc ]] || return 0
  command -v readlink >/dev/null 2>&1 || return 0
  local pid=""
  local args=""
  local cwd=""
  while read -r pid args; do
    [[ -n "${pid:-}" ]] || continue
    [[ "$pid" == "$$" ]] && continue
    case "${args:-}" in
      *tsx*|*vite*) ;;
      *) continue ;;
    esac
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ -n "$cwd" && ( "$cwd" == "$ROOT_DIR" || "$cwd" == "$ROOT_DIR"/* ) ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    elif [[ "${args:-}" == *"$ROOT_DIR"* ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done < <(ps -eo pid=,args= 2>/dev/null || true)
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
  command -v ps >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: ps is required to verify process-group ownership before signalling.\n' >&2
    exit 1
  }
  command -v awk >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: awk is required to read process-group members.\n' >&2
    exit 1
  }

  # 1) مجموعات أنشأها تشغيل سابق لهذا السكربت (بالسجل، لا بالاسم).
  stop_recorded_groups

  # 2) مغلفات pnpm المعروفة لأوامر dev لهاتين الحزمتين فقط (للحالات القديمة
  #    التي لم تُسجَّل مجموعاتها).
  pkill -TERM -f '[p]npm.*@workspace/api-server.*run dev' 2>/dev/null || true
  pkill -TERM -f '[p]npm.*@workspace/aani-social.*run dev' 2>/dev/null || true

  # 3) أي مشغّل tsx/vite تشرد داخل هذا المستودع (أبناؤه لا يظهرون باسم
  #    الحزمة، فيُحدَّدون بمجلد العمل).
  stop_workspace_runner_processes

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
  local pgid="$2"
  local url="$3"
  local expected_status="$4"
  local on_failure="${5:-fail}"
  local status=""
  local attempts=$((STARTUP_TIMEOUT_SECONDS * 4))

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if ! group_has_members "$pgid"; then
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
api_pgid=$!

printf '[dev-local] Starting Vite on 0.0.0.0:5000...\n'
setsid env PORT=5000 pnpm --filter @workspace/aani-social run dev >"$vite_log" 2>&1 &
vite_pgid=$!

remember_group_members "$api_pgid"
remember_group_members "$vite_pgid"
printf '%s\n%s\n' "$vite_pgid" "$api_pgid" >"$STATE_FILE"

# فحص جاهزية Vite: أساسي — فشله يوقف السكربت (لا واجهة بدونه).
wait_for_http 'Vite homepage' "$vite_pgid" 'http://127.0.0.1:5000/' '200'
wait_for_http 'Vite main module' "$vite_pgid" 'http://127.0.0.1:5000/src/main.tsx' '200'

# فحص API مستقل وغير حاجب منذ البداية: يجري في الخلفية، ومتى حُسمت
# نتيجته (نجاح أو تحذير) لا يُؤخّر جاهزية Vite ولا يوقفه.
check_api_when_ready() {
  if wait_for_http 'API server' "$api_pgid" 'http://127.0.0.1:8080/api/health' '200' 'warn'; then
    printf '[dev-local] API ready on 8080.\n' >&2
  else
    printf '[dev-local] WARNING: API غير جاهز على 8080 — الواجهة تبقى عاملة على 5000 وطلبات /api ستفشل حتى عودة الـAPI.\n' >&2
    show_logs 'API server' "$api_log"
  fi
}
check_api_when_ready &
api_check_pid=$!

printf '[dev-local] Vite is serving on 5000. Monitoring both servers...\n'

# المراقبة: توقف API تحذير فقط ولا يقتل الواجهة أبداً؛ انتهاء كل عمليات
# مجموعة Vite فادح (لا واجهة بدونه). خروج الزعيم مع بقاء أفراد المجموعة
# ليس خروجاً طبيعياً: يستمر فحص المجموعة وأعضائها، ويظل التنظيف ممكناً.
# أي مجموعة لا نستطيع إثبات أنها لنا لا تُستهدف بأي إشارة.
vite_leader_warned=0
api_leader_warned=0

while true; do
  # ---- Vite: بوابة التشغيل ----
  if ! group_has_members "$vite_pgid"; then
    fail_startup "Vite process group exited unexpectedly (PGID $vite_pgid has no live members)."
  fi
  if ! group_is_ours "$vite_pgid"; then
    fail_startup "Vite process group (PGID $vite_pgid) no longer belongs to this workspace — every Aani Vite process has exited. Refusing to signal an unidentified process group."
  fi
  remember_group_members "$vite_pgid"
  if group_leader_alive "$vite_pgid"; then
    vite_leader_warned=0
  elif [[ "$vite_leader_warned" -eq 0 ]]; then
    printf '[dev-local] WARNING: زعيم مجموعة Vite (PID %s) خرج وبقيت عمليات تابعة للمجموعة — تستمر المراقبة والتنظيف على مستوى المجموعة.\n' "$vite_pgid" >&2
    vite_leader_warned=1
  fi

  # ---- API: مستقل تماماً عن الواجهة ----
  if [[ -n "$api_pgid" ]]; then
    if ! group_has_members "$api_pgid"; then
      printf '[dev-local] WARNING: API process group exited (PGID %s) — الواجهة تبقى عاملة على 5000. أعد تشغيل الـAPI لإرجاع /api.\n' "$api_pgid" >&2
      show_logs 'API server' "$api_log"
      api_pgid=""
    elif ! group_is_ours "$api_pgid"; then
      printf '[dev-local] WARNING: مجموعة API (PGID %s) لم يثبت أنها لنا — لن توجَّه إليها أي إشارة. الواجهة تبقى عاملة على 5000.\n' "$api_pgid" >&2
      api_pgid=""
    else
      remember_group_members "$api_pgid"
      if group_leader_alive "$api_pgid"; then
        api_leader_warned=0
      elif [[ "$api_leader_warned" -eq 0 ]]; then
        printf '[dev-local] WARNING: زعيم مجموعة API (PID %s) خرج وبقيت عمليات تابعة للمجموعة — تستمر المراقبة والتنظيف على مستوى المجموعة.\n' "$api_pgid" >&2
        api_leader_warned=1
      fi
    fi
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
