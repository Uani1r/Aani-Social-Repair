/**
 * oauthRedirect.ts
 * عنوان عودة OAuth: deep link للهاتف، وorigin الفعلي للويب — بلا localhost في
 * الإنتاج، وبلا قبول عنوان عشوائي.
 *
 * سبب المشكلة المُبلَّغ عنها (إعادة التوجيه إلى localhost:3000 ثم
 * ERR_CONNECTION_FAILED): لا يُبنى العنوان هنا من قيمة ثابتة، لكن حين لا يكون
 * عنوان العودة مُدرجاً في Redirect URLs لإعدادات المصادقة، يعود Supabase إلى
 * Site URL المضبوط في اللوحة (localhost:3000). لذلك:
 *   * عنوان الويب يُبنى من `window.location.origin` الفعلي وحده.
 *   * في نسخة الإنتاج يُرفض أي أصل محلي (localhost/127.0.0.1/0.0.0.0) وأي http.
 *   * ولا يُقبل إلا أصل مدرج: العنوان المنشور المعتمد أو ما يضيفه المالك في
 *     VITE_AUTH_ALLOWED_ORIGINS. غير ذلك يتوقف البدء برسالة واضحة، فلا يُرسَل
 *     المستخدم إلى عنوان غير مسجّل.
 *   * مسار الهاتف `anisocial://auth/callback` منفصل تماماً ولا يختلط بالويب.
 */

export const NATIVE_OAUTH_REDIRECT_URL = 'anisocial://auth/callback';

/**
 * العنوان المنشور الحالي على Render. عنوان تشغيل مؤقت يُقبل في الإنتاج حتى
 * يُضاف النطاق النهائي إلى VITE_AUTH_ALLOWED_ORIGINS.
 */
export const PUBLISHED_WEB_ORIGIN = 'https://aani-social-repair.onrender.com';

export const OAUTH_REDIRECT_MESSAGES = {
  originUnavailable: 'تعذر تحديد عنوان الموقع لإكمال تسجيل الدخول. افتح الموقع من رابطه المنشور.',
  insecureOrigin: 'تسجيل الدخول عبر Google يتطلب اتصالاً آمناً (HTTPS).',
  originNotAllowed:
    'عنوان هذا الموقع غير مسموح لتسجيل الدخول عبر Google. أضفه إلى Redirect URLs في إعدادات المصادقة.',
  localhostNotAllowed:
    'لا يمكن تسجيل الدخول عبر Google من عنوان محلي في نسخة الإنتاج. افتح الموقع المنشور.',
} as const;

export type OAuthRedirectResult =
  | { ok: true; kind: 'native' | 'web'; url: string }
  | { ok: false; error: string };

export type OAuthRedirectInput = {
  /** `window.location.origin` كما هو في المتصفح. */
  origin?: string | null;
  /** هل نعمل داخل تطبيق الهاتف (Capacitor)؟ */
  native: boolean;
  /** نسخة إنتاج مبنية (Vite build)؟ */
  production: boolean;
  /** عناوين إضافية مسموحة من VITE_AUTH_ALLOWED_ORIGINS. */
  allowedOrigins?: unknown;
};

type ViteEnv = Record<string, string | boolean | undefined>;

function readEnv(): ViteEnv {
  try {
    const env = (import.meta as { env?: ViteEnv }).env;
    return env && typeof env === 'object' ? env : {};
  } catch {
    return {};
  }
}

export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform() === true;
}

