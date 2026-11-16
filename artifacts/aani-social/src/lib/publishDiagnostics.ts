// تشخيص فشل نشر المنشورات — مخزن مستقل يُعرض في الإنتاج.
//
// الغرض: عند تعطّل النشر تظهر للمستخدم رسالة عامة، وتُخفي نسخة الإنتاج التفاصيل
// التقنية. هذا المخزن يحتفظ بآخر حالات الفشل كاملة (المرحلة، رمز الخطأ، الرسالة،
// details، hint) ليعرضها في لوحة قابلة للفتح مع زر نسخ — بلا أسرار: كل نص يمر
// عبر redactSecrets قبل التخزين.
//
// لا يغيّر أي منطق نشر: يُسجّل ما حدث فقط.

import { redactSecrets, redactValue } from '@/lib/errorRedaction';
import { isImageKitSigningEnabled } from '@/lib/mediaAccess';

/**
 * مرحلة النشر. التمييز بين «رفع الوسائط إلى ImageKit» و«حفظ المنشور في Supabase»
 * هو الفرق الجوهري في التشخيص: الأول فشل تخزين ملفات، والثاني رفض صف في القاعدة.
 */
export type PublishPhase =
  | 'بدء النشر'
  | 'التحقق من جلسة الحساب'
  | 'إيقاظ الخادم وفحص الجاهزية'
  | 'رفع الوسائط إلى ImageKit'
  | 'إنشاء سجل media_assets'
  | 'استخراج الصوت وربط سجل الأصوات'
  | 'حفظ المنشور في Supabase (posts.upsert)'
  | 'معالجة الفيديو بعد الحفظ'
  | 'التحقق من الصف المحفوظ';

/** هل هذه المرحلة فشل رفع وسائط (ImageKit) أم فشل كتابة في Supabase؟ */
export type PublishFailureKind = 'imagekit-upload' | 'supabase-write' | 'unknown';

export interface PublishFailureEntry {
  id: string;
  at: number;
  /** المرحلة التي كان النشر فيها لحظة الفشل */
  phase: PublishPhase;
  kind: PublishFailureKind;
  /** رمز الخطأ كما أعاده Supabase/PostgREST (PGRST204، 42501، 23514…) أو HTTP n */
  code: string;
  message: string;
  details: string;
  hint: string;
  /** رسالة مختصرة للعرض في التنبيه */
  userMessage: string;
  /** هل انتهت مهلة النشر (90 ثانية) بدل رفض صريح؟ */
  timedOut: boolean;
  /** هل كان توقيع ImageKit مفعّلاً في هذه النسخة؟ */
  signingEnabled: boolean;
}

const MAX_FAILURES = 10;

const failures: PublishFailureEntry[] = [];
const listeners = new Set<(entries: PublishFailureEntry[]) => void>();
let panelListeners = new Set<(open: boolean) => void>();
let sequence = 0;

const UPLOAD_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'رفع الوسائط إلى ImageKit',
  'استخراج الصوت وربط سجل الأصوات',
]);

const WRITE_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'حفظ المنشور في Supabase (posts.upsert)',
  'إنشاء سجل media_assets',
  'التحقق من الصف المحفوظ',
]);

/** تصنيف المرحلة: رفع ImageKit أم كتابة Supabase. */
export function classifyPublishPhase(phase: PublishPhase): PublishFailureKind {
  if (UPLOAD_PHASES.has(phase)) return 'imagekit-upload';
  if (WRITE_PHASES.has(phase)) return 'supabase-write';
  return 'unknown';
}

export function describePublishKind(kind: PublishFailureKind): string {
  if (kind === 'imagekit-upload') return 'فشل رفع الوسائط إلى ImageKit (تخزين الملفات)';
  if (kind === 'supabase-write') return 'فشل كتابة المنشور في Supabase (قاعدة البيانات)';
  return 'فشل قبل مرحلة الرفع أو الحفظ (جلسة/شبكة/خادم)';
}

