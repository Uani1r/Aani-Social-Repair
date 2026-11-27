/**
 * اختبارات Google OAuth الأصلي (iOS/Android).
 *
 * يُشغَّل بـ: tsx --test ./src/lib/oauthNative.test.ts
 * بلا جهاز ولا شبكة ولا مفاتيح: Capacitor (App/Browser) وSupabase Auth
 * بمحاكاة كاملة تُحقن في البوّابة، فتُختبر الدورة كلها من ضغط الزر إلى
 * إنشاء الجلسة، ومعها كل حالات الفشل والإلغاء وإعادة المحاولة والتكرار.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_OAUTH_CANCEL_MESSAGE,
  createNativeOAuthGate,
  createNativeOAuthUrlListener,
  describeNativeOAuthError,
  nativeOAuthDecision,
  parseOAuthCallback,
  type ListenerHandle,
  type NativeOAuthDeps,
  type NativeOAuthResult,
  type NativeOAuthUrlListenerDeps,
} from './oauthNativeCore';
import {
  NATIVE_OAUTH_REDIRECT_URL,
  getOAuthRedirectUrl,
  isNativePlatform as isNativePlatformFromRedirect,
} from './oauthRedirect';

const CALLBACK = 'anisocial://auth/callback?code=code-1';
const SESSION = { access_token: 'token' };

type FakePlatform = {
  deps: NativeOAuthDeps;
  opened: string[];
  closed: number;
  signInCalls: number;
  exchangeCalls: string[];
  emitted: NativeOAuthResult[];
  /** إغلاق المتصفح بيد المستخدم كما يفعل حدث browserFinished. */
  finishBrowser: () => void;
  browserListeners: () => number;
};

type FakeOptions = {
  /** روابط OAuth بالترتيب: كل نداء SignIn يستهلك عنصراً، والأخير يُعاد بعده. */
  urls?: Array<string | null>;
  signInError?: unknown;
  signInThrows?: boolean;
  openThrows?: boolean;
  exchangeError?: unknown;
  exchangeThrows?: boolean;
  session?: unknown;
  exchangeDelay?: Promise<void>;
};

/** محاكاة Supabase Auth + Capacitor Browser في كائن واحد قابل للقياس. */
function createFakePlatform(options: FakeOptions = {}): FakePlatform {
  const opened: string[] = [];
  const exchangeCalls: string[] = [];
  const emitted: NativeOAuthResult[] = [];
  const finishedHandlers: Array<() => void> = [];
  const state = { closed: 0, signInCalls: 0 };

  const deps: NativeOAuthDeps = {
    async signInWithOAuth() {
      state.signInCalls += 1;
      if (options.signInThrows) throw new Error('network');
      if (options.signInError) return { url: null, error: options.signInError };
      const urls = options.urls ?? ['https://accounts.google.com/o/oauth2/auth'];
      const url = urls.length > 1 ? urls.shift() ?? null : urls[0] ?? null;
      return { url, error: null };
    },
    async exchangeCodeForSession(code) {
      exchangeCalls.push(code);
      if (options.exchangeDelay) await options.exchangeDelay;
      if (options.exchangeThrows) throw new Error('network');
      if (options.exchangeError) return { session: null, error: options.exchangeError };
      return { session: options.session === undefined ? SESSION : options.session, error: null };
    },
    async openBrowser(url) {
      if (options.openThrows) throw new Error('cannot open');
      opened.push(url);
    },
    async closeBrowser() {
      state.closed += 1;
    },
    async onBrowserFinished(handler) {
      finishedHandlers.push(handler);
      return {
        remove: () => {
          const index = finishedHandlers.indexOf(handler);
          if (index >= 0) finishedHandlers.splice(index, 1);
        },
      };
    },
  };

  return {
    deps,
    opened,
    exchangeCalls,
    emitted,
    get closed() {
      return state.closed;
    },
    get signInCalls() {
      return state.signInCalls;
    },
    finishBrowser() {
      for (const handler of [...finishedHandlers]) handler();
    },
    browserListeners: () => finishedHandlers.length,
  } as FakePlatform;
}

