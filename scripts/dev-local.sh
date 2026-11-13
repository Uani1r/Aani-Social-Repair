#!/usr/bin/env bash
set -Eeuo pipefail

# إغلاق أي عملية قديمة عالقة قبل التشغيل: خادم api قديم (بلا مسارات جديدة)
# يبقى يجيب على 8080 فيحجب الخادم الجديد، وعملية vite قديمة تحجب 5000.
# kill قبل البناء يضمن أن التشغيل دائماً من الكود المحدّث مباشرة.
pkill -f "dist/index.mjs" 2>/dev/null || true
pkill -f "node_modules/.bin/vite" 2>/dev/null || true
sleep 1

# تثبيت التبعيات قبل الإقلاع: بعد أي سحب يضيف حزماً جديدة (مثل mediabunny)
# يجب تثبيتها أولاً وإلا فشل Vite في فحص التبعيات عند الإقلاع فتظهر شاشة بيضاء.
pnpm install --prefer-offline

# `dev` = build + start: إعادة بناء api-server إجبارية عند كل تشغيل
# فيُفعَّل فوراً توقيع HMAC-SHA1 الصحيح ومسار الرفع /api/media/upload.
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
