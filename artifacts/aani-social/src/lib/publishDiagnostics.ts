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
 * مرحلة النشر.
 *
 * المراحل الثلاث داخل خطوة الرفع مفصولة عمداً، لأن خلطها يجعل التشخيص مضلِّلاً:
 *   - «ضغط وتجهيز الملف»: عمل محلي في المتصفح (Canvas/mediabunny). فشله ليس
 *     فشل ImageKit ولا فشل شبكة — ملف غير مدعوم أو ذاكرة غير كافية.
 *   - «جلب توقيع الرفع من الخادم»: طلب إلى /api/media/imagekit-auth على خادمنا
 *     (يحتاج IMAGEKIT_PUBLIC_KEY/PRIVATE_KEY وجلسة صالحة). فشله فشل خدمتنا، لا
 *     رفض من ImageKit.
 *   - «الرفع الفعلي إلى ImageKit»: طلب XHR إلى upload.imagekit.io بعد الحصول على
 *     التوقيع. هنا فقط يُنسب الفشل إلى ImageKit.
 *
 * والتمييز بين «رفع الوسائط» و«حفظ المنشور في Supabase» هو الفرق الجوهري الآخر:
 * الأول فشل تخزين ملفات، والثاني رفض صف في القاعدة.
 */
export type PublishPhase =
  | 'بدء النشر'
  | 'التحقق من جلسة الحساب'
  | 'إيقاظ الخادم وفحص الجاهزية'
  | 'ضغط وتجهيز الملف'
  | 'جلب توقيع الرفع من الخادم'
  | 'الرفع الفعلي إلى ImageKit'
  | 'إنشاء سجل media_assets'
  | 'استخراج الصوت وربط سجل الأصوات'
  | 'حفظ المنشور في Supabase (posts.upsert)'
  | 'معالجة الفيديو بعد الحفظ'
  | 'التحقق من الصف المحفوظ';

/**
 * تصنيف الفشل:
 *   imagekit-upload  — رفض/انقطاع من ImageKit نفسه (XHR الرفع)
 *   upload-signature — فشل نقطة التوقيع على خادمنا قبل أي إرسال إلى ImageKit
 *   media-prepare    — فشل محلي في الضغط/التجهيز قبل الشبكة
 *   supabase-write   — رفض صف/قراءة في قاعدة البيانات
 *   unknown          — جلسة/شبكة/إيقاظ خادم أو مرحلة غير مصنَّفة
 */
export type PublishFailureKind =
  | 'imagekit-upload'
  | 'upload-signature'
  | 'media-prepare'
  | 'supabase-write'
  | 'unknown';

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

const IMAGEKIT_UPLOAD_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'الرفع الفعلي إلى ImageKit',
]);

const SIGNATURE_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'جلب توقيع الرفع من الخادم',
]);

const PREPARE_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'ضغط وتجهيز الملف',
  'استخراج الصوت وربط سجل الأصوات',
]);

const WRITE_PHASES: ReadonlySet<PublishPhase> = new Set<PublishPhase>([
  'حفظ المنشور في Supabase (posts.upsert)',
  'إنشاء سجل media_assets',
  'التحقق من الصف المحفوظ',
]);

/** تصنيف المرحلة وحدها، بلا النظر إلى نص الخطأ. */
export function classifyPublishPhase(phase: PublishPhase): PublishFailureKind {
  if (IMAGEKIT_UPLOAD_PHASES.has(phase)) return 'imagekit-upload';
  if (SIGNATURE_PHASES.has(phase)) return 'upload-signature';
  if (PREPARE_PHASES.has(phase)) return 'media-prepare';
  if (WRITE_PHASES.has(phase)) return 'supabase-write';
  return 'unknown';
}

/**
 * نص يخص نقطة توقيع الرفع على خادمنا (storyUpload.fetchImageKitAuth).
 * يُستخدم لتصحيح التصنيف حين لا يصل حدث تقدّم قبل الفشل (ملف صغير)، فتبقى
 * المرحلة المسجَّلة «جلب التوقيع» بينما الخطأ جاء من الرفع أو العكس.
 */
const SIGNATURE_ERROR_PATTERN = /توقيع رفع الوسائط|imagekit-auth|تسجيل الدخول قبل رفع الوسائط/i;
/** نص يخص رفض/انقطاع ImageKit نفسه أو الرفع عبر الخادم الاحتياطي. */
const IMAGEKIT_UPLOAD_ERROR_PATTERN = /فشل رفع الوسائط|خدمة رفع الوسائط|فشل الرفع عبر الخادم|لم يُرجَع رابط الملف|رابط الملف بعد الرفع/i;

/**
 * التصنيف النهائي: المرحلة أساساً، ثم نص الخطأ يصحّح بين مرحلتي الرفع
 * (التوقيع مقابل الرفع) فقط — لا يغيّر تصنيف الكتابة في القاعدة ولا التجهيز.
 */
export function classifyPublishFailure(phase: PublishPhase, message: string): PublishFailureKind {
  const byPhase = classifyPublishPhase(phase);
  if (byPhase === 'supabase-write' || byPhase === 'media-prepare') return byPhase;
  const text = typeof message === 'string' ? message : '';
  if (SIGNATURE_ERROR_PATTERN.test(text)) return 'upload-signature';
  if (IMAGEKIT_UPLOAD_ERROR_PATTERN.test(text)) return 'imagekit-upload';
  return byPhase;
}

export function describePublishKind(kind: PublishFailureKind): string {
  if (kind === 'imagekit-upload') return 'فشل الرفع الفعلي إلى ImageKit (رفض أو انقطاع من ImageKit)';
  if (kind === 'upload-signature') return 'فشل جلب توقيع الرفع من الخادم (/api/media/imagekit-auth) — قبل أي إرسال إلى ImageKit';
  if (kind === 'media-prepare') return 'فشل ضغط/تجهيز الملف محلياً في المتصفح — قبل أي شبكة';
  if (kind === 'supabase-write') return 'فشل كتابة/قراءة المنشور في Supabase (قاعدة البيانات)';
  return 'فشل قبل مرحلة الرفع أو الحفظ (جلسة/شبكة/إيقاظ خادم)';
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
    const message = fields.message || (input.timedOut ? 'انتهت مهلة النشر قبل اكتمال الرفع أو الحفظ.' : 'خطأ بلا رسالة');
    const entry: PublishFailureEntry = {
      id: `pub-${Date.now()}-${(sequence += 1)}`,
      at: Date.now(),
      phase: input.phase,
      kind: classifyPublishFailure(input.phase, message),
      code: fields.code || (input.timedOut ? 'TIMEOUT' : 'غير مصنَّف'),
      message,
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

/**
 * تقرير نصي جاهز للنسخ — محجوب الأسرار.
 * كل سطر يُمرَّر عبر redactSecrets مرة أخرى عند البناء، فلا يعتمد الحجب على
 * لحظة التخزين وحدها.
 */
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
    lines.push(`المتصفح: ${navigator.userAgent.slice(0, 160)}`);
  } catch {
    // غير متاح
  }
  return redactSecrets(lines.join('\n'));
}
