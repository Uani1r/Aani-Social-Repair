/**
 * oauthNativeCore.ts
 * منطق Google OAuth الأصلي (iOS/Android) بلا أي استيراد من Capacitor أو Supabase.
 *
 * كل تعامل خارجي (signInWithOAuth وexchangeCodeForSession وفتح المتصفح وإغلاقه
 * وإغلاقه بيد المستخدم، ومستمع رابط التطبيق ورابط التشغيل البارد) يأتي عبر دوال
 * محقونة، فتُختبر المحاولة كاملة — النجاح والفشل والإلغاء وإعادة المحاولة
 * والتكرار والتزامن — بلا جهاز ولا شبكة ولا مفاتيح.
 *
 * القواعد:
 *   * بلا `data.url` (ولا خطأ) لا تبقى محاولة معلّقة: تُحرَّر وتُعاد نتيجة فشل
 *     واضحة، وتُسمح محاولة جديدة.
 *   * التبادل مرة واحدة لكل رمز: التكرار أثناء التنفيذ يشترك في الوعد نفسه،
 *     والتكرار بعد الاكتمال لا يُبادل ولا يُصدر نتيجة ثانية.
 *   * إغلاق المتصفح بيد المستخدم = إلغاء صريح (`cancelled`)، لا نجاح ولا تعليق.
 *   * رقم المحاولة يمنع نتيجة قديمة أو مكررة من الانتقال/الرسالة مرتين.
 *   * مستمع واحد للتطبيق حتى مع تسجيل متزامن، ورابط التشغيل البارد يُعالَج مرة
 *     واحدة بعد تثبيت المستمع، فلا سباق ولا معالجة مزدوجة.
 */

/** مستمع قابل للإزالة: نفس شكل PluginListenerHandle في Capacitor. */
export type ListenerHandle = { remove: () => Promise<void> | void };

export type NativeOAuthResult = {
  ok: boolean;
  /** رقم المحاولة التي أنتجت النتيجة؛ 0 لرابط تشغيل بارد بلا محاولة في هذه النافذة. */
  attempt: number;
  error?: string;
  /** true عند إلغاء المستخدم (إغلاق المتصفح) بلا وصول رمز. */
  cancelled?: boolean;
};

export type NativeOAuthStartResult = { ok: boolean; attempt?: number; error?: string };

export interface ParsedOAuthCallback {
  ok: boolean;
  code?: string;
  error?: string;
}

export type NativeOAuthDecision =
  | { kind: 'ignore'; attempt: number }
  | { kind: 'navigate'; attempt: number }
  | { kind: 'notice'; attempt: number; message: string }
  | { kind: 'error'; attempt: number; message: string };

export type NativeOAuthDeps = {
  signInWithOAuth: () => Promise<{ url?: string | null; error?: unknown }>;
  exchangeCodeForSession: (code: string) => Promise<{ session?: unknown; error?: unknown }>;
  openBrowser: (url: string) => Promise<void>;
  closeBrowser: () => Promise<void>;
  onBrowserFinished: (handler: () => void) => Promise<ListenerHandle>;
};

export type NativeOAuthGate = {
  start: () => Promise<NativeOAuthStartResult>;
  handleUrl: (url: string) => Promise<NativeOAuthResult>;
  subscribe: (handler: (result: NativeOAuthResult) => void) => () => void;
  reset: () => Promise<void>;
  isInFlight: () => boolean;
};

export const NATIVE_OAUTH_CANCEL_MESSAGE =
  'أُلغي تسجيل الدخول عبر Google. يمكنك المحاولة مرة أخرى.';

const DEFAULT_NATIVE_OAUTH_MESSAGE = 'تعذر المتابعة باستخدام Google. حاول مرة أخرى.';