/** أصل صرف فقط: scheme://host[:port] بلا مسار أو استعلام أو بيانات دخول. */
function parseOrigin(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin === 'null') return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** عناوين إضافية من متغير واحد مفصول بفواصل: تُنقّى وتُفحص كأصل صرف. */
export function normalizeAllowedOrigins(value: unknown): string[] {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(',') : '';
  const origins = raw.split(',').map(item => parseOrigin(item.trim())).filter((item): item is string => Boolean(item));
  return Array.from(new Set(origins));
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
    || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

/**
 * عنوان العودة المعتمد: deep link للهاتف، وأصل الويب الفعلي بعد فحصه.
 * لا يُبنى أي عنوان من قيمة افتراضية، ولا يُقبل عنوان غير مدرج في الإنتاج.
 */
export function resolveOAuthRedirect(input: OAuthRedirectInput): OAuthRedirectResult {
  if (input.native) return { ok: true, kind: 'native', url: NATIVE_OAUTH_REDIRECT_URL };

  const origin = parseOrigin(typeof input.origin === 'string' ? input.origin.trim() : '');
  if (!origin) return { ok: false, error: OAUTH_REDIRECT_MESSAGES.originUnavailable };

  if (input.production) {
    const hostname = new URL(origin).hostname;
    if (isLocalHostname(hostname)) return { ok: false, error: OAUTH_REDIRECT_MESSAGES.localhostNotAllowed };
    if (!origin.startsWith('https://')) return { ok: false, error: OAUTH_REDIRECT_MESSAGES.insecureOrigin };
    const allowed = new Set([PUBLISHED_WEB_ORIGIN, ...normalizeAllowedOrigins(input.allowedOrigins)]);
    if (!allowed.has(origin)) return { ok: false, error: OAUTH_REDIRECT_MESSAGES.originNotAllowed };
  }

  return { ok: true, kind: 'web', url: origin };
}

/** الحالة الفعلية في هذا المتصفح: الأصل الحالي ووضع البناء والمتغيرات. */
export function currentWebOAuthRedirect(): OAuthRedirectResult {
  const env = readEnv();
  const mode = typeof env.MODE === 'string' ? env.MODE.toLowerCase() : '';
  return resolveOAuthRedirect({
    origin: typeof window !== 'undefined' && window.location ? window.location.origin : '',
    native: isNativePlatform(),
    production: env.PROD === true || env.PROD === 'true' || mode === 'production',
    allowedOrigins: env.VITE_AUTH_ALLOWED_ORIGINS,
  });
}

/** للتوافق: عنوان العودة أو نص فارغ حين لا يوجد عنوان معتمد. */
export function getOAuthRedirectUrl(): string {
  const resolved = currentWebOAuthRedirect();
  return resolved.ok ? resolved.url : '';
}

export function isAppleOAuthEnabled(): boolean {
  const value = readEnv().VITE_APPLE_OAUTH_ENABLED;
  return String(value || '').trim().toLowerCase() === 'true';
}

const OAUTH_RETURN_ERRORS: Record<string, string> = {
  access_denied: 'أُلغي تسجيل الدخول عبر Google. يمكنك المحاولة مرة أخرى.',
  server_error: 'تعذر إكمال تسجيل الدخول عبر Google. حاول مرة أخرى.',
  temporarily_unavailable: 'خدمة Google غير متاحة الآن. حاول بعد قليل.',
  invalid_request: 'طلب الدخول غير صالح. ابدأ تسجيل الدخول من جديد.',
  unauthorized_client: 'تسجيل الدخول عبر Google غير مسموح لهذا العنوان. راجع Redirect URLs في إعدادات المصادقة.',
};

/** رسالة عربية ثابتة لخطأ عودة OAuth: لا تُعرض رسائل المزوّد الخام. */
export function describeOAuthReturnError(error: string): string {
  const code = typeof error === 'string' ? error.trim().toLowerCase() : '';
  return OAUTH_RETURN_ERRORS[code] || 'تعذر إكمال تسجيل الدخول عبر Google. حاول مرة أخرى.';
}

export type WebOAuthReturn =
  | { kind: 'none' }
  | { kind: 'code' }
  | { kind: 'error'; message: string };

/**
 * ما تحمله استعلامات الصفحة عند العودة من Google:
 *   * `code` مع PKCE: Supabase يتبادله تلقائياً عند التحميل (detectSessionInUrl).
 *   * `error` / `error_description`: إلغاء أو فشل يُعرض برسالة واضحة.
 */
export function readWebOAuthReturn(search: string): WebOAuthReturn {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return { kind: 'none' };
  }
  const error = params.get('error') || params.get('error_description');
  if (error) return { kind: 'error', message: describeOAuthReturnError(error) };
  if (params.get('code')) return { kind: 'code' };
  return { kind: 'none' };
}
