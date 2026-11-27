/**
 * المصادقة الثنائية TOTP — منطق واحد قابل للاختبار فوق واجهة Supabase الرسمية
 * (`mfa.enroll`, `mfa.challenge`, `mfa.verify`, `mfa.unenroll`, `mfa.listFactors`,
 * `mfa.getAuthenticatorAssuranceLevel`).
 *
 * القواعد:
 * - العامل الثاني TOTP وحده: لا SMS ولا رقم هاتف.
 * - QR والسر يُعرضان أثناء التسجيل فقط، ولا يُخزَّنان في أي حالة دائمة.
 * - العامل لا يُعتمد قبل `verify` ناجح برمز صحيح.
 * - حالة MFA في `app_metadata` تُكتب من الخادم فقط (دالة `account-mfa`)؛ هذا
 *   الملف لا يلمس `app_metadata` ولا `user_metadata`.
 * - التعطيل يتطلب إثبات الرمز أولاً، ثم `unenroll`، ثم مزامنة حالة الخادم.
 * - قرار التفويض: مستخدم فعّل MFA ولا يملك aal2 لا يُسمح له بالدخول إلى
 *   التطبيق، حتى لو كان العامل مسجلاً.
 */

export const MFA_CHALLENGE_REQUIRED_MESSAGE = 'أكمل التحقق بخطوتين للمتابعة.';
export const MFA_ENROLL_REQUIRED_MESSAGE =
  'التحقق بخطوتين مفعّل لكن لا يوجد عامل مؤكد. أعد تسجيل تطبيق المصادقة.';
export const MFA_CODE_INVALID_MESSAGE = 'الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الحالي.';
export const MFA_UNAVAILABLE_MESSAGE = 'تعذر الوصول إلى خدمة التحقق بخطوتين. حاول مجددًا.';
export const MFA_SESSION_MESSAGE = 'تم التحقق لكن تعذر تحديث الجلسة. أعد تحميل الصفحة ثم حاول مجددًا.';
export const MFA_LOST_DEVICE_MESSAGE =
  'فقدت جهاز المصادقة؟ لا توجد آلية استرداد تلقائية آمنة في التطبيق: تواصل مع الدعم لمراجعة الهوية قبل رفع الحظر. لا تُعطِّل الحماية بنفسك.';

const TOTP_CODE_PATTERN = /^\d{6}$/;

export type MfaFactorStatus = 'verified' | 'unverified';
export type AssuranceLevel = 'aal1' | 'aal2' | 'unknown';

export type MfaFactor = {
  id: string;
  factorType: string;
  status: MfaFactorStatus;
  friendlyName: string;
  createdAt: string;
};

/** عوامل TOTP وحدها: لا SMS ولا عامل آخر يُعتد به هنا. */
export function totpFactors(factors: MfaFactor[]): MfaFactor[] {
  return (Array.isArray(factors) ? factors : [])
    .filter(factor => factor && factor.factorType === 'totp')
    .map(factor => ({ ...factor, friendlyName: factor.friendlyName || 'تطبيق المصادقة' }));
}

export function verifiedTotpFactors(factors: MfaFactor[]): MfaFactor[] {
  return totpFactors(factors).filter(factor => factor.status === 'verified');
}

export type MfaGate =
  | { allow: true }
  | { allow: false; reason: 'challenge' | 'enroll'; message: string };

/**
 * قرار الفرض: MFA مفعّلة على الخادم = لا وصول بلا aal2 وعامل مؤكد. أي حالة
 * ناقصة تُغلق الباب (fail-closed) ولا تُترك مفتوحة.
 */
export function resolveMfaGate(input: {
  enabled: boolean;
  level: AssuranceLevel;
  factors: MfaFactor[];
}): MfaGate {
  if (!input.enabled) return { allow: true };
  if (verifiedTotpFactors(input.factors).length === 0) {
    return { allow: false, reason: 'enroll', message: MFA_ENROLL_REQUIRED_MESSAGE };
  }
  if (input.level !== 'aal2') {
    return { allow: false, reason: 'challenge', message: MFA_CHALLENGE_REQUIRED_MESSAGE };
  }
  return { allow: true };
}

export type MfaStatus = {
  enabled: boolean;
  level: AssuranceLevel;
  verifiedCount: number;
  factors: MfaFactor[];
  needsChallenge: boolean;
};

export function readMfaStatus(input: {
  enabled: boolean;
  level: AssuranceLevel;
  factors: MfaFactor[];
}): MfaStatus {
  const verified = verifiedTotpFactors(input.factors);
  return {
    enabled: input.enabled,
    level: input.level,
    verifiedCount: verified.length,
    factors: verified,
    needsChallenge: input.enabled && verified.length > 0 && input.level !== 'aal2',
  };
}