const NATIVE_OAUTH_MESSAGES: Record<string, string> = {
  cancelled: NATIVE_OAUTH_CANCEL_MESSAGE,
  in_progress: 'عملية دخول Google قيد التنفيذ.',
  oauth_url_missing: 'تعذر بدء تسجيل الدخول عبر Google. حاول مرة أخرى.',
  oauth_start_failed: 'تعذر بدء تسجيل الدخول عبر Google. حاول مرة أخرى.',
  browser_open_failed: 'تعذر فتح نافذة Google. حاول مرة أخرى.',
  oauth_exchange_failed: 'انتهت صلاحية طلب الدخول. حاول مرة أخرى.',
  session_not_created: 'لم تُنشأ الجلسة بعد الدخول. حاول مرة أخرى.',
  access_denied: 'لم تُمنح صلاحية الدخول إلى Google.',
  missing_code: 'لم يصل رمز الدخول من Google. حاول مرة أخرى.',
  invalid_url: 'رابط العودة من Google غير صالح.',
};

/** رسالة عربية لرمز داخلي ثابت: لا تُعرض رسائل SDK خام للواجهة. */
export function describeNativeOAuthError(error?: string): string {
  const code = typeof error === 'string' ? error.trim() : '';
  return NATIVE_OAUTH_MESSAGES[code] || DEFAULT_NATIVE_OAUTH_MESSAGE;
}

/** تحليل رابط العودة `anisocial://auth/callback`: رمز أو خطأ المزوّد. */
export function parseOAuthCallback(url: string): ParsedOAuthCallback {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'anisocial:' || parsed.hostname !== 'auth' || parsed.pathname !== '/callback') {
    return { ok: false, error: 'invalid_url' };
  }
  const error = parsed.searchParams.get('error') || parsed.searchParams.get('error_description');
  if (error) return { ok: false, error };
  const code = parsed.searchParams.get('code');
  if (!code) return { ok: false, error: 'missing_code' };
  return { ok: true, code };
}

/**
 * قرار الواجهة لنتيجة OAuth: انتقال مرة واحدة عند النجاح، أو إشعار إلغاء، أو
 * رسالة خطأ. نتيجة محاولة عولجت من قبل تُهمل تماماً.
 */
export function nativeOAuthDecision(
  result: NativeOAuthResult,
  handledAttempt: number,
): NativeOAuthDecision {
  const raw = Number(result?.attempt);
  const attempt = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (attempt > 0 && attempt === handledAttempt) return { kind: 'ignore', attempt };
  if (result?.ok) return { kind: 'navigate', attempt };
  if (result?.cancelled) return { kind: 'notice', attempt, message: NATIVE_OAUTH_CANCEL_MESSAGE };
  return { kind: 'error', attempt, message: describeNativeOAuthError(result?.error) };
}

/** حالة محاولة واحدة: رقمها، وهل حُسمت، وهل وصل رمزها (فلا يُعدّ إغلاقها إلغاءً). */
type Attempt = { id: number; settled: boolean; codeReceived: boolean };

const COMPLETED_CODES_LIMIT = 20;

/**
 * بوّابة OAuth الأصلية: تحفظ المحاولة الجارية وتمنع التكرار والتزامن، وتُصدر
 * نتيجة واحدة لكل محاولة عبر المشتركين.
 */
