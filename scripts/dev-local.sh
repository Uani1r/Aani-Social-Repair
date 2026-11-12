#!/usr/bin/env bash
set -Eeuo pipefail

# تثبيت التبعيات قبل الإقلاع: بعد أي سحب يضيف حزماً جديدة (مثل mediabunny)
# يجب تثبيتها أولاً وإلا فشل Vite في فحص التبعيات عند الإقلاع فتظهر شاشة بيضاء.
pnpm install --prefer-offline

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
