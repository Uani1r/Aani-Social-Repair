/**
 * turnstileLoader.ts
 * دورة حياة سكربت ودجت Cloudflare Turnstile: التحميل، إعادة المحاولة عند الفشل،
 * المهلة، الإلغاء، وتنظيف السكربت والمؤقتات والمستمعين.
 *
 * الوحدة مستقلة عن React وعن المتصفح الحقيقي: تُحقن فيها واجهة DOM بسيطة وساعة
 * مؤقت، ليُختبر منطق دورة الحياة عبر `tsx --test` باستخدام محاكيات DOM من دون
 * jsdom أو React Testing Library، ومن دون إضافة أي dependence جديدة.
 *
 * يحتفظ المنطق بنفس سلوك المصادقة الحالي (السكربت الموجود مسبقاً، الجاهزية،
 * حدث التحميل/الخطأ، إعادة المحاولة limitada بأساس 500ms وأقصى 3 محاولات،
 * science معرّف الودجت، التنظيف عند الإلغاء).
 */

export type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | number;
  reset: (widgetId?: string | number) => void;
  remove: (widgetId: string | number) => void;
};

export interface TurnstileScript {
  src: string;
  async: boolean;
  defer: boolean;
  dataset: Record<string, string>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface TurnstileDom {
  document: {
    head: {
      appendChild: (el: TurnstileScript) => void;
      removeChild: (el: TurnstileScript) => void;
    };
    querySelector: (selector: string) => TurnstileScript | null;
    createElement: (tag: 'script') => TurnstileScript;
  };
  window: { turnstile?: TurnstileApi };
}

export interface TurnstileClock {
  setTimeout: (cb: () => void, delay: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface TurnstileLoaderOptions {
  /** مفتاح الموقع العام لTurnstile (لا سر في الواجهة). */
  siteKey: string;
  /** الإجراء المُرسَل للخادم (phone_login). */
  action: string;
  /** رابط السكربت (يمكن تجاوزه في الاختبارات). */
  scriptUrl?: string;
  /** واجهة DOM (في الإنتاج تُمرّر `document`/`window` الحقيقية). */
  dom: TurnstileDom;
  /** ساعة المؤقت (في الإنتاج تُمرّر setTimeout/clearTimeout الحقيقية). */
  clock: TurnstileClock;
  /** عدد محاولات الإعادة القصوى بعد فشل التحميل. */
  maxRetries?: number;
  /** التأخير الأساسي بين المحاولات بالميلي ثانية (يُضاعف أسياً). */
  baseDelayMs?: number;
  /** مدة الفحص الدوري لجاهزية window.turnstile للمسكرة الموجودة مسبقاً. */
  readyPollMs?: number;
  /** المدة التي تُنتظر بعد حدث تحميل السكربت قبل الحكم على التهيئة. */
  postLoadDelayMs?: number;
  /** مهلة التحميل الإجمالية (بدون قيمة = لا مهلة، يحافظ على السلوك الحالي). */
  loadTimeoutMs?: number;
  /** يُستدعى عند نفاد محاولات الإعادة والتعذر النهائي للتحميل. */
  onLoadError?: () => void;
}

export interface TurnstileLoader {
  /** معرّف الودجت الحالي، أو null إن لم يُعرض بعد. */
  readonly widgetId: string | number | null;
  /** هل اكتمل التحميل وتوفّر window.turnstile. */
  readonly isLoaded: boolean;
  /** هل تعذر التحميل نهائياً بعد نفاد محاولات الإعادة. */
  readonly loadError: boolean;
  /** هل تم الإلغاء (يُمنع معها العرض والاستدعاءات المتأخرة). */
  readonly isCancelled: boolean;

  /** تحميل السكربت وتهيئة window.turnstile مع إعادة المحاولة عند الفشل. */
  load(): Promise<void>;
  /** عرض الودجت في الحاوية بعد التحميل. */
  mount(container: HTMLElement, onToken: (token: string) => void, onExpired: () => void, onError: () => void): void;
  /** إزالة الودجت من النافذة وإفراغ معرّفه (لا يمسح الرمز؛ يتولى المستدعي ذلك). */
  removeWidget(): void;
  /** إلغاء التحميل المعلق، مسح المؤقتات، إزالة السكربت المملوك، ومنع الاستدعاءات المتأخرة. */
  cancel(): void;
}

/** السكربت الافتراضي لTurnstile (عرض صريح، يتم استدعاء الودجت يدوياً). */
export const TURNSTILE_DEFAULT_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const SELECTOR = 'script[data-turnstile]';
const CANCELLED_ERROR = 'cancelled';

export function createTurnstileLoader(options: TurnstileLoaderOptions): TurnstileLoader {
  const {
    siteKey,
    action,
    scriptUrl = TURNSTILE_DEFAULT_SCRIPT,
    dom,
    clock,
    maxRetries = 3,
    baseDelayMs = 500,
    readyPollMs = 50,
    postLoadDelayMs = 50,
    loadTimeoutMs,
    onLoadError,
  } = options;

  const { document, window: win } = dom;
  const { setTimeout, clearTimeout } = clock;

  let cancelled = false;
  let isLoaded = false;
  let loadError = false;
  let retryCount = 0;
  let widgetId: string | number | null = null;
  let ownedScript: TurnstileScript | null = null;
  /** هل السكربت الحالي مملوك لهذه الوحدة (أي أنجزته هي)، أم جرى اعتماده من سكربت موجود مسبقاً. */
  let ownsScript = false;
  const pendingTimers = new Set<unknown>();
  const cancelListeners = new Set<() => void>();
  /** مؤقت نوم ما بين محاولات إعادة المحاولة، حتى يُCleared عند الإلغاء. */
  let sleepTimerId: unknown = null;

  const registerTimer = (id: unknown): unknown => {
    pendingTimers.add(id);
    return id;
  };

  const clearPendingTimers = () => {
    for (const id of pendingTimers) clearTimeout(id);
    pendingTimers.clear();
  };

  const removeOwnedScript = () => {
    // لا نزيل السكربت الذي كان موجوداً مسبقاً في الصفحة؛ نزيل فقط ما أنجزته هذه الوحدة.
    if (ownedScript && ownsScript) {
      document.head.removeChild(ownedScript);
    }
    ownedScript = null;
    ownsScript = false;
  };

  const settleCancel = () => {
    for (const fn of cancelListeners) fn();
    cancelListeners.clear();
  };

  /** مؤقّت يُستيقظ عند انقضاء المدة أو عند الإلغاء. */
  const sleep = (delay: number): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const id = registerTimer(setTimeout(settle, delay));
      sleepTimerId = id;
      cancelListeners.add(() => {
        clearTimeout(id);
        pendingTimers.delete(id);
        sleepTimerId = null;
        settle();
      });
    });

