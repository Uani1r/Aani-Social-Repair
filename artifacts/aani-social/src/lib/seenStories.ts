// مصدر واحد لمفتاح "القصص المشاهدة" في التخزين المحلي ولحدث تغييره،
// كي تتزامن حلقة شريط القصص مع حلقة صور المحادثات في شاشة الرسائل.
export const SEEN_STORY_IDS_STORAGE_PREFIX = 'aani:seen-story-ids:';
export const SEEN_STORY_IDS_CHANGED_EVENT = 'aani:seen-story-ids-changed';

export const seenStoryStorageKey = (userId: string) => `${SEEN_STORY_IDS_STORAGE_PREFIX}${userId}`;

/** معرّفات القصص التي شاهدها المستخدم على هذا الجهاز. */
export function readSeenStoryIds(userId: string): Set<string> {
  if (typeof window === 'undefined' || !userId) return new Set();
  try {
    const raw = localStorage.getItem(seenStoryStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export function writeSeenStoryIds(userId: string, storyIds: string[]): void {
  if (typeof window === 'undefined' || !userId) return;
  try {
    localStorage.setItem(seenStoryStorageKey(userId), JSON.stringify(storyIds));
  } catch {
    /* التخزين المحلي غير متاح أو ممتلئ */
  }
}

/** يُبلّغ بقية الشاشات (الرسائل) لتحديث حلقات القصص دون إعادة تحميل الشبكة. */
export function notifySeenStoryIdsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SEEN_STORY_IDS_CHANGED_EVENT));
}