function createGate(platform: FakePlatform) {
  const gate = createNativeOAuthGate(platform.deps);
  gate.subscribe(result => platform.emitted.push(result));
  return gate;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(settle => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

test('تحليل رابط العودة: رمز صالح أو خطأ صريح', () => {
  const valid = parseOAuthCallback(CALLBACK);
  assert.equal(valid.ok, true);
  assert.equal(valid.code, 'code-1');

  assert.equal(parseOAuthCallback('https://auth/callback?code=x').ok, false);
  assert.equal(parseOAuthCallback('anisocial://other/callback?code=x').ok, false);
  assert.equal(parseOAuthCallback('anisocial://auth/other?code=x').ok, false);
  assert.equal(parseOAuthCallback('anisocial://auth/callback?state=1').error, 'missing_code');
  assert.equal(parseOAuthCallback('anisocial://auth/callback?error=access_denied').error, 'access_denied');
});

test('بدء OAuth ناجح يفتح المتصفح برابط Supabase', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);

  const started = await gate.start();

  assert.equal(started.ok, true);
  assert.equal(started.attempt, 1);
  assert.deepEqual(platform.opened, ['https://accounts.google.com/o/oauth2/auth']);
  assert.equal(platform.signInCalls, 1);
  assert.equal(platform.browserListeners(), 1);
  assert.equal(gate.isInFlight(), true);
});

test('غياب data.url بلا خطأ: فشل واضح وتحرير المحاولة', async () => {
  // النداء الأول بلا رابط (بلا خطأ)، والثاني برابط: إعادة المحاولة تنجح.
  const platform = createFakePlatform({
    urls: [null, 'https://accounts.google.com/o/oauth2/auth'],
  });
  const gate = createGate(platform);

  const failed = await gate.start();

  assert.deepEqual(failed, { ok: false, error: 'oauth_url_missing' });
  assert.deepEqual(platform.opened, []);
  assert.equal(gate.isInFlight(), false);
  assert.equal(platform.browserListeners(), 0);

  // إعادة المحاولة ممكنة فوراً، ورقم المحاولة جديد.
  const retry = await gate.start();
  assert.equal(retry.ok, true);
  assert.equal(retry.attempt, 2);
});

test('فشل signInWithOAuth يُعيد الفشل ويسمح بإعادة المحاولة', async () => {
  const platform = createFakePlatform({ signInError: { message: 'provider disabled' } });
  const gate = createGate(platform);

  assert.deepEqual(await gate.start(), { ok: false, error: 'oauth_start_failed' });
  assert.equal(gate.isInFlight(), false);
  assert.equal(platform.emitted.length, 0, 'فشل البدء يُعرض من المستدعي بلا نتيجة مكررة');

  const throwing = createGate(createFakePlatform({ signInThrows: true }));
  assert.deepEqual(await throwing.start(), { ok: false, error: 'oauth_start_failed' });
  assert.equal(throwing.isInFlight(), false);
});

test('فشل فتح المتصفح يُعيد browser_open_failed ويسمح بإعادة المحاولة', async () => {
  const platform = createFakePlatform({ openThrows: true });
  const gate = createGate(platform);

  assert.deepEqual(await gate.start(), { ok: false, error: 'browser_open_failed' });
  assert.equal(gate.isInFlight(), false);
  assert.equal(platform.browserListeners(), 0, 'مستمع الإغلاق يُزال عند فشل الفتح');
});

test('محاولتان متزامنتان: الثانية مرفوضة والبدء مرة واحدة', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);

  const [first, second] = await Promise.all([gate.start(), gate.start()]);

  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, error: 'in_progress' });
  assert.equal(platform.signInCalls, 1);
});

test('نجاح التبادل: جلسة واحدة، إغلاق المتصفح، ونتيجة واحدة', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();

  const result = await gate.handleUrl(CALLBACK);

  assert.deepEqual(result, { ok: true, attempt: 1 });
  assert.deepEqual(platform.exchangeCalls, ['code-1']);
  assert.equal(platform.closed, 1);
  assert.equal(gate.isInFlight(), false);
  assert.deepEqual(platform.emitted, [{ ok: true, attempt: 1 }]);
});

