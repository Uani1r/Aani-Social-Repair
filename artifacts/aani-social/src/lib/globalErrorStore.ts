// نظام تشخيص الأخطاء الشامل (Global Error Diagnostics) — وحدة مستقلة تماماً.
//
// يجمع من كل شاشات التطبيق (القصص، المشاهدات والإعجابات، المنشورات، الريلز،
// المحادثات، الملف الشخصي، الإشعارات، المصادقة):
//   - أخطاء استعلامات Supabase والدوال RPC (عبر طبقة رصد الشبكة في
//     mediaDiagnostics التي تستدعي pushGlobalError)
//   - فشل طلبات /api/*
//   - الأخطاء غير المعالجة (window.onerror / unhandledrejection)
// ويحتفظ بآخر 20 خطأاً بكل تفاصيلها التقنية:
//   الشاشة/المكوّن، الجدول/الدالة/الرابط، رمز الخطأ الدقيق
//   (PGRST*, 42703, 42501, HTTP…)، الرسالة الكاملة، details/hint،
//   ختم إصدار الواجهة والخادم والوقت الدقيق.
// بلا أي أسرار: لا مفاتيح ولا توكنات ولا تواقيع.

export interface GlobalErrorEntry {
  id: string;
  at: number;
  /** الشاشة أو المكوّن الذي فشل فيه (StoryViewersSheet, CreatePostModal…) */
  screen: string;
  /** الجدول أو الدالة أو الرابط المستهدف */
  target: string;
  /** رمز الخطأ الدقيق (PGRST200 / 42703 / 42501 / HTTP 502 …) */
  code: string;
  message: string;
  details?: string;
  hint?: string;
  clientStamp: string;
  serverVersion: string | null;
}

const MAX_ERRORS = 20;

const errors: GlobalErrorEntry[] = [];
const errorListeners = new Set<(entry: GlobalErrorEntry) => void>();
const panelListeners = new Set<(open: boolean) => void>();
let panelOpen = false;
let captureInstalled = false;

let clientStamp = 'unknown';
export function setGlobalErrorClientStamp(stamp: string): void {
  try {
    clientStamp = stamp;
  } catch {
    // صامت
  }
}

let serverVersion: string | null = null;
export function setGlobalErrorServerVersion(version: string | null): void {
  if (typeof version === 'string' && version) serverVersion = version;
}
export function getGlobalErrorServerVersion(): string | null {
  return serverVersion;
}

let counter = 0;

/** استخراج رمز الخطأ الدقيق من أي شكل خطأ (PostgREST / Postgres / HTTP) */
export function extractErrorCode(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    const code = record.code ?? record.error_code ?? record.status;
    if (typeof code === 'string' && code) return code;
    if (typeof code === 'number') return `HTTP ${code}`;
  }
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
  const pgrst = text.match(/\bPGRST\d+\b/);
  if (pgrst) return pgrst[0];
  const pg = text.match(/\b(42501|42703|42P01|42883|22023|23514|23503|23505)\b/);
  if (pg) return pg[1];
  const http = text.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) return `HTTP ${http[1]}`;
  return 'غير مصنَّف';
}

export function pushGlobalError(input: {
  screen: string;
  target: string;
  error?: unknown;
  message?: string;
  details?: string;
  hint?: string;
}): void {
  try {
    const rawMessage = input.message
      || (input.error instanceof Error ? input.error.message : typeof input.error === 'string' ? input.error : '');
    const rawDetails = input.details
      || (typeof (input.error as { details?: unknown } | undefined)?.details === 'string'
        ? String((input.error as { details?: unknown }).details)
        : '');
    const rawHint = input.hint
      || (typeof (input.error as { hint?: unknown } | undefined)?.hint === 'string'
        ? String((input.error as { hint?: unknown }).hint)
        : '');

    const entry: GlobalErrorEntry = {
      id: `err-${Date.now()}-${counter += 1}`,
      at: Date.now(),
      screen: input.screen,
      target: input.target,
      code: extractErrorCode(input.error ?? rawMessage),
      message: rawMessage || 'خطأ غير مُعرَّف',
      details: rawDetails || undefined,
      hint: rawHint || undefined,
      clientStamp,
      serverVersion,
    };

    errors.push(entry);
    if (errors.length > MAX_ERRORS) errors.shift();

    for (const listener of errorListeners) {
      try {
        listener(entry);
      } catch {
        // مستمع معطوب لا يوقف الآخرين
      }
    }
  } catch {
    // التشخيص لا يفشل التطبيق أبداً
  }
}

