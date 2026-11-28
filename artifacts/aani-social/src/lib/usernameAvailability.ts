/**
 * توفر اسم المستخدم من الخادم وحده.
 *
 * الواجهة لا تقرر أن اسماً متاح: تسأل الدالة `aani_username_status` (التي
 * تقرأ سجل الأسماء `username_registry` و`profiles` بصلاحية موثوقة) وتعرض ما
 * تعيده. أي غياب للجواب (شبكة، دالة غير مثبتة، قيمة غير مفهومة) يعني
 * `unknown` وليس `available`، فلا يُطمئن المستخدم إلى اسم قد يُرفض عند الحفظ.
 *
 * الحجز والمنع لا يُفحصان هنا فقط: المشغّل والدوال في قاعدة البيانات يرفضان
 * الاسم المحجوز/الممنوع/المأخوذ حتى لو تخطّى العميل هذه الدالة أو نادى REST
 * مباشرة.
 */

import { supabase } from '@/lib/supabase';
import {
  isUsernameRegistryState,
  isUsernameSelectable,
  usernameStateMessage,
  validateUsername,
  USERNAME_MESSAGES,
  type UsernameRegistryState,
} from '@/lib/usernameRules';

type RpcResponse = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

export type UsernameAvailabilityClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResponse>;
};

const supabaseRpc: UsernameAvailabilityClient['rpc'] = (fn, args) =>
  (supabase.rpc as unknown as UsernameAvailabilityClient['rpc'])(fn, args);

export type UsernameAvailability = {
  /** الاسم بعد التطبيع، أو فارغاً إذا كان الإدخال غير صالح. */
  username: string;
  state: UsernameRegistryState;
  /** هل يمكن المطالبة بالاسم؟ لا شيء غير `available`/`self`. */
  available: boolean;
  /** هل جاء الجواب من الخادم فعلاً؟ */
  verified: boolean;
  message: string;
};

const unverified = (username: string, message: string): UsernameAvailability => ({
  username,
  state: 'unknown',
  available: false,
  verified: false,
  message,
});

/**
 * يقرأ الحالة من استجابة الدالة: صف مفرد أو مصفوفة صفوف أو نص.
 * أي شكل آخر → unknown.
 */
export function parseUsernameStatePayload(data: unknown): UsernameRegistryState {
  const read = (value: unknown): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as { status?: unknown; state?: unknown };
      return row.status ?? row.state;
    }
    return value;
  };

  const first = Array.isArray(data) ? data[0] : data;
  const value = read(first);
  return isUsernameRegistryState(value) ? value : 'unknown';
}

/**
 * فحص توفر الاسم. يفشل مغلقاً: كل شك يعني `available: false`.
 * القيم المقبولة: a، 7، ab، 12، 123، أرقام فقط، حروف فقط، مختلط.
 */
export async function checkUsernameAvailability(
  raw: string,
  client?: UsernameAvailabilityClient,
): Promise<UsernameAvailability> {
  const validation = validateUsername(raw);
  if (!validation.ok) {
    // إدخال غير صالح لا يستهلك طلباً على الخادم.
    return unverified('', validation.message);
  }

  const rpc = client?.rpc ?? supabaseRpc;

  try {
    const { data, error } = await rpc('aani_username_status', { p_username: validation.username });
    if (error) {
      const code = String(error.code ?? '');
      if (code !== '42883' && code !== 'PGRST202') {
        console.warn('[username] تعذر التحقق من توفر الاسم:', error.message || code);
      }
      return unverified(validation.username, USERNAME_MESSAGES.checkUnavailable);
    }

    const state = parseUsernameStatePayload(data);
    return {
      username: validation.username,
      state,
      available: isUsernameSelectable(state),
      verified: state !== 'unknown',
      message: usernameStateMessage(state),
    };
  } catch (error) {
    console.warn('[username] فشل طلب توفر الاسم:', error);
    return unverified(validation.username, USERNAME_MESSAGES.checkUnavailable);
  }
}
