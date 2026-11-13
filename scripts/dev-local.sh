#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-120}"
POLL_INTERVAL_SECONDS=0.25
api_pgid=""
vite_pgid=""
api_check_pid=""

# ملف حالة خارج المستودع يسجّل هوية مجموعات العمليات التي أنشأها هذا السكربت:
# رقم PGID مع أزواج pid:starttime مقروءة من /proc. رقم PGID وحده لا يثبت الهوية
# لأنه يُعاد استخدامه، فلا تُقبل مجموعة مستعادة إلا إذا طابق وقت بدء أحد
# أعضائها السجل.
STATE_FILE="${TMPDIR:-/tmp}/aani-dev-local-$(printf '%s' "$ROOT_DIR" | tr -c 'A-Za-z0-9' '_').state"

# نمط احتياطي لتمييز مشغّلات هذه مساحة العمل: أسماء الحزم ومساراتها فقط.
# أُزيل منه أي اسم أداة عام (tsx/vite) لأنه يوسّع النطاق بلا إثبات هوية.
# الملكية الفعلية تُثبت بـpid + وقت البدء من /proc، أو بمجلد عمل داخل المستودع
# (وهو ما يغطي أبناء vite/tsx الذين يُنفَّذون من مخزن pnpm في جذر مساحة العمل).
workspace_runner_pattern='(@workspace/(aani-social|api-server)|artifacts/(aani-social|api-server))'

# أرقام أعضاء المجموعات التي أثبتنا انتماءها لهذه مساحة العمل: PGID ← " PID PID ..."
# يحفظ الانتماء بعد خروج الزعيم أو تغيّر أفراد المجموعة.
declare -A group_known_pids=()

# المجموعات المثبتة الهوية: PGID ← " pid:starttime pid:starttime ..." من /proc.
# تُحفظ هوية الزعيم وأبنائه، ويُعاد فحصها قبل كل إشارة.
declare -A trusted_groups=()
# يُرفع عند تسجيل عضو جديد في مجموعة قائمة، فتُكتب الهوية مرة واحدة فقط.
state_dirty=0

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

