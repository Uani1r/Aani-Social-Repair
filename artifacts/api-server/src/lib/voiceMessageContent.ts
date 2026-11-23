// تحليل محتوى الرسالة الصوتية من جهة الخادم (استخراج رابط ImageKit فقط).
// مستقِل عن وحدة العميل: الخادم لا يحتاج إلا الرابط القابل للحذف من ImageKit.

const VOICE_MESSAGE_PREFIX = "[aani-audio:v1]";

/**
 * يعيد رابط ImageKit لملف صوتي داخل /aani/، أو null لأي محتوى آخر.
 * الروابط القديمة على Supabase Storage تُعاد null عمداً: ليست في ImageKit
 * فلا هدف حذف لها هناك.
 */
export function parseVoiceMessageUrl(content: string): string | null {
  if (typeof content !== "string" || !content.startsWith(VOICE_MESSAGE_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(VOICE_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rawUrl = (parsed as Record<string, unknown>).url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/^(?:.*\.)?ik\.imagekit\.io$/i.test(url.hostname)) return null;

  // الرابط قد يبدأ بمعرّف endpoint الحساب: /<endpoint>/aani/... — نتحقق من
  // وجود /aani/ كامتداد لمجلد الرفع، لا من كونه أول مقطع في المسار.
  const segments = url.pathname.split("/").filter(Boolean);
  const aaniIndex = segments.indexOf("aani");
  if (aaniIndex < 0 || segments.length <= aaniIndex + 1) return null;

  return `${url.origin}${url.pathname}`;
}
