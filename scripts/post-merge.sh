#!/bin/bash
set -e
# pnpm install بلا --frozen-lockfile حتى لا يفشل الدمج إذا احتاج ملف القفل تحديثاً بعد سحب حزم جديدة.
pnpm install
pnpm --filter db push
