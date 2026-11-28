/**
 * وصول إلى عميل Supabase لوحدة الحسابات الأساسية.
 *
 * يفضّل العميل المُعدّ في '@/lib/supabase' (عميل المتصفح المشترك مع المصادقة).
 * تُسمح بحقن عميل مخصص عبر setCoreAccountsSupabaseClient للاختبارات أو لبيئات
 * لا يتوفر فيها العميل المشترك، دون تعديل src/lib/supabase نفسه.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

let customClient: SupabaseClient | null = null;

/** حقن عميل مخصص (يُستخدم في الاختبارات أو عند عدم توفر العميل المشترك). */
export function setCoreAccountsSupabaseClient(client: SupabaseClient | null): void {
  customClient = client;
}

/** إرجاع العميل المخصص إذا وُجد، وإلا العميل المشترك من '@/lib/supabase'. */
export function getCoreAccountsSupabaseClient(): SupabaseClient | null {
  if (customClient) return customClient;
  try {
    // يتم استيراد العميل المشترك بشكل كسول لتجنب كسر الوحدة في بيئات
    // لا تحتوي على '@/lib/supabase'.
    const { supabase } = require('@/lib/supabase');
    return supabase ?? null;
  } catch {
    return null;
  }
}
