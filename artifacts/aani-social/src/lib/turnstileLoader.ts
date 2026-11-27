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
  parentNode: Node | null;
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
  /**
   * مهلة التحميل الإجمالية لكل محاولة.
   * قيمة افتراضية آمنة ومحددة بحيث لا يبقى الاستطلاع أو الانتظار مفتوحاً بلا نهاية.
   */
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
  /**
   * إلغاء التحميل المعلق، مسح المؤقتات، وإزالة السكربت المملوك ONLY إن لم يكتمل تحميله بعد.
   * السكربت الذي اكتمل تحميله بنجاح يُحتفظ به ولا يُزال.
   */
  cancel(): void;
}

/** السكربت الافتراضي لTurnstile (عرض صريح، يتم استدعاء الودجت يدوياً). */
export const TURNSTILE_DEFAULT_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const SELECTOR = 'script[data-turnstile]';
/** مهلة تحميل افتراضية آمنة ومحددة (10 ثوانٍ) إن لم يُمرّر صريحاً. */
const DEFAULT_LOAD_TIMEOUT_MS = 10000;

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
    loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    onLoadError,
  } = options;

  const { document, window: win } = dom;
  const { setTimeout, clearTimeout } = clock;

  let cancelled = false;
  let isLoaded = false;
  let loadError = false;
  let retryCount = 0;
  let widgetId: string | number | null = null;

  /** المحاولة الجارية للتحميل (واحدة فقط في كل مرة)، تُnull عند الانتهاء أو الإلغاء. */
  let currentAttempt: { settled: boolean; abort: () => void } | null = null;
  /** مؤقت انتظار ما بين محاولات إعادة المحاولة، يُCleared قبل إعادة الضبط وعند الإلغاء. */
  let retryTimerId: unknown = null;
  /** دالة استئناف مؤقت النوم الحالي، تُستدعى عند الإلغاء لإيقاف الانتظار فوراً. */
  let sleepResolve: (() => void) | null = null;

  const clearRetryTimer = () => {
    if (retryTimerId !== null) {
      clearTimeout(retryTimerId);
      retryTimerId = null;
    }
  };

  const cancelSleep = () => {
    clearRetryTimer();
    const resolve = sleepResolve;
    if (resolve) {
      sleepResolve = null;
      resolve();
    }
  };

  /** إلغاء المحاولة الجارية فقط (إن وجدت)، بدون مسح سكربت اكتمل تحميله. */
  const abortCurrentAttempt = () => {
    cancelSleep();
    if (currentAttempt) {
      currentAttempt.abort();
      currentAttempt = null;
    }
  };

  const loadScript = (): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timers: unknown[] = [];
      const listeners: Array<{ el: TurnstileScript; ev: string; fn: () => void }> = [];
      let ownsScript = false;
      let script: TurnstileScript | null = null;
      /** مؤقت مهلة التحميل الإجمالية لهذه المحاولة فقط، يُمسح عند اكتمال تحميل العنصر. */
      let loadTimeoutTimerId: unknown = null;

      const trackTimer = (id: unknown): unknown => {
        timers.push(id);
        return id;
      };
      const trackListener = (el: TurnstileScript, ev: string, fn: () => void) => {
        listeners.push({ el, ev, fn });
      };

      /** مسح مؤقتات ومستمعات هذه المحاولة فقط، دون لمس السكريبت إن اكتمل تحميله. */
      const clearAttempt = () => {
        timers.forEach((id) => clearTimeout(id));
        timers.length = 0;
        loadTimeoutTimerId = null;
        listeners.forEach(({ el, ev, fn }) => {
          try { el.removeEventListener(ev, fn); } catch { }
        });
        listeners.length = 0;
      };

      /** مسح مؤقت المهلة الإجمالية إن بقي معلقاً بعد اكتمال تحميل العنصر. */
      const clearLoadTimeout = () => {
        if (loadTimeoutTimerId !== null) {
          clearTimeout(loadTimeoutTimerId);
          const i = timers.indexOf(loadTimeoutTimerId);
          if (i >= 0) timers.splice(i, 1);
          loadTimeoutTimerId = null;
        }
      };

      const finish = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        clearAttempt();
        if (currentAttempt === attempt) currentAttempt = null;
        if (ok) resolve(); else reject(err ?? new Error('Turnstile load failed'));
      };

      const attempt = {
        settled,
        abort: () => {
          if (settled) return;
          clearAttempt();
          // أزل السكريبت المملوك فقط إن لم يكتمل تحميله بعد؛ السكربت المحمّل بنجاح يُحتفظ به.
          if (ownsScript && script && script.parentNode) {
            try { script.parentNode.removeChild(script as unknown as Node); } catch { }
          }
          finish(false, new Error('Turnstile load cancelled'));
        },
      };
      currentAttempt = attempt;

      if (win.turnstile) {
        finish(true);
        return;
      }

      const existing = document.querySelector(SELECTOR);
      if (existing) {
        // اعتمد السكربت الموجود مسبقاً دون إعادة إنشائه ومن دون إزالته عند التنظيف.
        ownsScript = false;
        script = existing;

        const onReady = () => {
          if (!settled && win.turnstile) finish(true);
        };
        const onError = () => {
          if (!settled) finish(false, new Error('Failed to load Turnstile script'));
        };
        trackListener(script, 'load', onReady);
        trackListener(script, 'error', onError);
        script.addEventListener('load', onReady);
        script.addEventListener('error', onError);

        const poll = () => {
          if (settled) return;
          if (win.turnstile) {
            onReady();
            return;
          }
          trackTimer(setTimeout(poll, readyPollMs));
        };
        poll();
        return;
      }

      // إنشاء سكريبت مملوك جديد لهذه المحاولة.
      ownsScript = true;
      script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.defer = true;
      script.dataset.turnstile = 'true';

      const onLoad = () => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        // اكتمل تحميل العنصر، فلا حاجة لمهلة التحميل الإجمالية بعد الآن.
        clearLoadTimeout();
        trackTimer(setTimeout(() => {
          if (settled) return;
          if (win.turnstile) {
            finish(true);
          } else {
            clearAttempt();
            if (script && script.parentNode) {
              try { script.parentNode.removeChild(script as unknown as Node); } catch { }
            }
            finish(false, new Error('Turnstile API not initialized after script load'));
          }
        }, postLoadDelayMs));
      };

      const onError = () => {
        if (settled) return;
        clearAttempt();
        // أزل السكريبت الفاشل ومستمعاته ومؤقتاته قبل إعادة المحاولة، sodass تنشئ
        // المحاولة التالية عنصر سكريبت جديداً ولا تعيد استخدام عنصر فشل تحميله.
        if (script && script.parentNode) {
          try { script.parentNode.removeChild(script as unknown as Node); } catch { }
        }
        finish(false, new Error('Failed to load Turnstile script'));
      };

      trackListener(script, 'load', onLoad);
      trackListener(script, 'error', onError);
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      document.head.appendChild(script);

      loadTimeoutTimerId = trackTimer(setTimeout(() => {
        if (settled) return;
        clearAttempt();
        if (script && script.parentNode) {
          try { script.parentNode.removeChild(script as unknown as Node); } catch { }
        }
        finish(false, new Error('Turnstile script load timed out'));
      }, loadTimeoutMs));
    });

  const sleep = (delay: number): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        sleepResolve = null;
        retryTimerId = null;
        resolve();
      };
      const id = setTimeout(settle, delay);
      retryTimerId = id;
      sleepResolve = settle;
    });

  const execute = async () => {
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
      // لا شيء يُترك مفتوحاً: المؤقتات والمستمعات تُCleared في كل محاولة عبر clearAttempt.
    }
  };

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
      clearRetryTimer();
      abortCurrentAttempt();
      let resolveLoad: (() => void) | null = null;
      const promise = new Promise<void>((res) => {
        resolveLoad = res;
      });

      execute().finally(() => {
        resolveLoad?.();
      });
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
      abortCurrentAttempt();
    },
  };
}