/** يستخرج حقول الخطأ من أي شكل: Supabase PostgrestError، Error، نص، أو خطأ HTTP. */
export function readErrorFields(error: unknown): { code: string; message: string; details: string; hint: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const rawCode = record.code ?? record.status ?? record.error_code;
    const code = typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? `HTTP ${rawCode}` : '';
    const message = typeof record.message === 'string' ? record.message : '';
    const details = typeof record.details === 'string' ? record.details : '';
    const hint = typeof record.hint === 'string' ? record.hint : '';
    if (message || code || details || hint) {
      return {
        code: redactSecrets(code),
        message: redactSecrets(message),
        details: redactSecrets(details),
        hint: redactSecrets(hint),
      };
    }
    if (error instanceof Error) {
      return { code: redactSecrets(error.name || ''), message: redactSecrets(error.message || ''), details: '', hint: '' };
    }
  }
  if (typeof error === 'string') {
    return { code: '', message: redactSecrets(error), details: '', hint: '' };
  }
  const fallback = redactValue(error);
  return { code: '', message: fallback, details: '', hint: '' };
}

function emit(): void {
  const snapshot = [...failures].reverse(); // الأحدث أولاً
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // مستمع معطوب لا يوقف الآخرين
    }
  }
}

/** تسجيل فشل نشر. لا يفشل أبداً ولا يرمي. */
export function reportPublishFailure(input: {
  phase: PublishPhase;
  error?: unknown;
  userMessage?: string;
  timedOut?: boolean;
}): void {
  try {
    const fields = readErrorFields(input.error);
    const entry: PublishFailureEntry = {
      id: `pub-${Date.now()}-${(sequence += 1)}`,
      at: Date.now(),
      phase: input.phase,
      kind: classifyPublishPhase(input.phase),
      code: fields.code || (input.timedOut ? 'TIMEOUT' : 'غير مصنَّف'),
      message: fields.message || (input.timedOut ? 'انتهت مهلة النشر قبل اكتمال الرفع أو الحفظ.' : 'خطأ بلا رسالة'),
      details: fields.details,
      hint: fields.hint,
      userMessage: redactSecrets(input.userMessage || ''),
      timedOut: Boolean(input.timedOut),
      signingEnabled: isImageKitSigningEnabled(),
    };
    failures.push(entry);
    if (failures.length > MAX_FAILURES) failures.shift();
    emit();
  } catch {
    // التشخيص لا يفشل التطبيق
  }
}

export function getPublishFailures(): PublishFailureEntry[] {
  return [...failures].reverse();
}

export function clearPublishFailures(): void {
  failures.length = 0;
  emit();
}

export function subscribePublishFailures(listener: (entries: PublishFailureEntry[]) => void): () => void {
  listeners.add(listener);
  listener([...failures].reverse());
  return () => {
    listeners.delete(listener);
  };
}

export function openPublishErrorPanel(): void {
  for (const listener of panelListeners) {
    try {
      listener(true);
    } catch {
      // صامت
    }
  }
}

export function closePublishErrorPanel(): void {
  for (const listener of panelListeners) {
    try {
      listener(false);
    } catch {
      // صامت
    }
  }
}

export function subscribePublishPanelOpen(listener: (open: boolean) => void): () => void {
  panelListeners.add(listener);
  return () => {
    panelListeners.delete(listener);
  };
}

/** تقرير نصي جاهز للنسخ — بلا أسرار، ومقروء لصقاً في دردشة الدعم. */
export function buildPublishFailureReport(entries: PublishFailureEntry[] = getPublishFailures()): string {
  const lines: string[] = [];
  lines.push('تقرير فشل نشر المنشور — آني');
  lines.push(`توقيع ImageKit مفعّل: ${isImageKitSigningEnabled() ? 'نعم (VITE_IMAGEKIT_SIGNED_URLS=true)' : 'لا'}`);
  lines.push(`عدد المحاولات الفاشلة المسجلة: ${entries.length}`);
  for (const entry of entries) {
    lines.push('———————————————');
    lines.push(`الوقت: ${new Date(entry.at).toLocaleString('ar')}`);
    lines.push(`المرحلة: ${entry.phase}`);
    lines.push(`التصنيف: ${describePublishKind(entry.kind)}`);
    lines.push(`code: ${entry.code}`);
    lines.push(`message: ${entry.message}`);
    if (entry.details) lines.push(`details: ${entry.details}`);
    if (entry.hint) lines.push(`hint: ${entry.hint}`);
    if (entry.userMessage) lines.push(`رسالة الواجهة: ${entry.userMessage}`);
    if (entry.timedOut) lines.push('ملاحظة: انتهت مهلة النشر (90 ثانية) ولم يصل رد.');
  }
  if (entries.length === 0) lines.push('لا يوجد فشل نشر مسجل في هذه الجلسة.');
  try {
    lines.push(`المتصفح: ${redactSecrets(navigator.userAgent.slice(0, 160))}`);
  } catch {
    // غير متاح
  }
  return lines.join('\n');
}