export function getGlobalErrors(): readonly GlobalErrorEntry[] {
  return [...errors].reverse(); // الأحدث أولاً
}

export function clearGlobalErrors(): void {
  errors.length = 0;
}

export function subscribeGlobalErrors(listener: (entry: GlobalErrorEntry) => void): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

export function openGlobalErrorPanel(): void {
  panelOpen = true;
  for (const listener of panelListeners) {
    try {
      listener(true);
    } catch {
      // صامت
    }
  }
}

export function closeGlobalErrorPanel(): void {
  panelOpen = false;
  for (const listener of panelListeners) {
    try {
      listener(false);
    } catch {
      // صامت
    }
  }
}

export function subscribePanelOpen(listener: (open: boolean) => void): () => void {
  panelListeners.add(listener);
  return () => {
    panelListeners.delete(listener);
  };
}

/** تقرير كامل جاهز للصق في دردشة الذكاء الاصطناعي — بلا أسرار */
export function buildFullErrorReport(): string {
  const lines: string[] = [];
  lines.push('تقرير أخطاء آني الشامل — كامل');
  lines.push(`ختم الواجهة: ${clientStamp}`);
  lines.push(`إصدار الخادم: ${serverVersion || 'غير معروف'}`);
  lines.push(`عدد الأخطاء المسجلة: ${errors.length}`);
  for (const entry of errors) {
    lines.push('———————————————');
    lines.push(`الوقت: ${new Date(entry.at).toLocaleString('ar')}`);
    lines.push(`الشاشة: ${entry.screen}`);
    lines.push(`الهدف: ${entry.target}`);
    lines.push(`الرمز: ${entry.code}`);
    lines.push(`الرسالة: ${entry.message}`);
    if (entry.details) lines.push(`التفاصيل: ${entry.details}`);
    if (entry.hint) lines.push(`التلميح: ${entry.hint}`);
  }
  if (errors.length === 0) lines.push('لا توجد أخطاء مسجلة في هذه الجلسة.');
  try {
    lines.push(`المتصفح: ${navigator.userAgent.slice(0, 160)}`);
  } catch {
    // غير متاح
  }
  return lines.join('\n');
}

/** تفعيل رصد الأخطاء غير المعالجة — مرة واحدة من App */
export function installGlobalErrorCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  const isMaskedExternal = (message: string | undefined, filename: string | undefined): boolean => {
    if (/^script error\.?$/i.test(message || '')) return true;
    if (!filename) return false;
    try {
      return new URL(filename, window.location.href).origin !== window.location.origin;
    } catch {
      return false;
    }
  };

  try {
    window.addEventListener('error', event => {
      // «Script error.» بلا كائن خطأ = خطأ من سكربت خارجي عبر المصادر
      // (سكربتات Replit المحقونة في المعاينة مثلاً). يُسجَّل مميَّزاً كخطأ
      // خارجي غير معطِّل، ولا يُعرض كخطأ داخلي من التطبيق.
      const maskedExternal = !event.error && isMaskedExternal(event.message, event.filename);
      pushGlobalError({
        screen: maskedExternal
          ? 'خطأ خارجي (سكربت خارجي عبر المصادر — غير معطِّل)'
          : 'خطأ غير معالج في التطبيق',
        target: event.filename || '(داخلي)',
        error: event.error,
        message: maskedExternal
          ? 'Script error. (مُجهَّل المصدر — لا تفاصيل متاحة له من المتصفح)'
          : event.message,
      });
    });
    window.addEventListener('unhandledrejection', event => {
      pushGlobalError({
        screen: 'عملية غير مكتملة (Promise)',
        target: '(داخلي)',
        error: event.reason,
      });
    });
  } catch {
    // الرصد لا يفشل التطبيق أبداً
  }
}
