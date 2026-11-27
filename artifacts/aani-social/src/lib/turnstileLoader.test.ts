import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurnstileLoader,
  type TurnstileApi,
  type TurnstileClock,
  type TurnstileDom,
  type TurnstileLoaderOptions,
  type TurnstileScript,
  TURNSTILE_DEFAULT_SCRIPT,
} from './turnstileLoader';

interface FakeScript extends TurnstileScript {
  dispatch: (type: string) => void;
  listenerCount: (type: string) => number;
}

function createScript(src = ''): FakeScript {
  const listeners = new Map<string, Set<() => void>>();
  const script = {
    src,
    async: false,
    defer: false,
    dataset: {} as Record<string, string>,
    addEventListener: (type: string, listener: () => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string) => {
      const set = listeners.get(type);
      if (set) {
        for (const cb of [...set]) cb();
      }
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  } as unknown as FakeScript;
  return script;
}

// يُفرّغ المهام الجزئية الميكروية حتى تستكمل سلاسل الوعود الداخلية للوحدة (إعادة المحاولة إلخ).
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeClock extends TurnstileClock {
  next: () => boolean;
  runAll: () => number;
  readonly pending: number;
  readonly delays: number[];
}

function createClock(): FakeClock {
  const timers: Array<{ id: number; cb: () => void; delay: number }> = [];
  let nextId = 1;
  const delays: number[] = [];
  return {
    setTimeout: (cb, delay) => {
      const id = nextId++;
      delays.push(delay);
      timers.push({ id, cb, delay });
      return id;
    },
    clearTimeout: (id) => {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    },
    next: () => {
      const t = timers.shift();
      if (!t) return false;
      t.cb();
      return true;
    },
    runAll: () => {
      let count = 0;
      while (timers.length > 0 && count++ < 10000) {
        timers.shift()!.cb();
      }
      return count;
    },
    get pending() {
      return timers.length;
    },
    delays,
  };
}

interface FakeDom extends TurnstileDom {
  readonly head: FakeScript[];
  readonly created: FakeScript[];
}

function createDom(existing?: FakeScript): FakeDom {
  const head: FakeScript[] = existing ? [existing] : [];
  const created: FakeScript[] = [];
  return {
    document: {
      head: {
        appendChild: (el) => head.push(el),
        removeChild: (el) => {
          const i = head.indexOf(el);
          if (i >= 0) head.splice(i, 1);
        },
      },
      querySelector: (selector) => {
        if (selector === 'script[data-turnstile]') {
          return head.find((s) => s.dataset.turnstile === 'true') ?? null;
        }
        return null;
      },
      createElement: () => {
        const s = createScript();
        created.push(s);
        return s;
      },
    },
    window: { turnstile: undefined as unknown as TurnstileApi | undefined },
    get head() {
      return head;
    },
    created,
  };
}

interface FakeApi extends TurnstileApi {
  renders: Array<{ container: HTMLElement; options: Record<string, unknown> }>;
  removed: Array<string | number>;
  resetCalls: number;
}

function createApi(): FakeApi {
  const renders: Array<{ container: HTMLElement; options: Record<string, unknown> }> = [];
  const removed: Array<string | number> = [];
  let resetCalls = 0;
  return {
    render: (container, options) => {
      renders.push({ container, options });
      return `widget-${renders.length}`;
    },
    reset: () => {
      resetCalls += 1;
    },
    remove: (id) => {
      removed.push(id);
    },
    renders,
    removed,
    get resetCalls() {
      return resetCalls;
    },
  } as unknown as FakeApi;
}

interface LoaderHarness {
  loader: ReturnType<typeof createTurnstileLoader>;
  dom: FakeDom;
  clock: FakeClock;
}

function createLoader(opts: Partial<TurnstileLoaderOptions> & { dom?: FakeDom; clock?: FakeClock } = {}): LoaderHarness {
  const dom = opts.dom ?? createDom();
  const clock = opts.clock ?? createClock();
  const loader = createTurnstileLoader({
    siteKey: opts.siteKey ?? 'site-key',
    action: opts.action ?? 'phone_login',
    scriptUrl: opts.scriptUrl,
    dom,
    clock,
    maxRetries: opts.maxRetries ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 500,
    readyPollMs: opts.readyPollMs ?? 50,
    postLoadDelayMs: opts.postLoadDelayMs ?? 50,
    loadTimeoutMs: opts.loadTimeoutMs,
    onLoadError: opts.onLoadError,
  });
  return { loader, dom, clock };
}

test('turnstileLoader creates the script with correct attributes and owns it', async () => {
  const { loader, dom, clock } = createLoader();
  const loadPromise = loader.load();

  assert.equal(dom.head.length, 1);
  const script = dom.head[0];
  assert.equal(script.src, TURNSTILE_DEFAULT_SCRIPT);
  assert.equal(script.async, true);
  assert.equal(script.defer, true);
  assert.equal(script.dataset.turnstile, 'true');
  assert.equal(loader.isLoaded, false);
  assert.equal(loader.isCancelled, false);
  // لا مؤقت حتى يُحذَف حدث التحميل (الانتظار على حدث load)
  assert.equal(clock.pending, 0);

  script.dispatch('load');
  assert.equal(clock.pending, 1); // فحص الجاهزية بعد التحميل
  assert.equal(script.listenerCount('load'), 0);
  assert.equal(script.listenerCount('error'), 0);

  loader.cancel();
  assert.equal(loader.isCancelled, true);
  assert.equal(clock.pending, 0); // المؤقتات مُمسَحة
  assert.equal(dom.head.length, 0); // السكربت المملوك مُزال

  await loadPromise;
});

test('turnstileLoader reuses a pre-existing script and does not remove it', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  const { loader, dom, clock } = createLoader({ dom: createDom(existing) });

  assert.equal(dom.head.length, 1);
  assert.equal(dom.created.length, 0);

  const loadPromise = loader.load();
  assert.equal(dom.head.length, 1); // لا يُنشأ سكربت جديد
  assert.equal(dom.created.length, 0);
  assert.equal(clock.pending, 1); // استطلاع الجاهزية الدوري

  loader.cancel();
  assert.equal(dom.head.length, 1); // السكربت المُسبق الوجود يبقى
  assert.equal(clock.pending, 0);

  await loadPromise;
});

