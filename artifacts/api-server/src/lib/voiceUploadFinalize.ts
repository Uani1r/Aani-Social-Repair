// إنهاء رفع الرسالة الصوتية: لا نجاح قبل تسجيل الرابط في Upload Ledger.
//
// فشل التسجيل بعد نجاح رفع ImageKit لا يُترك صامتاً:
//   1) إعادة محاولة التسجيل (محدودة).
//   2) مسار تعويضي موثوق: جدولة الملف في طابور الحذف (Worker يفحص المراجع
//      الحية قبل أي حذف) — فالمسار يُسجَّل ولا يبقى يتيماً غير معروف.
//   3) إن تعذّرت الجدولة أيضاً: لا حذف مباشر إلا بعد تحقق صريح من عدم وجود أي
//      مرجع حي؛ وإن تعذّر التحقق أو وُجد مرجع، لا يُحذف شيء ويُعلَن الخطر.
//
// الوحدة صرفة (بلا شبكة) وتستقبل كل أثر جانبي كدالة، لتُختبر بلا Supabase أو
// ImageKit.

export const VOICE_LEDGER_ATTEMPTS = 3;
export const VOICE_DELETION_ENQUEUE_ATTEMPTS = 2;
export const VOICE_FINALIZE_RETRY_DELAY_MS = 250;

export type VoiceFinalizeOutcome =
  | { ok: true }
  /**
   * فشل التسجيل لكن أُمن الملف: إما جُدول للحذف (cleaned) أو وُجد مرجع حي
   * يمنع حذفه (referenced).
   */
  | { ok: false; reason: 'ledger-failed-cleaned' | 'ledger-failed-referenced' }
  /** فشل التسجيل والجدولة وتعذّر إثبات عدم وجود مرجع: الملف قد يبقى بلا سجل. */
  | { ok: false; reason: 'ledger-failed-orphan-risk' };

export type VoiceFinalizeEvent =
  | 'ledger-retry'
  | 'ledger-failed'
  | 'deletion-enqueued'
  | 'deleted-unreferenced'
  | 'still-referenced'
  | 'reference-check-failed'
  | 'orphan-risk';

export interface VoiceFinalizeDeps {
  /** يكتب الرابط في media_upload_ledger؛ يرمي عند الفشل. */
  recordLedger(url: string): Promise<void>;
  /** يضيف الملف إلى media_deletion_jobs (Worker يفحص المراجع قبل الحذف). */
  enqueueDeletion(url: string): Promise<void>;
  /** فحص صارم للمراجع الحية؛ يرمي إذا تعذّر التحقق. */
  hasLiveReference(url: string): Promise<boolean>;
  /** حذف الملف من ImageKit بعد إثبات عدم وجود مرجع حي. */
  deleteUnreferenced(url: string): Promise<void>;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  log?: (event: VoiceFinalizeEvent, detail?: unknown) => void;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * يعيد ok فقط بعد تسجيل ناجح في الـLedger. كل فشل بعده يعيد نتيجة صريحة
 * ويضمن (قدر الإمكان) عدم ترك ملف بلا سجل معروف.
 */
export async function finalizeVoiceUpload(
  url: string,
  deps: VoiceFinalizeDeps,
): Promise<VoiceFinalizeOutcome> {
  const wait = deps.wait ?? defaultWait;
  const retryDelayMs = Math.max(0, deps.retryDelayMs ?? VOICE_FINALIZE_RETRY_DELAY_MS);
  const log = deps.log ?? (() => undefined);

  let ledgerRecorded = false;
  for (let attempt = 0; attempt < VOICE_LEDGER_ATTEMPTS; attempt += 1) {
    try {
      await deps.recordLedger(url);
      ledgerRecorded = true;
      break;
    } catch (error) {
      log('ledger-retry', error);
      if (attempt < VOICE_LEDGER_ATTEMPTS - 1) await wait(retryDelayMs * (attempt + 1));
    }
  }
  if (ledgerRecorded) return { ok: true };

  log('ledger-failed', url);

  // مسار تعويضي 1: طابور الحذف — سجل دائم، والحذف فيه يسبقه فحص مراجع.
  for (let attempt = 0; attempt < VOICE_DELETION_ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await deps.enqueueDeletion(url);
      log('deletion-enqueued', url);
      return { ok: false, reason: 'ledger-failed-cleaned' };
    } catch {
      if (attempt < VOICE_DELETION_ENQUEUE_ATTEMPTS - 1) await wait(retryDelayMs);
    }
  }

  // مسار تعويضي 2: حذف مباشر فقط بعد تحقق صريح من عدم وجود أي مرجع حي.
  try {
    const liveReference = await deps.hasLiveReference(url);
    if (liveReference) {
      // ملف مستخدم فعلاً: تركه آمن، وإعلان الفشل صريح.
      log('still-referenced', url);
      return { ok: false, reason: 'ledger-failed-referenced' };
    }
    await deps.deleteUnreferenced(url);
    log('deleted-unreferenced', url);
    return { ok: false, reason: 'ledger-failed-cleaned' };
  } catch (error) {
    log('reference-check-failed', error);
  }

  // لا نستطيع إثبات عدم الاستخدام ولا جدولة الحذف: لا حذف أعمى.
  log('orphan-risk', url);
  return { ok: false, reason: 'ledger-failed-orphan-risk' };
}
