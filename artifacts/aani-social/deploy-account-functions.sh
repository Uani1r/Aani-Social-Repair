#!/usr/bin/env bash
# نشر دالتي رقم الدخول بالهاتف فقط، إلى المشروع الصحيح وحده.
#
# لا يُنشر أي شيء آخر من هنا: delete-account وlogin-with-username لهما مسارهما
# المستقل، ولا تُعاد نشر دالة غير مرتبطة بهذه المهمة.
#
# حمايات:
# - المشروع مكتوب صريحاً أدناه، وأي وجهة مختلفة توقف السكربت قبل أي نشر.
# - Supabase CLI مطلوب، ويجب أن يكون مسجّلاً (supabase login).
# - المشروع المرتبط محلياً (supabase/.temp/project-ref، إن وُجد) يجب أن يطابق.
# - SUPABASE_PROJECT_REF، إن كان مضبوطاً، يجب أن يطابق القيمة نفسها.
# - لا تُنفَّذ أي أوامر نشر تلقائياً: هذا الملف لا يشغّل نفسه.
set -euo pipefail

# المشروع الصحيح الوحيد لهذه الدوال.
readonly PROJECT_REF="auqqqwfjxrxizlmeweka"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "أُوقف النشر: $1" >&2
  exit 1
}

if [[ -z "${PROJECT_REF}" || "${PROJECT_REF}" != "auqqqwfjxrxizlmeweka" ]]; then
  fail "Project Ref غير مطابق للمشروع الصحيح."
fi

if [[ -n "${SUPABASE_PROJECT_REF:-}" && "${SUPABASE_PROJECT_REF}" != "${PROJECT_REF}" ]]; then
  fail "SUPABASE_PROJECT_REF لا يطابق المشروع الصحيح."
fi

if ! command -v supabase >/dev/null 2>&1; then
  fail "Supabase CLI غير مثبت. ثبّته ثم نفّذ: supabase login"
fi

LINKED_PROJECT_REF=""
if [[ -f "${SCRIPT_DIR}/supabase/.temp/project-ref" ]]; then
  LINKED_PROJECT_REF="$(tr -d '[:space:]' < "${SCRIPT_DIR}/supabase/.temp/project-ref")"
fi
if [[ -n "${LINKED_PROJECT_REF}" && "${LINKED_PROJECT_REF}" != "${PROJECT_REF}" ]]; then
  fail "المشروع المرتبط محلياً (${LINKED_PROJECT_REF}) ليس المشروع الصحيح."
fi

cd "${SCRIPT_DIR}"

# دالتان فقط، كل واحدة بأمرها الصريح.
echo "نشر account-phone-alias إلى ${PROJECT_REF}..."
supabase functions deploy account-phone-alias --project-ref "${PROJECT_REF}"

echo "نشر login-with-phone إلى ${PROJECT_REF}..."
supabase functions deploy login-with-phone --project-ref "${PROJECT_REF}"
