// تسجيل الدخول برقم الهاتف وكلمة مرور الحساب — بلا SMS وبلا OTP.
//
// المنطق كامل في _shared/phoneLoginFlow.ts بقابلات حقن (fetch/env)، ليُختبر
// بلا شبكة ولا مشروع Supabase. هذا الملف واجهة Deno فقط.

import { createLoginWithPhoneHandler } from "../_shared/phoneLoginFlow.ts";

Deno.serve(createLoginWithPhoneHandler({
  fetchImpl: fetch,
  env: (name: string) => Deno.env.get(name),
}));
