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

// محاكاة عقدة DOM بسيطة لعنصر الرأس (head) لتتبع إضافة/إزالة السكربتات.
interface FakeHead extends TurnstileDom['document']['head'] {
  children: FakeScript[];
}

interface FakeScript extends TurnstileScript {
  dispatch: (type: string) => void;
  listenerCount: (type: string) => number;
}

function createScript(src = '', parentNode: FakeHead | null = null): FakeScript {
  const listeners = new Map<string, Set<() => void>>();
  const script = {
    src,
    async: false,
    defer: false,
    dataset: {} as Record<string, string>,
    parentNode,
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

function createHead(): FakeHead {
  const children: FakeScript[] = [];
  const head = {
    appendChild: (el: FakeScript) => {
      children.push(el);
      el.parentNode = head;
    },
    removeChild: (el: FakeScript) => {
      const i = children.indexOf(el);
      if (i >= 0) {
        children.splice(i, 1);
        el.parentNode = null;
      }
    },
    children,
  } as unknown as FakeHead;
  return head;
}

// يُفرّغ المهام الجزئية الميكروية حتى تستكمل سلاسل الوعود الداخلية للوحدة.
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
  readonly head: FakeHead;
  readonly created: FakeScript[];
}

function createDom(existing?: FakeScript): FakeDom {
  const head = createHead();
  const created: FakeScript[] = [];
  if (existing) head.appendChild(existing);
  return {
    document: {
      head,
      querySelector: (selector) => {
        if (selector === 'script[data-turnstile]') {
          return head.children.find((s) => s.dataset.turnstile === 'true') ?? null;
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

/* ------------------------------------------------------------------ */
/* الحالات الست المطلوبة من المراجعة                                   */
/* ------------------------------------------------------------------ */

test('فشل تحميل السكريبت الأول ثم إنشاء عنصر سكريبت جديد في إعادة المحاولة', async () => {
  const { loader, dom, clock } = createLoader({
    maxRetries: 1,
    loadTimeoutMs: 100,
    onLoadError: () => {},
  });

  const loadPromise = loader.load();
  assert.equal(dom.head.children.length, 1);
  const script1 = dom.head.children[0];
  assert.equal(script1.dataset.turnstile, 'true');

  // المحاولة الأولى تفشل → يُزال السكريبت الفاشل وتُجدَّد المحاولة بعد 500ms.
  script1.dispatch('error');
  await tick();
  assert.equal(dom.head.children.length, 0); // السكريبت الفاشل أُزيل
  assert.equal(clock.pending, 1); // مؤقت إعادة المحاولة
  assert.equal(clock.delays[0], 100);
  assert.equal(clock.delays[1], 500);

  clock.next();
  await tick();
  // المحاولة الثانية تنشئ عنصر سكريبت جديداً (لا تعيد استخدام الفاشل).
  assert.equal(dom.head.children.length, 1);
  const script2 = dom.head.children[0];
  assert.notEqual(script2, script1);
  assert.equal(dom.created.length, 2);

  script2.dispatch('error');
  await tick();
  assert.equal(dom.head.children.length, 0);
  assert.equal(loader.loadError, true);
  assert.equal(clock.pending, 0);

  await loadPromise;
  assert.equal(loader.isLoaded, false);
});

test('عدم حذف السكريبت بعد نجاح تحميله عند الإلغاء أو التنظيف', async () => {
  const { loader, dom, clock } = createLoader();
  const loadPromise = loader.load();

  const script = dom.head.children[0];
  assert.equal(dom.head.children.length, 1);

  script.dispatch('load');
  await tick();
  assert.equal(clock.pending, 1); // فحص الجاهزية بعد التحميل

  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next();
  await tick();

  await loadPromise;
  assert.equal(loader.isLoaded, true);
  assert.equal(dom.head.children.length, 1); // السكربت المحمّل يُحتفظ به

  // الإلغاء بعد النجاح لا يزيل السكربت المحمّل.
  loader.cancel();
  assert.equal(loader.isCancelled, true);
  assert.equal(dom.head.children.length, 1); // ما يزال موجوداً
  assert.equal(clock.pending, 0);
});

test('تنظيف مستمعات السكريبت الموجود مسبقاً عند النجاح والإلغاء والخطأ', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  const { loader, dom, clock } = createLoader({ dom: createDom(existing) });

  assert.equal(dom.head.children.length, 1);
  assert.equal(dom.created.length, 0);

  const loadPromise = loader.load();
  // يبدأ الاستطلاع الدوري ومهلة التحميل لكن السكريبت ليس مملوكاً لهذه الوحدة.
  assert.equal(existing.listenerCount('load'), 1);
  assert.equal(existing.listenerCount('error'), 1);
  assert.equal(clock.pending, 2);

  // النجاح → تُزال المستمعات ويُحتفظ بالسكريبت.
  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next();
  await tick();
  assert.equal(existing.listenerCount('load'), 0);
  assert.equal(existing.listenerCount('error'), 0);
  assert.equal(dom.head.children.length, 1);
  assert.equal(loader.isLoaded, true);
  assert.equal(clock.pending, 0);

  await loadPromise;
});

test('تنظيف مستمعات السكريبت الموجود مسبقاً عند الخطأ', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  let onLoadErrorCalls = 0;
  const { loader, dom } = createLoader({
    dom: createDom(existing),
    maxRetries: 0,
    onLoadError: () => { onLoadErrorCalls += 1; },
  });

  const loadPromise = loader.load();
  existing.dispatch('error');
  await tick();
  assert.equal(existing.listenerCount('load'), 0);
  assert.equal(existing.listenerCount('error'), 0);
  assert.equal(dom.head.children.length, 1); // السكربت الموجود مسبقاً لا يُزال
  assert.equal(onLoadErrorCalls, 1);
  assert.equal(loader.loadError, true);
  await loadPromise;
});

test('تنظيف مستمعات السكريبت الموجود مسبقاً عند الإلغاء', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  const { loader, dom, clock } = createLoader({ dom: createDom(existing) });

  const loadPromise = loader.load();
  loader.cancel();
  assert.equal(existing.listenerCount('load'), 0);
  assert.equal(existing.listenerCount('error'), 0);
  assert.equal(dom.head.children.length, 1); // لا يُزال لأنه مملوك مسبقاً
  assert.equal(loader.isCancelled, true);
  assert.equal(clock.pending, 0);
  await loadPromise;
});

test('مسار السكربت الموجود مسبقاً يطبق مهلة التحميل وينظّف مستمعاته دون حذفه', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  let onLoadErrorCalls = 0;
  const { loader, dom, clock } = createLoader({
    dom: createDom(existing),
    maxRetries: 0,
    loadTimeoutMs: 100,
    onLoadError: () => { onLoadErrorCalls += 1; },
  });

  const loadPromise = loader.load();
  assert.equal(existing.listenerCount('load'), 1);
  assert.equal(existing.listenerCount('error'), 1);
  // مؤقتا الاستطلاع والمهلة معلقان.
  assert.equal(clock.pending, 2);
  assert.equal(clock.delays[0], 50);
  assert.equal(clock.delays[1], 100);

  // انتهاء المهلة يُنهي المحاولة، ينظّم المستندات والمستمعات، ولا يحذف السكربت المشترك.
  clock.next();
  await tick();
  clock.next();
  await tick();
  assert.equal(existing.listenerCount('load'), 0);
  assert.equal(existing.listenerCount('error'), 0);
  assert.equal(dom.head.children.length, 1); // السكربت المشترك يبقى
  assert.equal(onLoadErrorCalls, 1);
  assert.equal(loader.loadError, true);
  assert.equal(loader.isLoaded, false);
  assert.equal(clock.pending, 0);

  await loadPromise;
});

test('استدعاء load() مرتين متتاليتين يلغي المحاولة المعلقة ومواردها', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  const { loader, dom, clock } = createLoader({
    dom: createDom(existing),
    maxRetries: 2,
    loadTimeoutMs: 100,
    readyPollMs: 50,
    onLoadError: () => {},
  });

  // المحاولة الأولى تبدأ الاستطلاع والمهلة.
  const p1 = loader.load();
  assert.equal(existing.listenerCount('load'), 1);
  assert.equal(existing.listenerCount('error'), 1);
  assert.equal(clock.pending, 2);

  // قبل استقرار المحاولة الأولى، استدعي load() مرة ثانية.
  const p2 = loader.load();
  // موارد المحاولة الأولى أُزيلت: مستmindعاتها مسحّة ومؤقتاتها مُمسَحة.
  assert.equal(existing.listenerCount('load'), 1);
  assert.equal(existing.listenerCount('error'), 1);
  assert.equal(clock.pending, 2); // مؤقتا المحاولة الجديدة فقط

  // اجعل المحاولة الجديدة تنجح عبر تجهيز window.turnstile ثم تشغيل الاستطلاع.
  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next(); // تشغيل مؤقت الاستطلاع للمحاولة الجديدة → onReady → finish(true)
  await tick();
  assert.equal(clock.pending, 0);
  await p2;
  assert.equal(loader.isLoaded, true);
  assert.equal(loader.loadError, false);

  // وعد المحاولة الأولى يُحَلّ (بالإلغاء) ولا يبقى معلقاً، ولا تُStarted إعادة محاولة لها.
  await p1.then(() => {}, () => {});
  assert.equal(dom.head.children.length, 1); // السكربت المشترك لا يُزال
});

test('انتهاء المهلة ومنع الانتظار المستمر', async () => {
  let onLoadErrorCalls = 0;
  const { loader, dom, clock } = createLoader({
    maxRetries: 0,
    loadTimeoutMs: 100,
    onLoadError: () => { onLoadErrorCalls += 1; },
  });

  const loadPromise = loader.load();
  assert.equal(dom.head.children.length, 1);
  assert.equal(clock.pending, 1); // مؤقت المهلة فقط، لا استطلاع مفتوح بلا نهاية
  assert.equal(clock.delays[0], 100);

  clock.next();
  await tick();
  assert.equal(onLoadErrorCalls, 1);
  assert.equal(loader.loadError, true);
  assert.equal(loader.isLoaded, false);
  assert.equal(clock.pending, 0);
  assert.equal(dom.head.children.length, 0); // السكريبت الفاشل أُزيل

  // وعد load() يُحَلّ ولا يبقى معلقاً.
  await loadPromise;
});

test('إلغاء التحميل يمنع إعادة المحاولة أو تعديل الحالة بعد الإلغاء', async () => {
  const { loader, dom, clock } = createLoader({
    maxRetries: 3,
    loadTimeoutMs: 100,
    onLoadError: () => {},
  });

  const loadPromise = loader.load();
  const script = dom.head.children[0];
  assert.equal(clock.pending, 1);

  script.dispatch('error');
  await tick();
  assert.equal(clock.pending, 1); // transient: مؤقت إعادة المحاولة قيد الجدولة
  assert.equal(clock.delays[0], 100);
  assert.equal(clock.delays[1], 500);

  // الإلغاء قبل الموعد التالي يمنع إعادة المحاولة وتعديل الحالة.
  loader.cancel();
  assert.equal(loader.isCancelled, true);
  assert.equal(clock.pending, 0); // مؤقّت إعادة المحاولة مُمسَح

  clock.next();
  await tick();
  // لا محاكمة جديدة، لا سكريبت جديد، لا خطأ تحميل نهائي.
  assert.equal(dom.head.children.length, 0);
  assert.equal(loader.loadError, false);
  assert.equal(loader.isLoaded, false);

  await loadPromise;
});

test('عدم تسرب المؤقتات والمستمعات بعد انتهاء كل محاولة', async () => {
  // محاولة ناجحة.
  const { loader: l1, dom: d1, clock: c1 } = createLoader();
  const p1 = l1.load();
  const s1 = d1.head.children[0];
  s1.dispatch('load');
  await tick();
  assert.equal(c1.pending, 1); // فحص الجاهزية بعد التحميل
  d1.window.turnstile = {} as unknown as TurnstileApi;
  c1.next();
  await tick();
  await p1;
  assert.equal(l1.isLoaded, true);
  assert.equal(c1.pending, 0);
  assert.equal(s1.listenerCount('load'), 0);
  assert.equal(s1.listenerCount('error'), 0);

  // محاولة فاشلة تنفد بعد إعادة محاولة واحدة، ولا تبقى مؤقتات أو مستمعات.
  const { loader: l2, dom: d2, clock: c2 } = createLoader({
    maxRetries: 1,
    loadTimeoutMs: 100,
    onLoadError: () => {},
  });
  const p2 = l2.load();
  const s2 = d2.head.children[0];
  assert.equal(c2.pending, 1); // مؤقت المهلة فقط
  s2.dispatch('error');
  await tick();
  assert.equal(c2.pending, 1); // مؤقت إعادة المحاولة (500ms)
  assert.equal(s2.listenerCount('load'), 0);
  assert.equal(s2.listenerCount('error'), 0);
  assert.equal(d2.head.children.length, 0); // السكريبت الفاشل أُزيل

  c2.next();
  await tick();
  const s3 = d2.head.children[0];
  assert.notEqual(s3, s2); // عنصر سكريبت جديد في إعادة المحاولة
  assert.equal(c2.pending, 1); // مؤقت مهلة المحاولة الجديدة
  s3.dispatch('error');
  await tick();
  assert.equal(c2.pending, 0);
  assert.equal(s3.listenerCount('load'), 0);
  assert.equal(s3.listenerCount('error'), 0);
  assert.equal(l2.loadError, true);
  assert.equal(d2.head.children.length, 0); // السكريبت الثاني أُزيل أيضاً

  await p2;
});

/* ------------------------------------------------------------------ */
/* التغطية العامة للوحدة                                               */
/* ------------------------------------------------------------------ */

test('تُنشئ السكربت بالسِمات الصحيحة وتتملكه', async () => {
  const { loader, dom, clock } = createLoader();
  const loadPromise = loader.load();

  assert.equal(dom.head.children.length, 1);
  const script = dom.head.children[0];
  assert.equal(script.src, TURNSTILE_DEFAULT_SCRIPT);
  assert.equal(script.async, true);
  assert.equal(script.defer, true);
  assert.equal(script.dataset.turnstile, 'true');
  assert.equal(loader.isLoaded, false);
  assert.equal(loader.isCancelled, false);
  assert.equal(clock.pending, 1); // مؤقت المهلة الافتراضية معلق

  script.dispatch('load');
  await tick();
  assert.equal(clock.pending, 1); // فحص الجاهزية بعد التحميل
  assert.equal(script.listenerCount('load'), 0);
  assert.equal(script.listenerCount('error'), 0);

  loader.cancel();
  assert.equal(loader.isCancelled, true);
  assert.equal(clock.pending, 0);
  assert.equal(dom.head.children.length, 0); // السكربت المملوك غير المحمّل يُزال

  await loadPromise;
});

test('يُعاد استخدام السكربت الموجود مسبقاً ولا يُنشأ سكريبت جديد ولا يُزال', async () => {
  const existing = createScript();
  existing.dataset.turnstile = 'true';
  const { loader, dom, clock } = createLoader({ dom: createDom(existing) });

  assert.equal(dom.head.children.length, 1);
  assert.equal(dom.created.length, 0);

  const loadPromise = loader.load();
  assert.equal(dom.head.children.length, 1); // لا يُنشأ جديد
  assert.equal(dom.created.length, 0);
  assert.equal(clock.pending, 2); // استطلاع الجاهزية الدوري + مهلة التحميل

  loader.cancel();
  assert.equal(dom.head.children.length, 1); // السكربت الموجود مسبقاً يبقى
  assert.equal(clock.pending, 0);

  await loadPromise;
});

test('يُحَلّ فوراً عندما يكون Turnstile جاهزاً بالفعل', async () => {
  const { loader, dom, clock } = createLoader();
  dom.window.turnstile = {} as unknown as TurnstileApi;

  await loader.load();

  assert.equal(loader.isLoaded, true);
  assert.equal(loader.loadError, false);
  assert.equal(dom.head.children.length, 0);
  assert.equal(clock.pending, 0);
});

test('الإلغاء يُفرّغ المؤقتات ويمنع عرض الودجت', async () => {
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

test('يُرسِل الودجت بالخيارات الصحيحة عند mounting', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  assert.equal(loader.isLoaded, true);

  const container = {} as HTMLElement;
  loader.mount(container, () => {}, () => {}, () => {});

  assert.equal(api.renders.length, 1);
  assert.equal(api.renders[0].options.sitekey, 'site-key');
  assert.equal(api.renders[0].options.action, 'phone_login');
  assert.equal(api.renders[0].options.theme, 'light');
  assert.equal(api.renders[0].options.language, 'ar');
  assert.equal(typeof api.renders[0].options.callback, 'function');
  assert.equal(loader.widgetId, 'widget-1');
});

test('يُزال الودجت السابق قبل إعادة العرض عند استدعاء mount مراراً', async () => {
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

test('يُفرغ removeWidget معرّف الودجت', async () => {
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

test('mount لا يفعل شيئاً بعد الإلغاء', async () => {
  const { loader, dom } = createLoader();
  const api = createApi();
  dom.window.turnstile = api;

  await loader.load();
  loader.cancel();

  loader.mount({}, () => {}, () => {}, () => {});
  assert.equal(api.renders.length, 0);
  assert.equal(loader.widgetId, null);
});

test('يمنع الاستدعاءات المتأخرة للرسائل بعد الإلغاء', async () => {
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
    (token) => { tokenCalled += 1; },
    () => { expiredCalled += 1; },
    () => { errorCalled += 1; },
  );

  const options = api.renders[0].options;
  loader.cancel();

  (options.callback as (token: string) => void)('some-token');
  (options['expired-callback'] as () => void)();
  (options['error-callback'] as () => void)();

  assert.equal(tokenCalled, 0);
  assert.equal(expiredCalled, 0);
  assert.equal(errorCalled, 0);
});

test('تُزال مستمعات التحميل/الخطأ بعد تحميل السكربت', async () => {
  const { loader, dom, clock } = createLoader();
  const loadPromise = loader.load();

  const script = dom.head.children[0];
  assert.equal(script.listenerCount('load'), 1);
  assert.equal(script.listenerCount('error'), 1);

  script.dispatch('load');
  assert.equal(clock.pending, 1);
  assert.equal(script.listenerCount('load'), 0);
  assert.equal(script.listenerCount('error'), 0);

  dom.window.turnstile = {} as unknown as TurnstileApi;
  clock.next();
  await tick();

  await loadPromise;
  assert.equal(loader.isLoaded, true);
});
