/**
 * ظهور الإشعارات في القائمة العامة.
 *
 * أنواع إشعارات الرسائل والمكالمات القديمة كانت تُكتب في public.notifications
 * بواسطة النظام السابق (trigger الرسائل القديم: نوع 'message'، وقائمة الأنواع
 * الممنوعة في حارس 20261229000000: message/new_message/chat_message/call/
 * incoming_call/missed_call). هذه السجلات لا تظهر في قائمة الإشعارات العامة،
 * ولا تُحسب في شارة غير المقروء، ولا يعالجها Realtime — بينما تبقى الرسائل في
 * واجهة المحادثات والمكالمات في واجهة المكالمات كما هي.
 *
 * الإشعارات الاجتماعية (likes/comments/follows/stories/follow requests) لا
 * تُستبعد أبداً هنا.
 */

/** الأنواع القديمة الخاصة بالرسائل والمكالمات، من المخطط والترحيلات الفعلية. */
export const LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES = [
  'message',
  'new_message',
  'chat_message',
  'call',
  'incoming_call',
  'missed_call',
] as const;

const LEGACY_MESSAGE_CALL_NOTIFICATION_TYPE_SET = new Set<string>(LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES);

/**
 * قيمة فلتر PostgREST لاستبعاد الأنواع القديمة من الاستعلام نفسه:
 *   supabase.from('notifications').select(...).not('type', 'in', LEGACY_NOTIFICATION_TYPE_FILTER)
 * الاستبعاد في الاستعلام يمنع السجلات القديمة من استهلاك صفحات القائمة.
 */
export const LEGACY_NOTIFICATION_TYPE_FILTER =
  '("message","new_message","chat_message","call","incoming_call","missed_call")';

export function normalizeNotificationType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** هل هذا النوع من إشعارات الرسائل/المكالمات القديمة؟ */
export function isLegacyMessageCallNotification(type: unknown): boolean {
  return LEGACY_MESSAGE_CALL_NOTIFICATION_TYPE_SET.has(normalizeNotificationType(type));
}

/** هل يظهر هذا الإشعار في القائمة العامة؟ */
export function isVisibleNotification(notification: { type?: unknown } | null | undefined): boolean {
  return !isLegacyMessageCallNotification(notification?.type);
}

/** صفوف القائمة العامة فقط (استبعاد الرسائل والمكالمات القديمة). */
export function visibleNotifications<T extends { type?: unknown }>(rows: readonly T[]): T[] {
  return rows.filter(row => isVisibleNotification(row));
}

/** عدد غير المقروء الظاهر في الشارة: يستثني الأنواع القديمة. */
export function countUnreadVisibleNotifications<T extends { type?: unknown; is_read?: unknown }>(
  rows: readonly T[],
): number {
  return rows.reduce((total, row) => (
    isVisibleNotification(row) && row.is_read === false ? total + 1 : total
  ), 0);
}

/**
 * هل يعالج Realtime هذا الحدث؟ الأحداث القديمة تُهمل تماماً (لا إعادة جلب،
 * لا زيادة شارة، لا تنبيه منبثق)، فلا تعود إلى القائمة عبر مسار بديل.
 */
export function shouldHandleRealtimeNotification(type: unknown): boolean {
  return !isLegacyMessageCallNotification(type);
}
