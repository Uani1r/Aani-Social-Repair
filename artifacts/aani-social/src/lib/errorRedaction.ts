// حجب الأسرار من أي نص تشخيصي قبل تخزينه أو عرضه أو نسخه.
//
// لوحة أخطاء النشر تُعرض في الإنتاج لكل مستخدم، وتُنسخ إلى دردشة الدعم. لذلك
// لا يخرج منها شيء يمكن أن يُستعمل للوصول إلى الحساب:
//   - access token لجلسة Supabase (JWT) أو أي ترويسة Authorization
//   - توقيع ImageKit (ik-s) ووقت انتهاء الرابط (ik-t)
//   - مفاتيح الخادم (private key / service_role / apikey / password)
//
// القاعدة: نحجب القيمة ونُبقي الاسم (signature=[محذوف])، فيظل سبب الخطأ مقروءاً
// من غير أن يخرج السر.

const MASK = '[محذوف]';

/** أنماط القيم السرّية: كل نمط يحتفظ بالبادئة ويستبدل القيمة وحدها. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // ترويسة مصادقة كاملة: "authorization: Bearer eyJ..."
  { pattern: /(authorization\s*[:=]\s*)(?:bearer\s+)?[A-Za-z0-9._\-+/=]+/gi, replacement: `$1${MASK}` },
  // "Bearer <token>" في أي موضع
  { pattern: /(bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, replacement: `$1${MASK}` },
  // توقيع ImageKit في الرابط: ?ik-t=...&ik-s=...
  { pattern: /(ik-s=)[^&\s"']+/gi, replacement: `$1${MASK}` },
  { pattern: /(ik-t=)[^&\s"']+/gi, replacement: `$1${MASK}` },
  // أسماء حقول سرّية تليها قيمة (JSON أو نص أو ترويسة)
  {
    pattern: /((?:access[_-]?token|refresh[_-]?token|signature|apikey|api[_-]?key|private[_-]?key|service[_-]?role[_-]?key|password|secret)\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{6,}/gi,
    replacement: `$1${MASK}`,
  },
  // مفاتيح Supabase بصيغتها الحديثة
  { pattern: /(sb_secret_[A-Za-z0-9_\-]{4,})/g, replacement: MASK },
  // JWT: ثلاثة مقاطع base64url يفصلها نقطتان (access token)
  { pattern: /eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}/g, replacement: MASK },
  // مفتاح ImageKit الخاص: بادئة private_ متبوعة بسلسلة طويلة
  { pattern: /(private_[A-Za-z0-9_\-]{12,})/g, replacement: MASK },
];

/** يُعيد النص مع حجب كل ما يشبه سرّاً. غير النص يُعاد كما هو. */
export function redactSecrets(value: string): string {
  if (typeof value !== 'string' || !value) return value;
  let output = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    try {
      output = output.replace(pattern, replacement);
    } catch {
      // نمط معطوب لا يمنع بقية الحجب
    }
  }
  return output;
}

/** نسخة تعمل على أي قيمة: تُحوّل النص فقط، وتترك الباقي. */
export function redactValue(value: unknown): string {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || value === undefined) return '';
  try {
    return redactSecrets(String(value));
  } catch {
    return '';
  }
}