# هوية العملية من /proc/<pid>/stat: "pgid starttime". اسم العملية قد يحتوي
# مسافات وأقواساً، لذلك يُقتطع حتى آخر ") " ثم تُقرأ الحقول بعده: الحقل 3
# (state) هو أولها، وحقل 22 (starttime) هو التاسع عشر بعده.
proc_identity() {
  local pid="${1:-}"
  local stat_line=""
  local rest=""
  local -a fields=()
  [[ -n "$pid" ]] || return 1
  IFS= read -r stat_line <"/proc/$pid/stat" 2>/dev/null || return 1
  [[ -n "$stat_line" ]] || return 1
  rest="${stat_line##*) }"
  [[ -n "$rest" ]] || return 1
  read -r -a fields <<<"$rest"
  ((${#fields[@]} >= 20)) || return 1
  printf '%s %s' "${fields[2]}" "${fields[19]}"
}

# هل ما زالت العملية pid هي نفسها (نفس وقت البدء) وما زالت في مجموعة pgid؟
# هذا ما يمنع إرسال إشارة إلى مجموعة أُعيد استخدام رقمها.
identity_matches() {
  local pid="${1:-}"
  local pgid="${2:-}"
  local start="${3:-}"
  local identity=""
  local actual_pgid=""
  local actual_start=""
  [[ -n "$pid" && -n "$pgid" && -n "$start" ]] || return 1
  identity="$(proc_identity "$pid" || true)"
  [[ -n "$identity" ]] || return 1
  read -r actual_pgid actual_start <<<"$identity"
  [[ "$actual_pgid" == "$pgid" && "$actual_start" == "$start" ]]
}

# هل ما زالت هوية واحدة على الأقل من الهويات المسجّلة للمجموعة تطابق عملية
# حيّة؟ التحقق يجمع ثلاثة عناصر معاً: PID نفسه، ووقت بدء العملية، وPGID.
# يُطبَّق على الزعيم والأبناء بالتساوي، ويُعاد قبل كل إشارة.
trusted_identity_matches() {
  local pgid="${1:-}"
  local tokens=""
  local token=""
  local pid=""
  local start=""
  [[ -n "$pgid" ]] || return 1
  tokens="${trusted_groups[$pgid]:-}"
  [[ -n "$tokens" ]] || return 1
  for token in $tokens; do
    pid="${token%%:*}"
    start="${token#*:}"
    [[ "$start" == "$token" ]] && continue
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if identity_matches "$pid" "$pgid" "$start"; then
      return 0
    fi
  done
  return 1
}

# يحدّث هوية المجموعة من أعضائها الأحياء الآن (الزعيم والأبناء). يُستدعى فقط
# بعد إثبات الملكية، فكل أعضاء المجموعة الحالية هم من مجموعتنا. حفظ هوية
# الأبناء يجعل المجموعة قابلة للتنظيف حتى بعد خروج الزعيم.
refresh_group_trust() {
  local pgid="${1:-}"
  local pid=""
  local identity=""
  local identity_pgid=""
  local start=""
  local line=""
  [[ -n "$pgid" ]] || return 1
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    identity="$(proc_identity "$pid" || true)"
    [[ -n "$identity" ]] || continue
    read -r identity_pgid start <<<"$identity"
    [[ "$identity_pgid" == "$pgid" ]] || continue
    line="$line $pid:$start"
  done < <(group_member_pids "$pgid")
  trusted_groups["$pgid"]="$line"
  [[ -n "$line" ]]
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
      state_dirty=1
    fi
  done < <(group_member_pids "$pgid")
  group_known_pids["$pgid"]="$known"
}

# هل المجموعة لنا؟ الأولوية لثقة مثبتة بالهوية (PID + وقت البدء + PGID):
# وجود ثقة سابقة لا يكفي، بل يجب أن تطابق الآن هوية أحد أعضائها المسجّلين.
# وبدون أي هوية مسجّلة يبقى التحقق محدوداً: اسم الحزمة في سطر الأوامر، أو مجلد
# عمل داخل المستودع، أو عضو سجّلناه سابقاً.
group_is_ours() {
  local pgid="${1:-}"
  local tokens=""
  [[ -n "$pgid" ]] || return 1
  group_has_members "$pgid" || return 1
  tokens="${trusted_groups[$pgid]:-}"
  if [[ -n "$tokens" ]]; then
    if trusted_identity_matches "$pgid"; then
      return 0
    fi
    return 1
  fi
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

  # قبل أي إشارة: إن كانت لدينا هوية مسجّلة (زعيم أو ابن)، يجب أن تطابق الآن
  # بثلاثة عناصر معاً: PID ووقت البدء وPGID. وفشل التحقق يمنع SIGTERM
  # وSIGKILL كليهما.
  local trusted_token="${trusted_groups[$pgid]:-}"
  if [[ -n "$trusted_token" ]]; then
    if ! trusted_identity_matches "$pgid"; then
      printf '[dev-local] WARNING: هوية المجموعة %s المسجّلة (PID/وقت البدء/PGID) لم تعد تطابق أي عملية حيّة — لن يُرسل SIGTERM ولا SIGKILL إلى هذه المجموعة.\n' "$pgid" >&2
      return 0
    fi
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
    # نفس التحقق يُعاد قبل SIGKILL: العملية التي أثبتت الهوية قد تكون خرجت
    # بين SIGTERM وهذه اللحظة، أو أُعيد استخدام PID. لا KILL بلا إثبات.
    local kill_allowed=0
    if [[ -n "$trusted_token" ]]; then
      if trusted_identity_matches "$pgid"; then
        kill_allowed=1
      fi
    elif group_is_ours "$pgid"; then
      kill_allowed=1
    fi
    if ((kill_allowed)); then
      kill -KILL -- "-$pgid" 2>/dev/null || true
    else
      printf '[dev-local] WARNING: بعد SIGTERM لم تعد أي هوية مسجّلة للمجموعة %s تطابق عملية حيّة (PID/وقت البدء/PGID) — لن يُرسل SIGKILL. افحص المجموعة يدوياً: ps -o pid,pgid,lstart,args -s %s\n' "$pgid" "$pgid" >&2
    fi
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

# يكتب هوية المجموعات الحالية: لكل مجموعة سطر يبدأ بـPGID ثم أزواج
# pid:starttime لأعضائها الأحياء (من /proc). التحقق عند التشغيل التالي يطابق
# وقت البدء، فلا تُمس مجموعة أُعيد استخدام رقمها.
write_state_file() {
  local pgid=""
  local pid=""
  local identity=""
  local identity_pgid=""
  local start=""
  local line=""
  : >"$STATE_FILE" 2>/dev/null || return 0
  for pgid in "$vite_pgid" "$api_pgid"; do
    [[ -n "$pgid" ]] || continue
    line="$pgid"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      identity="$(proc_identity "$pid" || true)"
      [[ -n "$identity" ]] || continue
      read -r identity_pgid start <<<"$identity"
      [[ "$identity_pgid" == "$pgid" ]] || continue
      line="$line $pid:$start"
    done < <(group_member_pids "$pgid")
    printf '%s\n' "$line" >>"$STATE_FILE" 2>/dev/null || true
  done
}

# يُوقف مجموعات تشغيل سابقة سجّلها هذا السكربت، بعد إثبات الهوية من /proc
# (PID + وقت البدء + PGID). إن تعذّر الإثبات — إعادة استخدام PGID أو خروج كل
# الأطراف المسجلة — لا تُرسل أي إشارة، وتُطبع تحذير واضح.
stop_recorded_groups() {
  [[ -f "$STATE_FILE" ]] || return 0
  local line=""
  local pgid=""
  local token=""
  local pid=""
  local start=""
  local proven="0"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pgid="${line%% *}"
    [[ "$pgid" =~ ^[0-9]+$ ]] || continue
    group_has_members "$pgid" || continue
    proven="0"
    for token in ${line#"$pgid"}; do
      pid="${token%%:*}"
      start="${token#*:}"
      [[ "$start" == "$token" ]] && continue
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if identity_matches "$pid" "$pgid" "$start"; then
        proven="1"
        break
      fi
    done
    if [[ "$proven" != "1" ]]; then
      printf '[dev-local] WARNING: مجموعة العمليات %s من تشغيل سابق لم يثبت انتماؤها (وقت بدء العملية لا يطابق السجل، احتمال إعادة استخدام PGID) — لن توجَّه إليها أي إشارة. افحصها يدوياً: ps -o pid,pgid,lstart,args -s %s\n' "$pgid" "$pgid" >&2
      continue
    fi
    trusted_groups["$pgid"]="$token"
    printf '[dev-local] Stopping process group %s left by a previous run...\n' "$pgid" >&2
    stop_group "$pgid"
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
refresh_group_trust "$api_pgid" || true
refresh_group_trust "$vite_pgid" || true
write_state_file
state_dirty=0

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
  refresh_group_trust "$vite_pgid" || true
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
      refresh_group_trust "$api_pgid" || true
      if group_leader_alive "$api_pgid"; then
        api_leader_warned=0
      elif [[ "$api_leader_warned" -eq 0 ]]; then
        printf '[dev-local] WARNING: زعيم مجموعة API (PID %s) خرج وبقيت عمليات تابعة للمجموعة — تستمر المراقبة والتنظيف على مستوى المجموعة.\n' "$api_pgid" >&2
        api_leader_warned=1
      fi
    fi
  fi

  # تُحدَّث الهوية في ملف الحالة متى ظهر عضو جديد (ابن vite/tsx)، فيُثبت
  # انتماء المجموعة في التشغيل التالي حتى لو خرج زعيمها وبقي الأبناء.
  if ((state_dirty)); then
    write_state_file
    state_dirty=0
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
