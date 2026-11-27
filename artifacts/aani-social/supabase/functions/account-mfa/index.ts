// حالة التحقق بخطوتين: تُشتق من عوامل Supabase Auth وتُكتب في app_metadata
// من الخادم فقط. المنطق في _shared/accountMfaState.ts ليُختبر بلا شبكة.

import { createMfaStateHandler } from "../_shared/accountMfaState.ts";

Deno.serve(createMfaStateHandler({
  fetchImpl: fetch,
  env: (name: string) => Deno.env.get(name),
}));