test('فشل التبادل: نتيجة فشل مرة واحدة وتحرير المحاولة', async () => {
  const platform = createFakePlatform({ exchangeError: { message: 'invalid grant' } });
  const gate = createGate(platform);
  await gate.start();

  const result = await gate.handleUrl(CALLBACK);

  assert.deepEqual(result, { ok: false, error: 'oauth_exchange_failed', attempt: 1 });
  assert.equal(gate.isInFlight(), false);
  assert.equal(platform.closed, 0, 'لا إغلاق عند فشل التبادل');
  assert.equal(platform.emitted.length, 1);

  const throwing = createGate(createFakePlatform({ exchangeThrows: true }));
  await throwing.start();
  assert.deepEqual(await throwing.handleUrl(CALLBACK), {
    ok: false,
    error: 'oauth_exchange_failed',
    attempt: 1,
  });
});

test('لا جلسة بعد التبادل: session_not_created', async () => {
  const platform = createFakePlatform({ session: null });
  const gate = createGate(platform);
  await gate.start();

  assert.deepEqual(await gate.handleUrl(CALLBACK), {
    ok: false,
    error: 'session_not_created',
    attempt: 1,
  });
  assert.equal(platform.closed, 0);
});

test('تبادل مكرر متزامن لنفس الرمز: محاولة تبادل واحدة', async () => {
  const release = deferred();
  const platform = createFakePlatform({ exchangeDelay: release.promise });
  const gate = createGate(platform);
  await gate.start();

  const first = gate.handleUrl(CALLBACK);
  const second = gate.handleUrl(CALLBACK);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(a, { ok: true, attempt: 1 });
  assert.deepEqual(b, { ok: true, attempt: 1 });
  assert.deepEqual(platform.exchangeCalls, ['code-1'], 'الرمز لا يُبادل مرتين');
  assert.equal(platform.emitted.length, 1, 'نتيجة واحدة فقط');
});

test('callback مكرر بعد الاكتمال: لا تبادل ثانٍ ولا نتيجة ثانية', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();
  await gate.handleUrl(CALLBACK);

  const repeat = await gate.handleUrl(CALLBACK);

  assert.equal(repeat.ok, true);
  assert.deepEqual(platform.exchangeCalls, ['code-1']);
  assert.equal(platform.emitted.length, 1);
  assert.equal(platform.closed, 1, 'لا إغلاق ثانٍ');
});

test('إغلاق المتصفح بيد المستخدم = إلغاء صريح وإعادة محاولة', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();

  platform.finishBrowser();

  assert.deepEqual(platform.emitted, [
    { ok: false, error: 'cancelled', cancelled: true, attempt: 1 },
  ]);
  assert.equal(gate.isInFlight(), false);
  assert.equal(platform.browserListeners(), 0, 'المستمع يُزال بعد الإلغاء');

  const retry = await gate.start();
  assert.equal(retry.ok, true);
  assert.equal(retry.attempt, 2, 'محاولة جديدة برقم جديد بعد الإلغاء');
});

test('إغلاق المتصفح بعد نجاح التبادل لا يُنتج إلغاءً', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();
  await gate.handleUrl(CALLBACK);

  platform.finishBrowser();

  assert.equal(platform.emitted.length, 1, 'لا نتيجة إضافية بعد النجاح');
  assert.equal(platform.emitted[0].ok, true);
});

test('إغلاق المتصفح بعد وصول الرمز لا يُلغي التبادل الجاري', async () => {
  const release = deferred();
  const platform = createFakePlatform({ exchangeDelay: release.promise });
  const gate = createGate(platform);
  await gate.start();

  const pending = gate.handleUrl(CALLBACK);
  platform.finishBrowser();
  release.resolve();

  assert.deepEqual(await pending, { ok: true, attempt: 1 });
  assert.deepEqual(platform.emitted, [{ ok: true, attempt: 1 }]);
});

test('اتصال بالرمز بعد الإلغاء: يُبادل ويُصدر نتيجة بلا رقم محاولة', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();
  platform.finishBrowser();

  const late = await gate.handleUrl(CALLBACK);

  assert.deepEqual(late, { ok: true, attempt: 0 });
  assert.equal(platform.emitted.length, 2);
  assert.equal(platform.emitted[1].ok, true);
});

test('callback عند تشغيل التطبيق من جديد بلا بدء محاولة', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);

  const result = await gate.handleUrl(CALLBACK);

  assert.deepEqual(result, { ok: true, attempt: 0 });
  assert.equal(platform.exchangeCalls.length, 1);
  assert.equal(platform.emitted.length, 1);
});