test('turnstileLoader resolves immediately when Turnstile is already ready', async () => {
  const { loader, dom, clock } = createLoader();
  dom.window.turnstile = {} as unknown as TurnstileApi;

  await loader.load();

  assert.equal(loader.isLoaded, true);
  assert.equal(loader.loadError, false);
  assert.equal(dom.head.length, 0); // لا يُنشأ سكربت
  assert.equal(clock.pending, 0);
});

test('turnstileLoader cancellation clears timers and prevents mounting', async () => {
  const { loader, dom, clock } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  loader.load();
  loader.cancel();

  assert.equal(clock.pending, 0);

  const container = {} as HTMLElement;
  let rendered = false;
  loader.mount(container, () => { rendered = true; }, () => {}, () => {});
  assert.equal(rendered, false);
  assert.equal(api.renders.length, 0);
  assert.equal(loader.widgetId, null);
});

test('turnstileLoader timeout reports load error without retries', async () => {
  let onLoadErrorCalls = 0;
  const { loader, dom, clock } = createLoader({
    maxRetries: 0,
    loadTimeoutMs: 100,
    onLoadError: () => {
      onLoadErrorCalls += 1;
    },
  });

  const loadPromise = loader.load();
  assert.equal(dom.head.length, 1);
  assert.equal(clock.pending, 1); // عداد مهلة التحميل
  assert.equal(clock.delays[0], 100);

  clock.next();
  await tick();
  assert.equal(onLoadErrorCalls, 1);
  assert.equal(loader.loadError, true);
  assert.equal(clock.pending, 0);

  await loadPromise;
  assert.equal(loader.isLoaded, false);
});

test('turnstileLoader script error retries with backoff then exhausts', async () => {
  let onLoadErrorCalls = 0;
  const { loader, dom, clock } = createLoader({
    maxRetries: 2,
    onLoadError: () => {
      onLoadErrorCalls += 1;
    },
  });

  const loadPromise = loader.load();
  const script = dom.head[0];
  assert.equal(clock.pending, 0); // الانتظار على حدث، لا مؤقت بعد
  assert.equal(dom.created.length, 1);

  // المحاولة 1 تفشل -> إعادة محاولة بعد 500ms
  script.dispatch('error');
  await tick();
  assert.equal(clock.delays[0], 500);

  // المحاولة 2 تعيد استخدام السكربت الموجود وتستطلع -> إعادة محاولة بعد 1000ms
  clock.next();
  await tick();
  assert.equal(clock.delays[1], 50);
  script.dispatch('error');
  await tick();
  assert.equal(clock.delays[2], 1000);

  // المحاولة 3 تفشل -> النفاد
  clock.next();
  await tick();
  assert.equal(clock.delays[3], 50);
  script.dispatch('error');
  await tick();

  assert.equal(onLoadErrorCalls, 1);
  assert.equal(loader.loadError, true);

  await loadPromise;
  assert.equal(loader.isLoaded, false);
});

