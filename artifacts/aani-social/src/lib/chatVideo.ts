// رسائل فيديو المحادثة: الحمولة، حدود الإرسال، والقياسات — وحدة خالصة.
//
// - الترميز: [aani-chat-video:v1]{url,durationMs,posterUrl,caption,viewOnce,width,height}.
// - الحدود الحالية: 60 ثانية و25MB (بالثانية العشرية) قبل أي رفع.
// - لا يُنشأ صوت وهمي ولا يُدَّعى وجوده: hasAudio كما قيس فعلاً قبل/بعد.
//
// خالصة (بلا React ولا وسائط) لتُختبر مباشرة في Node.

export const CHAT_VIDEO_MESSAGE_PREFIX = '[aani-chat-video:v1]';
export const CHAT_VIDEO_MAX_DURATION_MS = 60_000;
export const CHAT_VIDEO_MAX_BYTES = 25 * 1000 * 1000;

export interface ChatVideoPayload {
  url: string;
  durationMs: number;
  posterUrl: string | null;
  caption: string;
  viewOnce: boolean;
  width: number;
  height: number;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** يحلّل محتوى رسالة فيديو؛ أي بيانات مشوهة أو رابط غير صالح → null. */
export function parseChatVideoMessage(content: string): ChatVideoPayload | null {
  if (typeof content !== 'string' || !content.startsWith(CHAT_VIDEO_MESSAGE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(CHAT_VIDEO_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const url = readHttpUrl(value.url);
  if (!url) return null;
  return {
    url,
    durationMs: Math.min(CHAT_VIDEO_MAX_DURATION_MS, readNumber(value.durationMs)),
    posterUrl: readHttpUrl(value.posterUrl),
    caption: typeof value.caption === 'string' ? value.caption : '',
    viewOnce: value.viewOnce === true,
    width: readNumber(value.width),
    height: readNumber(value.height),
  };
}

export function chatVideoMessageContent(payload: ChatVideoPayload): string {
  return `${CHAT_VIDEO_MESSAGE_PREFIX}${JSON.stringify({
    url: payload.url,
    durationMs: Math.max(0, Math.round(payload.durationMs)),
    posterUrl: payload.posterUrl,
    caption: payload.caption,
    viewOnce: payload.viewOnce,
    width: Math.round(payload.width),
    height: Math.round(payload.height),
  })}`;
}

export type ChatVideoRejectReason =
  | 'not-a-video'
  | 'too-long'
  | 'too-large'
  | 'compression-failed'
  | 'audio-lost';

/** رسالة عربية واضحة تُعرض للمستخدم بدل إخفاق صامت أو رفع الملف الأصلي. */
export function chatVideoRejectMessage(reason: ChatVideoRejectReason, detail?: string): string {
  switch (reason) {
    case 'not-a-video':
      return 'الملف المختار ليس فيديو. اختر مقطع فيديو من الجهاز.';
    case 'too-long':
      return `مدة المقطع تتجاوز ${Math.round(CHAT_VIDEO_MAX_DURATION_MS / 1000)} ثانية. اختر مقطعاً أقصر — لم يُرفع أي ملف.`;
    case 'too-large':
      return `حجم المقطع يتجاوز ${Math.round(CHAT_VIDEO_MAX_BYTES / 1000 / 1000)} ميغابايت. اختر مقطعاً أصغر — لم يُرفع أي ملف.`;
    case 'audio-lost':
      return 'تعذر الحفاظ على صوت المقطع أثناء الضغط. لم يُرفع فيديو صامت. جرّب مقطعاً آخر أو أعد المحاولة.';
    default:
      return `تعذر ضغط المقطع على هذا الجهاز${detail ? ` (${detail})` : ''}. لم يُرفع الملف الأصلي بصمت — جرّب مقطعاً أقصر أو متصفحاً حديثاً.`;
  }
}

/**
 * حدود الإرسال الحالية قبل أي محاولة رفع: 60 ثانية و25MB.
 * مدة مجهولة (0) لا تُرفض هنا — تُقاس بعد التحليل؛ الحجم يُفحص دائماً.
 */
export function checkChatVideoLimits(input: {
  durationSeconds: number;
  sizeBytes: number;
}): ChatVideoRejectReason | null {
  if (input.durationSeconds > 0 && input.durationSeconds * 1000 > CHAT_VIDEO_MAX_DURATION_MS) {
    return 'too-long';
  }
  if (input.sizeBytes > CHAT_VIDEO_MAX_BYTES) return 'too-large';
  return null;
}

export interface ChatVideoMetrics {
  originalBytes: number;
  finalBytes: number;
  savingPct: number;
  processingMs: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudioBefore: boolean;
  hasAudioAfter: boolean;
}

/** قياس واحد من أرقام حقيقية فقط (بلا روابط ولا بيانات حساسة). */
export function buildChatVideoMetrics(input: {
  originalBytes: number;
  finalBytes: number;
  processingMs?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudioBefore?: boolean;
  hasAudioAfter?: boolean;
}): ChatVideoMetrics {
  const originalBytes = readNumber(input.originalBytes);
  const finalBytes = readNumber(input.finalBytes);
  return {
    originalBytes,
    finalBytes,
    savingPct: originalBytes > 0
      ? Math.round(((originalBytes - finalBytes) / originalBytes) * 1000) / 10
      : 0,
    processingMs: readNumber(input.processingMs),
    durationSeconds: readNumber(input.durationSeconds),
    width: Math.round(readNumber(input.width)),
    height: Math.round(readNumber(input.height)),
    fps: Math.round(readNumber(input.fps) * 100) / 100,
    hasAudioBefore: input.hasAudioBefore === true,
    hasAudioAfter: input.hasAudioAfter === true,
  };
}

/** نص تقرير واحد قابل للمراجعة بعد إغلاق الصفحة (Console وحده يضيع). */
export function describeChatVideoMetrics(metrics: ChatVideoMetrics): string {
  return `فيديو المحادثة: ${metrics.originalBytes}→${metrics.finalBytes}B `
    + `(${metrics.savingPct}% توفير) في ${metrics.processingMs}ms — `
    + `${metrics.width}×${metrics.height}@${metrics.fps || '?'}fps، `
    + `الصوت ${metrics.hasAudioBefore ? 'موجود' : 'غائب'}→${metrics.hasAudioAfter ? 'موجود' : 'غائب'}`;
}