test('إعادة المحاولة بعد فشل: أرقام محاولات متزايدة ولا أثر لنتيجة قديمة', async () => {
  const platform = createFakePlatform({ exchangeError: { message: 'expired' } });
  const gate = createGate(platform);

  await gate.start();
  await gate.handleUrl(CALLBACK);
  const second = await gate.start();

  assert.equal(second.ok, true);
  assert.equal(second.attempt, 2);

  // رمز جديد في المحاولة الجديدة ينجح مستقلّاً عن فشل السابق
  const platform2 = createFakePlatform();
  const gate2 = createGate(platform2);
  await gate2.start();
  await gate2.handleUrl('anisocial://auth/callback?code=code-old');
  await gate2.start();
  const fresh = await gate2.handleUrl('anisocial://auth/callback?code=code-new');

  assert.deepEqual(fresh, { ok: true, attempt: 2 });
  assert.deepEqual(platform2.exchangeCalls, ['code-old', 'code-new']);
});

test('إلغاء المستخدم من رابط الخطأ يُعلَّم cancelled', async () => {
  const platform = createFakePlatform();
  const gate = createGate(platform);
  await gate.start();

  const result = await gate.handleUrl('anisocial://auth/callback?error=access_denied');

  assert.deepEqual(result, { ok: false, error: 'access_denied', cancelled: true, attempt: 1 });
  assert.equal(gate.isInFlight(), false);
});

test('مشترك مُلغى لا يستقبل نتائج، والمشتركون لا يُفشلون بعضهم', async () => {
  const platform = createFakePlatform();
  const gate = createNativeOAuthGate(platform.deps);
  const received: NativeOAuthResult[] = [];
  const unsubscribe = gate.subscribe(result => {
    received.push(result);
  });
  gate.subscribe(() => {
    throw new Error('مستمع فاشل');
  });

  await gate.start();
  await gate.handleUrl(CALLBACK);
  unsubscribe();
  await gate.handleUrl('anisocial://auth/callback?code=code-2');

  assert.equal(received.length, 1, 'المشترك المُلغى لا يستقبل شيئاً بعد إلغائه');
  assert.equal(platform.emitted.length, 0, 'لا مشترك مسجّل هنا');
});

test('مستمع روابط التطبيق: تسجيل واحد حتى مع تزامن النداءات', async () => {
  const added: Array<(url: string) => void> = [];
  const handled: string[] = [];
  let launchCalls = 0;
  const listener = createNativeOAuthUrlListener({
    async addAppUrlListener(handler) {
      added.push(handler);
      return { remove: () => undefined } as ListenerHandle;
    },
    async getLaunchUrl() {
      launchCalls += 1;
      return null;
    },
    async handleUrl(url) {
      handled.push(url);
    },
  });

  await Promise.all([listener.register(), listener.register(), listener.register()]);

  assert.equal(added.length, 1, 'مستمع واحد فقط');
  assert.equal(launchCalls, 1, 'رابط التشغيل يُقرأ مرة واحدة');
  assert.equal(listener.isRegistered(), true);

  added[0]('anisocial://auth/callback?code=code-1');
  assert.deepEqual(handled, ['anisocial://auth/callback?code=code-1']);
});

test('رابط التشغيل البارد يُعالَج بعد تثبيت المستمع ومرة واحدة', async () => {
  const order: string[] = [];
  const handled: string[] = [];
  const listener = createNativeOAuthUrlListener({
    async addAppUrlListener() {
      order.push('listener');
      return { remove: () => undefined } as ListenerHandle;
    },
    async getLaunchUrl() {
      order.push('launch');
      return 'anisocial://auth/callback?code=cold';
    },
    async handleUrl(url) {
      handled.push(url);
    },
  });

  await listener.register();

  assert.deepEqual(order, ['listener', 'launch'], 'الاستماع أولاً ثم رابط التشغيل');
  assert.deepEqual(handled, ['anisocial://auth/callback?code=cold']);

  // التسجيل الثاني لا يعيد قراءة رابط التشغيل بفضل حارس التسجيل الواحد.
  await listener.register();
  assert.deepEqual(handled, ['anisocial://auth/callback?code=cold']);
});

