#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="whvhxgfdumxzunzsjkll"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required. Install it, then run: supabase login" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
supabase functions deploy delete-account --project-ref "$PROJECT_REF"
supabase functions deploy update-account-phone --project-ref "$PROJECT_REF"
supabase functions deploy login-with-username --project-ref "$PROJECT_REF"
