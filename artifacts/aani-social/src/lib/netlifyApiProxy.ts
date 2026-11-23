// توجيه مسارات /api على Netlify إلى خدمة الـAPI (Render).
//
// سبب وجود الملف: Netlify يبني ملفات ثابتة فقط، و`public/_redirects` يوجّه كل
// مسار إلى index.html. لذلك /api/media/imagekit-auth و/api/media/voice يعيدان
// صفحة SPA بدل JSON. هذه الوحدة تبني قاعدة توجيه واحدة `/api/*` تصل بالمسارين
// (توقيع رفع الوسائط والرسائل الصوتية) إلى خدمة الـAPI نفسها، مع إبقاء قاعدة
// SPA الاحتياطية.
//
// العنوان لا يُخترع: يأتي من API_PROXY_TARGET في بيئة البناء (Netlify). بلا
// عنوان، تُكتب قاعدة SPA وحدها كما هي اليوم — لا عنوان افتراضي غير مثبت.
//
// الوحدة خالصة (بلا Node ولا React) لتُختبر مباشرة في Node.

export const API_PROXY_PREFIX = '/api';

export const NETLIFY_REDIRECTS_FILE = '_redirects';

export const API_PROXY_TARGET_ENV = 'API_PROXY_TARGET';

/** قاعدة SPA الاحتياطية: كل مسار غير موجود يُخدم بـindex.html. */
export const NETLIFY_SPA_FALLBACK_RULE = '/*    /index.html   200';

/**
 * يطبّع عنوان خدمة الـAPI: يقبل https فقط مع مضيف، ويزيل المسافات والشرطة
 * المائلة الأخيرة. أي قيمة أخرى تُرفض (null) ولا تُكتب في ملف التوجيه.
 */
export function normalizeApiProxyTarget(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  // مضيف بلا فراغات ولا استعلام، مع مسار بادئة اختياري إن كان الـAPI خلف وسيط.
  return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+-]+)*$/i.test(value)
    ? value
    : null;
}

/**
 * محتوى ملف `_redirects` النهائي: قاعدة توجيه /api أولاً عند ضبط عنوان
 * موثوق، ثم قاعدة SPA دائماً. الترتيب مقصود: Netlify يعتمد أول قاعدة مطابقة.
 */
export function buildNetlifyRedirects(apiProxyTarget?: string | null): string {
  const target = normalizeApiProxyTarget(apiProxyTarget);
  const rules: string[] = [];
  if (target) {
    rules.push(`${API_PROXY_PREFIX}/*   ${target}${API_PROXY_PREFIX}/:splat   200`);
  }
  rules.push(NETLIFY_SPA_FALLBACK_RULE);
  return `${rules.join('\n')}\n`;
}

/**
 * مطابقة مسار بقاعدة Netlify بسيطة تحتوي نجمة واحدة (وهو الشكل الوحيد الذي
 * نكتبه). في Netlify تطابق `*` بقية المسار بما فيه الشرطات المائلة.
 */
export function matchesNetlifyPathRule(rule: string, path: string): boolean {
  if (!path.startsWith('/')) return false;
  const starIndex = rule.indexOf('*');
  if (starIndex === -1) return rule === path;
  const prefix = rule.slice(0, starIndex);
  const suffix = rule.slice(starIndex + 1);
  if (!path.startsWith(prefix)) return false;
  if (!suffix) return true;
  return path.length >= prefix.length + suffix.length && path.endsWith(suffix);
}
