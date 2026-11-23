// تجهيز عضوية المحادثة قبل الاشتراك في قناتها الخاصة.
//
// سبب وجودها: جدول العضوية aani_message_conversation_members يُكتب عبر trigger
// عند أول رسالة، ومحادثة فُتحت قبل إرسال أي رسالة لا سجل لها — فيُرفض الانضمام
// إلى موضوعها الخاص (Unauthorized) ولا يصل مؤشر الكتابة. هنا نستدعي RPC يتحقق
// من هوية الطرفين وقاعدة الحجب نفسها المطبَّقة في سياسة إرسال الرسائل، ويكتب
// السجل مرة واحدة (idempotent).
//
// لا تُخزَّن أي حالة في قاعدة البيانات هنا غير سجل العضوية نفسه، ولا تُوسَّع
// صلاحيات: القناة تبقى private: true والسياسات كما هي.

import { supabase, supabaseConfigured } from '@/lib/supabase';

/** مفتاح ثنائي مستقر بصرف النظر عن ترتيب الطرفين. */
export function messagesConversationMembershipKey(userId: string, contactId: string): string {
  return userId < contactId ? `${userId}:${contactId}` : `${contactId}:${userId}`;
}

/** تأخيرات إعادة محاولة الاشتراك: ثلاث محاولات محدودة ثم توقف. */
export const MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/** مهلة المحاولة التالية، أو null عند استنفاد المحاولات (لا حلقة لا نهائية). */
export function nextMessagesConversationChannelRetryDelay(
  attempt: number,
  delaysMs: readonly number[] = MESSAGES_CONVERSATION_CHANNEL_RETRY_DELAYS_MS,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < delaysMs.length ? delaysMs[attempt] : null;
}

/**
 * لا تُعاد المحاولة إلا على أخطاء اتصال قابلة للتعافي. `CLOSED` إغلاق مقصود،
 * و`Unauthorized` يصل كـ`CHANNEL_ERROR` فتُعاد المحاولة بعده محدوداً.
 */
export function isRetryableMessagesConversationChannelStatus(status: string): boolean {
  return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT';
}

const knownMembers = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();
let cacheOwner: string | null = null;

/** إفراغ الذاكرة المحلية للعضوية عند تبديل المستخدم أو الخروج. */
export function resetMessagesConversationMembershipCache(ownerId?: string | null): void {
  cacheOwner = ownerId || null;
  knownMembers.clear();
  inFlight.clear();
}

/**
 * هل سجل العضوية موجود ومؤكد لهذا الزوج؟ عند غيابه يستدعي RPC الكتابة الآمن،
 * ويُخزّن النتيجة الناجحة فقط. فشل الاستدعاء يعني: لا اشتراك في القناة الخاصة
 * الآن (الرسائل تبقى تعمل عبر REST)، ولا تكرار محاولات بلا داعٍ.
 */
export async function ensureMessagesConversationMembership(
  userId: string,
  contactId: string,
): Promise<boolean> {
  if (!supabaseConfigured || !userId || !contactId || userId === contactId) return false;

  if (cacheOwner !== userId) {
    resetMessagesConversationMembershipCache(userId);
  }

  const key = messagesConversationMembershipKey(userId, contactId);
  if (knownMembers.has(key)) return true;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<boolean> => {
    try {
      const { data, error } = await supabase.rpc('aani_ensure_message_conversation_member', {
        p_other_user_id: contactId,
      });
      if (error) throw error;
      if (data !== true) return false;
      knownMembers.add(key);
      return true;
    } catch {
      // لا نطبع تفاصيل الخطأ: قد تحمل معرّفات. القناة تبقى غير مشتركة بأمان.
      console.warn('[messages] تعذر تجهيز عضوية المحادثة قبل الاشتراك في قناتها.');
      return false;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}