test('إزالة المستمع: تحرير كامل وإمكان تسجيل جديد', async () => {
  let removed = 0;
  let added = 0;
  const listener = createNativeOAuthUrlListener({
    async addAppUrlListener() {
      added += 1;
      return { remove: () => { removed += 1; } } as ListenerHandle;
    },
    async getLaunchUrl() {
      return null;
    },
    async handleUrl() {
      /* بلا رابط */
    },
  });

  await listener.register();
  assert.equal(added, 1);
  await listener.unregister();
  assert.equal(removed, 1);
  assert.equal(listener.isRegistered(), false);

  await listener.register();
  assert.equal(added, 2, 'التسجيل يعمل من جديد بعد الإزالة');
});

test('قرار الواجهة: انتقال مرة واحدة، وإشعار إلغاء، وخطأ واضح', () => {
  const success: NativeOAuthResult = { ok: true, attempt: 3 };
  assert.deepEqual(nativeOAuthDecision(success, 0), { kind: 'navigate', attempt: 3 });
  assert.deepEqual(nativeOAuthDecision(success, 3), { kind: 'ignore', attempt: 3 }, 'لا انتقال مزدوج');

  const cancelled: NativeOAuthResult = { ok: false, error: 'cancelled', cancelled: true, attempt: 4 };
  assert.deepEqual(nativeOAuthDecision(cancelled, 0), {
    kind: 'notice',
    attempt: 4,
    message: NATIVE_OAUTH_CANCEL_MESSAGE,
  });

  const failed: NativeOAuthResult = { ok: false, error: 'oauth_exchange_failed', attempt: 5 };
  assert.deepEqual(nativeOAuthDecision(failed, 0), {
    kind: 'error',
    attempt: 5,
    message: describeNativeOAuthError('oauth_exchange_failed'),
  });
  assert.equal(nativeOAuthDecision(failed, 5).kind, 'ignore', 'الفشل المكرر لا يتكرر');

  // رابط تشغيل بارد بلا رقم محاولة: يُنقل مرة واحدة.
  assert.deepEqual(nativeOAuthDecision({ ok: true, attempt: 0 }, 5), { kind: 'navigate', attempt: 0 });
});

test('رسائل الأخطاء عربية وثابتة ولا تعرض رسائل SDK', () => {
  assert.equal(describeNativeOAuthError('oauth_url_missing').includes('Google'), true);
  assert.equal(describeNativeOAuthError('unknown_code'), describeNativeOAuthError(''));
  assert.equal(describeNativeOAuthError(undefined), 'تعذر المتابعة باستخدام Google. حاول مرة أخرى.');
});


test('Web OAuth لم يتأثر: عنوان الأصل للويب والمخطط الأصلي للجهاز', () => {
  // بلا Capacitor (بيئة الاختبار) لا منصة أصلية: مسار الويب كما هو.
  assert.equal(isNativePlatformFromRedirect(), false);
  assert.equal(getOAuthRedirectUrl(), '');
  // العنوان الأصلي ثابت ومطابق لما يحلّله parseOAuthCallback.
  assert.equal(NATIVE_OAUTH_REDIRECT_URL, 'anisocial://auth/callback');
  assert.equal(parseOAuthCallback(`${NATIVE_OAUTH_REDIRECT_URL}?code=web-safe`).code, 'web-safe');
});


type ListenerFake = {
  deps: NativeOAuthUrlListenerDeps;
  created: Array<{ handler: (url: string) => void; removed: number }>;
  handled: string[];
  addCalls: () => number;
  launchCalls: () => number;
  resolveCreation: () => void;
};

/**
 * محاكاة مستمع روابط التطبيق: أول `deferredCreations` نداءات تبقى معلّقة حتى
 * `resolveCreation`، لاختبار ما يحدث حين يكتمل التسجيل بعد طلب الإزالة.
 */
function createListenerFake(
  options: { launchUrl?: string | null; deferredCreations?: number } = {},
): ListenerFake {
  const created: Array<{ handler: (url: string) => void; removed: number }> = [];
  const handled: string[] = [];
  const resolvers: Array<() => void> = [];
  let addCalls = 0;
  let launchCalls = 0;
  let remainingDeferred = options.deferredCreations ?? 0;

  const deps: NativeOAuthUrlListenerDeps = {
    addAppUrlListener(handler) {
      addCalls += 1;
      const record = { handler, removed: 0 };
      created.push(record);
      const handle: ListenerHandle = {
        remove: () => {
          record.removed += 1;
        },
      };
      if (remainingDeferred <= 0) return Promise.resolve(handle);
      remainingDeferred -= 1;
      return new Promise<ListenerHandle>(resolve => {
        resolvers.push(() => resolve(handle));
      });
    },
    async getLaunchUrl() {
      launchCalls += 1;
      return options.launchUrl ?? null;
    },
    async handleUrl(url) {
      handled.push(url);
    },
  };

  return {
    deps,
    created,
    handled,
    addCalls: () => addCalls,
    launchCalls: () => launchCalls,
    resolveCreation: () => {
      const next = resolvers.shift();
      if (next) next();
    },
  };
}