export function createNativeOAuthGate(deps: NativeOAuthDeps): NativeOAuthGate {
  const handlers = new Set<(result: NativeOAuthResult) => void>();
  const completedCodes: string[] = [];
  const pendingCodes = new Map<string, Promise<NativeOAuthResult>>();
  let attemptSeq = 0;
  let attempt: Attempt | null = null;
  let browserHandle: ListenerHandle | null = null;

  const emit = (result: NativeOAuthResult): void => {
    for (const handler of [...handlers]) {
      try {
        handler(result);
      } catch {
        /* مستمع فاشل لا يمنع البقية */
      }
    }
  };

  const rememberCompleted = (code: string): void => {
    if (completedCodes.includes(code)) return;
    completedCodes.push(code);
    while (completedCodes.length > COMPLETED_CODES_LIMIT) completedCodes.shift();
  };

  const detachBrowserFinished = async (): Promise<void> => {
    const handle = browserHandle;
    browserHandle = null;
    if (!handle) return;
    try {
      await handle.remove();
    } catch {
      /* أُزيل مسبقاً */
    }
  };

  const release = (target: Attempt): void => {
    if (attempt === target) attempt = null;
  };

  /** نتيجة واحدة لكل محاولة: المحاولة المحسومة لا تُصدر ثانية. */
  const settle = (
    target: Attempt | null,
    part: { ok: boolean; error?: string; cancelled?: boolean },
  ): NativeOAuthResult => {
    const result: NativeOAuthResult = { ...part, attempt: target ? target.id : 0 };
    if (target) {
      if (target.settled) return result;
      target.settled = true;
      release(target);
    }
    void detachBrowserFinished();
    emit(result);
    return result;
  };

  /** فشل البدء: يُحرَّر فوراً بلا إصدار نتيجة (المستدعي يعرض الفشل ويعيد المحاولة). */
  const failStart = async (target: Attempt, error: string): Promise<NativeOAuthStartResult> => {
    target.settled = true;
    release(target);
    await detachBrowserFinished();
    return { ok: false, error };
  };

  const exchangeCode = async (code: string, owner: Attempt | null): Promise<NativeOAuthResult> => {
    let exchanged: { session?: unknown; error?: unknown };
    try {
      exchanged = await deps.exchangeCodeForSession(code);
    } catch {
      return settle(owner, { ok: false, error: 'oauth_exchange_failed' });
    }
    if (exchanged?.error) return settle(owner, { ok: false, error: 'oauth_exchange_failed' });
    if (!exchanged?.session) return settle(owner, { ok: false, error: 'session_not_created' });

    rememberCompleted(code);
    // إغلاق المتصفح بعد إزالة مستمع الإغلاق: لا يُعدّ إغلاقنا إلغاءً.
    await detachBrowserFinished();
    try {
      await deps.closeBrowser();
    } catch {
      /* مغلق مسبقاً */
    }
    return settle(owner, { ok: true });
  };

  const handleUrl = async (url: string): Promise<NativeOAuthResult> => {
    const parsed = parseOAuthCallback(url);
    if (!parsed.ok || !parsed.code) {
      const error = parsed.error || 'invalid_url';
      const cancelled = error === 'access_denied' || error === 'cancelled' || error === 'user_cancelled';
      return settle(attempt, { ok: false, error, ...(cancelled ? { cancelled: true } : {}) });
    }

    const code = parsed.code;
    // callback مكرر بعد اكتمال التبادل: لا تبادل ثانٍ ولا نتيجة ثانية.
    if (completedCodes.includes(code)) {
      return { ok: true, attempt: attempt ? attempt.id : 0 };
    }
    // تبادل جارٍ للرمز نفسه: المشتركون يتشاركون الوعد والنتيجة.
    const pending = pendingCodes.get(code);
    if (pending) return pending;

    const owner = attempt;
    if (owner) owner.codeReceived = true;
    const exchange = exchangeCode(code, owner);
    pendingCodes.set(code, exchange);
    try {
      return await exchange;
    } finally {
      pendingCodes.delete(code);
    }
  };

  const start = async (): Promise<NativeOAuthStartResult> => {
    if (attempt) return { ok: false, error: 'in_progress' };

    const current: Attempt = { id: ++attemptSeq, settled: false, codeReceived: false };
    attempt = current;

    await detachBrowserFinished();
    // مستمع إغلاق المتصفح يُثبَّت قبل الفتح: لا يضيع إغلاق سريع.
    try {
      browserHandle = await deps.onBrowserFinished(() => {
        if (current.settled || current.codeReceived) return;
        void settle(current, { ok: false, error: 'cancelled', cancelled: true });
      });
    } catch {
      browserHandle = null;
    }

    let oauth: { url?: string | null; error?: unknown };
    try {
      oauth = await deps.signInWithOAuth();
    } catch {
      return failStart(current, 'oauth_start_failed');
    }
    if (oauth?.error) return failStart(current, 'oauth_start_failed');

    const url = typeof oauth?.url === 'string' ? oauth.url.trim() : '';
    // بلا رابط وبلا خطأ: تُحرَّر المحاولة وتُعاد نتيجة فشل واضحة.
    if (!url) return failStart(current, 'oauth_url_missing');

    try {
      await deps.openBrowser(url);
    } catch {
      return failStart(current, 'browser_open_failed');
    }

    return { ok: true, attempt: current.id };
  };

  const reset = async (): Promise<void> => {
    attempt = null;
    pendingCodes.clear();
    completedCodes.length = 0;
    await detachBrowserFinished();
  };

  return {
    start,
    handleUrl,
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    reset,
    isInFlight: () => attempt !== null,
  };
}