  const loadScript = (): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      /** المؤقتات التي جدولة هذه المحاولة فقط، تُCleared عند الانتهاء أو الإلغاء. */
      const attemptTimers = new Set<unknown>();
      const trackTimer = (id: unknown): unknown => {
        attemptTimers.add(id);
        return registerTimer(id);
      };
      const clearAttemptTimers = () => {
        for (const id of attemptTimers) {
          clearTimeout(id);
          pendingTimers.delete(id);
        }
        attemptTimers.clear();
      };
      const finish = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        clearAttemptTimers();
        if (ok) resolve(); else reject(err ?? new Error(CANCELLED_ERROR));
      };
      cancelListeners.add(() => finish(false));

      if (win.turnstile) {
        finish(true);
        return;
      }

      const existing = document.querySelector(SELECTOR);
      if (existing) {
        // اعتمد السكربت الموجود مسبقاً دون إعادة إنشائه ومن دون إزالته عند التنظيف.
        ownedScript = existing;
        ownsScript = false;

        const checkReady = () => {
          if (cancelled) { finish(false); return; }
          if (win.turnstile) {
            finish(true);
          } else {
            trackTimer(setTimeout(checkReady, readyPollMs));
          }
        };
        checkReady();

        const onError = () => {
          existing.removeEventListener('error', onError);
          finish(false, new Error('Failed to load Turnstile script'));
        };
        existing.addEventListener('error', onError);
        return;
      }

      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.defer = true;
      script.dataset.turnstile = 'true';
      ownedScript = script;
      ownsScript = true;

      const onLoad = () => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        trackTimer(setTimeout(() => {
          if (cancelled) { finish(false); return; }
          if (win.turnstile) {
            finish(true);
          } else {
            finish(false, new Error('Turnstile API not initialized after script load'));
          }
        }, postLoadDelayMs));
      };

      const onError = () => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        finish(false, new Error('Failed to load Turnstile script'));
      };

      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      document.head.appendChild(script);

      if (loadTimeoutMs !== undefined) {
        trackTimer(setTimeout(() => {
          if (cancelled) { finish(false); return; }
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          finish(false, new Error('Turnstile script load timeout'));
        }, loadTimeoutMs));
      }
    });

  return {
    get widgetId() {
      return widgetId;
    },
    get isLoaded() {
      return isLoaded;
    },
    get loadError() {
      return loadError;
    },
    get isCancelled() {
      return cancelled;
    },
    load() {
      cancelled = false;
      isLoaded = false;
      loadError = false;
      retryCount = 0;
      let resolveLoad: (() => void) | null = null;
      const promise = new Promise<void>((res) => {
        resolveLoad = res;
      });

      const run = async () => {
        try {
          while (!cancelled) {
            try {
              await loadScript();
            } catch {
              if (cancelled) break;
              if (retryCount < maxRetries) {
                retryCount += 1;
                const delay = baseDelayMs * Math.pow(2, retryCount - 1);
                try {
                  await sleep(delay);
                } catch {
                  if (cancelled) break;
                }
                continue;
              } else {
                loadError = true;
                onLoadError?.();
                break;
              }
            }
            if (cancelled) break;
            isLoaded = true;
            loadError = false;
            break;
          }
        } finally {
          resolveLoad?.();
        }
      };

      run();
      return promise;
    },
    mount(container, onToken, onExpired, onError) {
      if (cancelled || !container) return;
      const api = win.turnstile;
      if (!api) return;
      if (widgetId !== null) api.remove(widgetId);
      widgetId = api.render(container, {
        sitekey: siteKey,
        action,
        theme: 'light',
        language: 'ar',
        callback: (token: string) => {
          if (!cancelled) onToken(token);
        },
        'expired-callback': () => {
          if (!cancelled) onExpired();
        },
        'error-callback': () => {
          if (!cancelled) onError();
        },
      });
    },
    removeWidget() {
      const api = win.turnstile;
      if (api && widgetId !== null) {
        api.remove(widgetId);
        widgetId = null;
      }
    },
    cancel() {
      cancelled = true;
      settleCancel();
      clearPendingTimers();
      sleepTimerId = null;
      removeOwnedScript();
    },
  };
}