test('unregister أثناء انتظار addAppUrlListener لا يترك مستمعاً فعالاً', async () => {
  const fake = createListenerFake({ deferredCreations: 1 });
  const listener = createNativeOAuthUrlListener(fake.deps);

  const registering = listener.register();
  await listener.unregister();
  fake.resolveCreation();
  await registering;

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].removed, 1, 'المستمع المكتمل بعد الإزالة يُزال');
  assert.equal(listener.isRegistered(), false, 'لا مستمع نشط بعد الإزالة');
  assert.equal(fake.launchCalls(), 0, 'لا قراءة لرابط التشغيل بعد الإزالة');
  assert.deepEqual(fake.handled, []);
});

test('اكتمال التسجيل بعد طلب الإزالة لا يُنشر مستمعاً ولا يعالج رابط تشغيل', async () => {
  const fake = createListenerFake({
    deferredCreations: 1,
    launchUrl: 'anisocial://auth/callback?code=cold',
  });
  const listener = createNativeOAuthUrlListener(fake.deps);

  const registering = listener.register();
  await listener.unregister();
  // الإكمال المتأخر: يُزال فوراً، ولا يُعالج رابط تشغيل سابق.
  fake.resolveCreation();
  await registering;

  assert.equal(fake.created[0].removed, 1);
  assert.equal(listener.isRegistered(), false);
  assert.equal(fake.launchCalls(), 0);
  assert.deepEqual(fake.handled, []);
});

test('تسجيل متكرر أثناء تسجيل معلّق يعيد الوعد نفسه ولا ينشئ مستمعاً ثانياً', async () => {
  const fake = createListenerFake({ deferredCreations: 1 });
  const listener = createNativeOAuthUrlListener(fake.deps);

  const first = listener.register();
  const second = listener.register();
  const third = listener.register();

  assert.equal(first, second, 'نفس وعد التسجيل');
  assert.equal(second, third, 'نفس وعد التسجيل');
  assert.equal(fake.addCalls(), 1, 'نداء addAppUrlListener مرة واحدة');

  fake.resolveCreation();
  await first;

  assert.equal(listener.isRegistered(), true);
  assert.equal(fake.created[0].removed, 0);
});

test('التسجيل بعد الإزالة ينشئ مستمعاً جديداً فقط دون إحياء القديم', async () => {
  const fake = createListenerFake({ launchUrl: 'anisocial://auth/callback?code=cold' });
  const listener = createNativeOAuthUrlListener(fake.deps);

  await listener.register();
  assert.equal(listener.isRegistered(), true);
  assert.equal(fake.addCalls(), 1);
  assert.equal(fake.launchCalls(), 1);
  assert.deepEqual(fake.handled, ['anisocial://auth/callback?code=cold']);

  await listener.unregister();
  assert.equal(fake.created[0].removed, 1, 'المستمع القديم أُزيل');
  assert.equal(listener.isRegistered(), false);

  await listener.register();
  assert.equal(fake.addCalls(), 2, 'تسجيل جديد بمستمع جديد فقط');
  assert.equal(listener.isRegistered(), true);
  assert.equal(fake.created[0].removed, 1, 'القديم لم يُعد نشطاً');
  assert.equal(fake.created[1].removed, 0, 'الجديد هو الفعّال');
  // رابط التشغيل يُقرأ من جديد بعد الإزالة؛ وحارس الرموز في البوّابة يمنع
  // تبادل الرمز نفسه مرتين.
  assert.equal(fake.launchCalls(), 2);

  await listener.unregister();
  assert.equal(fake.created[1].removed, 1);
  assert.equal(fake.created[0].removed, 1, 'لا عودة للمستمع القديم');
  assert.equal(listener.isRegistered(), false);
});