export type NativeOAuthUrlListenerDeps = {
  addAppUrlListener: (handler: (url: string) => void) => Promise<ListenerHandle>;
  getLaunchUrl: () => Promise<string | null>;
  handleUrl: (url: string) => Promise<unknown>;
};

export type NativeOAuthUrlListener = {
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  isRegistered: () => boolean;
};

/**
 * مستمع روابط التطبيق: تسجيل واحد فقط حتى مع نداءات متزامنة، ورابط التشغيل
 * البارد يُقرأ بعد تثبيت المستمع فلا سباق، ويُعالَج مرة واحدة.
 *
 * سباق register/unregister: لو اكتمل `addAppUrlListener` بعد طلب الإزالة،
 * لَتُرك المستمع المكتمل فعّالاً بلا مالك. لذلك كل إزالة ترفع رقم جيل، وأي
 * تسجيل معلّق ينتهي بعدها يُزيل مستمعه بنفسه ولا يصبح المستمع النشط، ولا يقرأ
 * رابط التشغيل.
 */
export function createNativeOAuthUrlListener(
  deps: NativeOAuthUrlListenerDeps,
): NativeOAuthUrlListener {
  let handle: ListenerHandle | null = null;
  let registration: Promise<void> | null = null;
  let launchHandled = false;
  // يزيد مع كل إزالة: يُبطل أي تسجيل معلّق بدأ قبلها.
  let generation = 0;

  const removeHandle = async (target: ListenerHandle | null): Promise<void> => {
    if (!target) return;
    try {
      await target.remove();
    } catch {
      /* أُزيل مسبقاً */
    }
  };

  const register = (): Promise<void> => {
    if (registration) return registration;
    const attempt = generation;

    const pending = (async () => {
      let created: ListenerHandle | null = null;
      try {
        created = await deps.addAppUrlListener(url => {
          void deps.handleUrl(url);
        });
      } catch {
        created = null;
      }

      // إزالة وقعت أثناء انتظار addAppUrlListener: المستمع المتأخر يُزال فوراً
      // ولا يُنشر، فلا مستمع متروك بعد الإزالة.
      if (attempt !== generation) {
        await removeHandle(created);
        return;
      }

      handle = created;

      if (launchHandled) return;
      launchHandled = true;
      const launchUrl = await deps.getLaunchUrl().catch(() => null);

      // إزالة وقعت أثناء قراءة رابط التشغيل: يُزال مستمعنا وحدنا (لا مستمع
      // تسجيل أحدث) ولا يُعالَج الرابط.
      if (attempt !== generation) {
        if (handle === created) {
          handle = null;
          await removeHandle(created);
        }
        return;
      }

      if (!launchUrl) return;
      try {
        await deps.handleUrl(launchUrl);
      } catch {
        /* فشل المعالجة لا يمنع الاستماع */
      }
    })();

    registration = pending.catch(() => undefined);
    return registration;
  };

  const unregister = async (): Promise<void> => {
    // إبطال أي تسجيل معلّق قبل الإزالة: نتيجته المتأخرة تُزال بنفسها.
    generation += 1;
    const current = handle;
    handle = null;
    registration = null;
    launchHandled = false;
    await removeHandle(current);
  };

  return { register, unregister, isRegistered: () => handle !== null };
}