export type MfaClient = {
  enroll: (options: {
    factorType: 'totp';
    friendlyName: string;
  }) => Promise<{ data: { id: string; totp?: { qr_code?: string; secret?: string } } | null; error: unknown }>;
  challenge: (options: {
    factorId: string;
  }) => Promise<{ data: { id: string } | null; error: unknown }>;
  verify: (options: {
    factorId: string;
    challengeId: string;
    code: string;
  }) => Promise<{ data: { access_token?: string; refresh_token?: string } | null; error: unknown }>;
  unenroll: (options: { factorId: string }) => Promise<{ data: unknown; error: unknown }>;
  setSession: (tokens: { access_token: string; refresh_token: string }) => Promise<{ error: unknown }>;
  /** نداء دالة `account-mfa` على الخادم بعد التحقق فقط. */
  syncServerState: (
    accessToken: string,
  ) => Promise<{ ok: true; mfaEnabled: boolean } | { ok: false; message: string }>;
};

export type EnrollmentSecret = { factorId: string; qrCode: string; secret: string };

/** يبدأ تسجيل عامل TOTP ويعيد QR والسر لعرضهما أثناء التسجيل فقط. */
export async function startTotpEnrollment(
  client: MfaClient,
  friendlyName = 'Aani',
): Promise<{ ok: true; enrollment: EnrollmentSecret } | { ok: false; message: string }> {
  const { data, error } = await client.enroll({ factorType: 'totp', friendlyName });
  if (error || !data?.id) return { ok: false, message: MFA_UNAVAILABLE_MESSAGE };
  const qrCode = typeof data.totp?.qr_code === 'string' ? data.totp.qr_code : '';
  const secret = typeof data.totp?.secret === 'string' ? data.totp.secret : '';
  // بلا QR أو سر لا شيء يُعرض: لا نعتمد عاملاً لم نستلم مفتاحه.
  if (!qrCode && !secret) return { ok: false, message: MFA_UNAVAILABLE_MESSAGE };
  return { ok: true, enrollment: { factorId: data.id, qrCode, secret } };
}

/**
 * يؤكد التسجيل: تحدي ثم تحقق بالرمز، ثم تثبيت الجلسة الجديدة (aal2)، ثم
 * مزامنة `app_metadata` من الخادم. الفشل في أي خطوة يعني أن العامل لم يُعتمد
 * وأن الحالة لم تتغيّر.
 */
export async function confirmTotpEnrollment(
  client: MfaClient,
  factorId: string,
  code: string,
): Promise<{ ok: true; mfaEnabled: boolean } | { ok: false; message: string }> {
  if (!TOTP_CODE_PATTERN.test(String(code ?? '').trim())) {
    return { ok: false, message: MFA_CODE_INVALID_MESSAGE };
  }

  const challenge = await client.challenge({ factorId });
  if (challenge.error || !challenge.data?.id) {
    return { ok: false, message: MFA_UNAVAILABLE_MESSAGE };
  }

  const verified = await client.verify({ factorId, challengeId: challenge.data.id, code: String(code).trim() });
  const tokens = verified.data;
  if (verified.error || !tokens?.access_token || !tokens.refresh_token) {
    return { ok: false, message: MFA_CODE_INVALID_MESSAGE };
  }

  const { error: sessionError } = await client.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (sessionError) return { ok: false, message: MFA_SESSION_MESSAGE };

  const synced = await client.syncServerState(tokens.access_token);
  if (!synced.ok) return { ok: false, message: synced.message };
  return { ok: true, mfaEnabled: synced.mfaEnabled };
}

/**
 * يعطّل العامل: إثبات الرمز أولاً (تحدي + تحقق)، ثم `unenroll`، ثم مزامنة
 * حالة الخادم. لا تعطيل بلا رمز صحيح، ولا حالة متضاربة بعد التعطيل.
 */
export async function disableTotp(
  client: MfaClient,
  factorId: string,
  code: string,
): Promise<{ ok: true; mfaEnabled: boolean } | { ok: false; message: string }> {
  if (!TOTP_CODE_PATTERN.test(String(code ?? '').trim())) {
    return { ok: false, message: MFA_CODE_INVALID_MESSAGE };
  }

  const challenge = await client.challenge({ factorId });
  if (challenge.error || !challenge.data?.id) {
    return { ok: false, message: MFA_UNAVAILABLE_MESSAGE };
  }

  const verified = await client.verify({ factorId, challengeId: challenge.data.id, code: String(code).trim() });
  const tokens = verified.data;
  if (verified.error || !tokens?.access_token || !tokens.refresh_token) {
    return { ok: false, message: MFA_CODE_INVALID_MESSAGE };
  }

  const { error: unenrollError } = await client.unenroll({ factorId });
  if (unenrollError) return { ok: false, message: MFA_UNAVAILABLE_MESSAGE };

  const { error: sessionError } = await client.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (sessionError) return { ok: false, message: MFA_SESSION_MESSAGE };

  const synced = await client.syncServerState(tokens.access_token);
  if (!synced.ok) return { ok: false, message: synced.message };
  return { ok: true, mfaEnabled: synced.mfaEnabled };
}
