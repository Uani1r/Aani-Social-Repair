// حذف الحساب نهائياً: الهوية من الجلسة، وحذف Auth عبر Admin API، والوسائط
// عبر طابور الحذف الذي تُدرجه مشغّلات قاعدة البيانات. لا bucket ولا حذف ملفات
// من هنا. المنطق في _shared/accountDeletion.ts ليُختبر بلا شبكة.

import { createDeleteAccountHandler } from "../_shared/accountDeletion.ts";

Deno.serve(createDeleteAccountHandler({
  fetchImpl: fetch,
  env: (name: string) => Deno.env.get(name),
}));
