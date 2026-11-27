// تسجيل الدخول باسم المستخدم وكلمة المرور — بحماية CAPTCHA ومحدّد محاولات
// مشترك. المنطق كامل في _shared/usernameLoginFlow.ts بقابلات حقن (fetch/env)،
// ليُختبر بلا شبكة ولا مشروع Supabase. هذا الملف واجهة Deno فقط.

import { createUsernameLoginHandler } from "../_shared/usernameLoginFlow.ts";

Deno.serve(createUsernameLoginHandler({
  fetchImpl: fetch,
  env: (name: string) => Deno.env.get(name),
}));
