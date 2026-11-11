#!/usr/bin/env bash
set -Eeuo pipefail

PORT=8080 pnpm --filter @workspace/api-server run dev &
api_pid=$!
PORT=5000 pnpm --filter @workspace/aani-social run dev &
vite_pid=$!

cleanup() {
  kill "$api_pid" "$vite_pid" 2>/dev/null || true
  wait "$api_pid" "$vite_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$api_pid" "$vite_pid"
