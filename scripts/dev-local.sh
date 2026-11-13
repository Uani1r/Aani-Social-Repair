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

port_is_listening() {
  local listeners
  listeners="$(ss -H -ltn "sport = :$1" 2>/dev/null || true)"
  [[ -n "$listeners" ]]
}

signal_known_listener() {
  local port="$1"
  local signal="$2"
  local listeners
  local pids
  local pid
  local command_line

  listeners="$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)"
  [[ -n "$listeners" ]] || return 0
  pids="$(printf '%s' "$listeners" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  if [[ -z "$pids" ]]; then
    printf '[dev-local] ERROR: cannot identify the process listening on port %s:\n%s\n' "$port" "$listeners" >&2
    exit 1
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$port:$command_line" in
      5000:*vite*|8080:*dist/index.mjs*|8080:*api-server*)
        printf '[dev-local] Sending SIG%s to stale server PID %s on port %s.\n' "$signal" "$pid" "$port" >&2
        kill -"$signal" "$pid" 2>/dev/null || true
        ;;
      *)
        printf '[dev-local] ERROR: port %s is occupied by an unrecognized process (PID %s): %s\n' "$port" "$pid" "${command_line:-unknown command}" >&2
        exit 1
        ;;
    esac
  done <<< "$pids"
}

stop_old_servers() {
  command -v pkill >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: pkill is required to stop stale development server runners.\n' >&2
    exit 1
  }
  command -v ss >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: ss is required to verify that ports 5000 and 8080 are clear.\n' >&2
    exit 1
  }
  command -v ps >/dev/null 2>&1 || {
    printf '[dev-local] ERROR: ps is required to identify existing port listeners safely.\n' >&2
    exit 1
  }

  # Stop only this workspace's package runners first, then verify any remaining
  # listeners by PID/command before signaling them; unknown processes are kept.
  pkill -TERM -f '[p]npm.*@workspace/api-server.*run dev' 2>/dev/null || true
  pkill -TERM -f '[p]npm.*@workspace/aani-social.*run dev' 2>/dev/null || true
  signal_known_listener 5000 TERM
  signal_known_listener 8080 TERM

  for _ in {1..40}; do
    if ! port_is_listening 5000 && ! port_is_listening 8080; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  signal_known_listener 5000 KILL
  signal_known_listener 8080 KILL
  for port in 5000 8080; do
    for _ in {1..20}; do
      port_is_listening "$port" || break
      sleep "$POLL_INTERVAL_SECONDS"
    done
    if port_is_listening "$port"; then
      printf '[dev-local] ERROR: port %s remains occupied after stopping the stale server:\n' "$port" >&2
      ss -ltnp "sport = :$port" >&2 || true
      exit 1
    fi
  done
}

wait_for_http() {
  local name="$1"
  local pid="$2"
  local url="$3"
  local expected_status="$4"
  local status=""
  local attempts=$((STARTUP_TIMEOUT_SECONDS * 4))

  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if ! kill -0 -- "-$pid" 2>/dev/null; then
      fail_startup "$name process exited before becoming ready (URL: $url)."
    fi

    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    if [[ "$status" == "$expected_status" ]]; then
      printf '[dev-local] %s ready: %s (HTTP %s)\n' "$name" "$url" "$status"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

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

# Install once, before either development server starts. The frontend's dev
# script intentionally does not install; deployment/build install paths remain
# unchanged.
printf '[dev-local] Installing workspace dependencies once...\n'
pnpm install --prefer-offline

printf '[dev-local] Starting API server on 8080...\n'
setsid env PORT=8080 pnpm --filter @workspace/api-server run dev >"$api_log" 2>&1 &
api_pid=$!

printf '[dev-local] Starting Vite on 0.0.0.0:5000...\n'
setsid env PORT=5000 pnpm --filter @workspace/aani-social run dev >"$vite_log" 2>&1 &
vite_pid=$!

wait_for_http 'API server' "$api_pid" 'http://127.0.0.1:8080/api/health' '200'
wait_for_http 'Vite homepage' "$vite_pid" 'http://127.0.0.1:5000/' '200'
wait_for_http 'Vite main module' "$vite_pid" 'http://127.0.0.1:5000/src/main.tsx' '200'

printf '[dev-local] Both servers are ready. Waiting for either process to exit...\n'
if wait -n "$api_pid" "$vite_pid"; then
  exit_code=0
else
  exit_code=$?
fi
fail_startup "A server process exited unexpectedly (exit code $exit_code)."