test('turnstileLoader recovers on retry and loads successfully', async () => {
  let onLoadErrorCalls = 0;
  const { loader, dom, clock } = createLoader({
    maxRetries: 2,
    onLoadError: () => {
      onLoadErrorCalls += 1;
    },
  });

  const loadPromise = loader.load();
  const script1 = dom.head[0];
  script1.dispatch('error');
  await tick();
  assert.equal(clock.pending, 1);
  assert.equal(clock.delays[0], 500);

  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next();
  await tick();

  await loadPromise;
  assert.equal(loader.isLoaded, true);
  assert.equal(loader.loadError, false);
  assert.equal(onLoadErrorCalls, 0);
});

test('turnstileLoader mount renders the widget with the correct options', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  assert.equal(loader.isLoaded, true);

  const container = {} as HTMLElement;
  let tokenCaptured: string | null = null;
  loader.mount(container, (token) => { tokenCaptured = token; }, () => {}, () => {});

  assert.equal(api.renders.length, 1);
  assert.equal(api.renders[0].options.sitekey, 'site-key');
  assert.equal(api.renders[0].options.action, 'phone_login');
  assert.equal(api.renders[0].options.theme, 'light');
  assert.equal(api.renders[0].options.language, 'ar');
  assert.equal(typeof api.renders[0].options.callback, 'function');
  assert.equal(loader.widgetId, 'widget-1');
});

test('turnstileLoader mount removes the previous widget before rendering again', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  loader.mount({}, () => {}, () => {}, () => {});
  assert.equal(api.removed.length, 0);
  assert.equal(loader.widgetId, 'widget-1');

  loader.mount({}, () => {}, () => {}, () => {});
  assert.equal(api.renders.length, 2);
  assert.equal(api.removed.length, 1);
  assert.equal(api.removed[0], 'widget-1');
  assert.equal(loader.widgetId, 'widget-2');
});

test('turnstileLoader removeWidget clears the widget id', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  loader.mount({}, () => {}, () => {}, () => {});
  assert.equal(loader.widgetId, 'widget-1');

  loader.removeWidget();
  assert.equal(api.removed.length, 1);
  assert.equal(api.removed[0], 'widget-1');
  assert.equal(loader.widgetId, null);
});

test('turnstileLoader mount is a no-op after cancel', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  loader.cancel();

  loader.mount({}, () => {}, () => {}, () => {});
  assert.equal(api.renders.length, 0);
  assert.equal(loader.widgetId, null);
});

test('turnstileLoader prevents late render callbacks after cancel', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  const container = {} as HTMLElement;
  let tokenCalled = 0;
  let expiredCalled = 0;
  let errorCalled = 0;
  loader.mount(
    container,
    (token) => {
      tokenCalled += 1;
    },
    () => {
      expiredCalled += 1;
    },
    () => {
      errorCalled += 1;
    },
  );

  const options = api.renders[0].options;
  loader.cancel();

  // محاكاة استدعاءات الودجت المتأخرة بعد الإزالة
  (options.callback as (token: string) => void)('some-token');
  (options['expired-callback'] as () => void)();
  (options['error-callback'] as () => void)();

  assert.equal(tokenCalled, 0);
  assert.equal(expiredCalled, 0);
  assert.equal(errorCalled, 0);
});

test('turnstileLoader removes load/error listeners after the script loads', async () => {
  const { loader, dom, clock } = createLoader();
  const loadPromise = loader.load();

  const script = dom.head[0];
  assert.equal(script.listenerCount('load'), 1);
  assert.equal(script.listenerCount('error'), 1);

  script.dispatch('load');
  assert.equal(clock.pending, 1); // فحص الجاهزية بعد التحميل
  assert.equal(script.listenerCount('load'), 0);
  assert.equal(script.listenerCount('error'), 0);

  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next();
  await tick();

  await loadPromise;
  assert.equal(loader.isLoaded, true);
});
