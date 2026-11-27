import assert from 'node:assert/strict';
import test from 'node:test';

import { createOAuthProvider } from './oauthProvider';
import { NATIVE_OAUTH_REDIRECT_URL, PUBLISHED_WEB_ORIGIN } from './oauthRedirect';

// متصفح مُحاكى لعقد `window.location.origin` المستخدم في redirectTo.
globalThis.window = globalThis.window ?? ({} as Window);
if (!globalThis.window.location) {
  (globalThis.window as Window & { location: Location }).location = {
    origin: PUBLISHED_WEB_ORIGIN,
    ...((globalThis.window as unknown) as { location?: Location }).location,
  } as Location;
}

/** وعد يمكن التحكم في تأكيده أو رفضه من الخارج (للتحكم في لحظة الاستجابة). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type OAuthCall = { provider: string; options: { redirectTo?: string } };

function makeClient(opts: {
  calls: OAuthCall[];
  responses: Array<{ error: Error | null } | Promise<{ error: Error | null }> | 'reject'>;
}): { client: any } {
  let index = 0;
  const client: any = {
    auth: {
      signInWithOAuth: async (input: OAuthCall) => {
        opts.calls.push(input);
        const response = opts.responses[index++];
        if (response === 'reject') throw new Error('Unsupported provider: provider is not enabled');
        return response;
      },
    },
  };
  return { client };
}

test('google loading is independent: apple is not marked loading while google is in flight', async () => {
  const calls: OAuthCall[] = [];
  const googleDeferred = deferred<{ error: Error | null }>();
  const { client } = makeClient({
    calls,
    responses: [googleDeferred.promise.then(() => ({ error: null }))],
  });

  const provider = createOAuthProvider(client);
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);

  // ابدأ تحميل Google ولكن لا تُحدّد الاستجابة بعد.
  const googlePromise = provider.signIn('google');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(provider.providerLoading, 'google');
  assert.equal(provider.isProviderLoading, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');

  // بينما Google معلق، استدعاء Apple يُرد مبكراً ولا يغيّر الحالة ولا يُستدعى فعلياً.
  const applePromise = provider.signIn('apple');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(provider.providerLoading, 'google');
  assert.equal(provider.isProviderLoading, true);
  assert.equal(calls.length, 1);

  // أكمل Google بنجاح.
  googleDeferred.resolve();
  await googlePromise;
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
});

test('apple loading is independent: google is not marked loading while apple is in flight', async () => {
  const calls: OAuthCall[] = [];
  const appleDeferred = deferred<{ error: Error | null }>();
  const { client } = makeClient({
    calls,
    responses: [appleDeferred.promise.then(() => ({ error: null }))],
  });

  const provider = createOAuthProvider(client);
  const applePromise = provider.signIn('apple');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(provider.providerLoading, 'apple');
  assert.equal(provider.isProviderLoading, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'apple');

  const googlePromise = provider.signIn('google');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(provider.providerLoading, 'apple');
  assert.equal(calls.length, 1);

  appleDeferred.resolve();
  await applePromise;
  assert.equal(provider.providerLoading, null);

  await googlePromise;
  assert.equal(provider.providerLoading, null);
});

test('failing google leaves apple NOT loading and clears google state', async () => {
  const calls: OAuthCall[] = [];
  const { client } = makeClient({
    calls,
    responses: ['reject'],
  });
  const provider = createOAuthProvider(client);

  await assert.rejects(() => provider.signIn('google'), /Unsupported provider/);
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');

  // Apple لا يزال متاحاً للبدء (لم يُترك في حالة تحميل).
  const appleDeferred = deferred<{ error: Error | null }>();
  const calls2: OAuthCall[] = [];
  const client2 = makeClient({
    calls: calls2,
    responses: [appleDeferred.promise.then(() => ({ error: null }))],
  }).client;
  const provider2 = createOAuthProvider(client2);
  const applePromise = provider2.signIn('apple');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].provider, 'apple');
  appleDeferred.resolve();
  await applePromise;
  assert.equal(provider2.providerLoading, null);
});

test('failing apple leaves google NOT loading and clears apple state', async () => {
  const calls: OAuthCall[] = [];
  const { client } = makeClient({
    calls,
    responses: ['reject'],
  });
  const provider = createOAuthProvider(client);

  await assert.rejects(() => provider.signIn('apple'), /Unsupported provider/);
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'apple');

  const googleDeferred = deferred<{ error: Error | null }>();
  const calls2: OAuthCall[] = [];
  const client2 = makeClient({
    calls: calls2,
    responses: [googleDeferred.promise.then(() => ({ error: null }))],
  }).client;
  const provider2 = createOAuthProvider(client2);
  const googlePromise = provider2.signIn('google');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].provider, 'google');
  googleDeferred.resolve();
  await googlePromise;
  assert.equal(provider2.providerLoading, null);
});

test('successful sign-in does not leave a stuck loading state', async () => {
  const calls: OAuthCall[] = [];
  const googleDeferred = deferred<{ error: Error | null }>();
  const appleDeferred = deferred<{ error: Error | null }>();
  const { client } = makeClient({
    calls,
    responses: [
      googleDeferred.promise.then(() => ({ error: null })),
      appleDeferred.promise.then(() => ({ error: null })),
    ],
  });
  const provider = createOAuthProvider(client);

  const googlePromise = provider.signIn('google');
  googleDeferred.resolve();
  await googlePromise;
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');

  const applePromise = provider.signIn('apple');
  appleDeferred.resolve();
  await applePromise;
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider, 'apple');
});


test('web sign-in sends the resolved published origin as redirectTo', async () => {
  const calls: OAuthCall[] = [];
  const { client } = makeClient({ calls, responses: [{ error: null }] });
  const provider = createOAuthProvider(client, () => ({
    ok: true,
    kind: 'web',
    url: PUBLISHED_WEB_ORIGIN,
  }));

  await provider.signIn('google');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');
  // عنوان العودة المنشور هو ما يُرسل إلى Supabase، لا localhost.
  assert.equal(calls[0].options.redirectTo, PUBLISHED_WEB_ORIGIN);
  assert.doesNotMatch(String(calls[0].options.redirectTo), /localhost|127\.0\.0\.1/);
  assert.equal(provider.providerLoading, null);
});

test('native sign-in sends the app deep link, never the web origin', async () => {
  const calls: OAuthCall[] = [];
  const { client } = makeClient({ calls, responses: [{ error: null }] });
  const provider = createOAuthProvider(client, () => ({
    ok: true,
    kind: 'native',
    url: NATIVE_OAUTH_REDIRECT_URL,
  }));

  await provider.signIn('apple');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirectTo, NATIVE_OAUTH_REDIRECT_URL);
  assert.notEqual(calls[0].options.redirectTo, PUBLISHED_WEB_ORIGIN);
});

test('an unresolved redirect rejects before any OAuth request is made', async () => {
  const calls: OAuthCall[] = [];
  const { client } = makeClient({ calls, responses: [{ error: null }] });
  const provider = createOAuthProvider(client, () => ({ ok: false, error: 'origin not allowed' }));

  await assert.rejects(() => provider.signIn('google'), /origin not allowed/);
  assert.equal(calls.length, 0);
  assert.equal(provider.providerLoading, null);
  assert.equal(provider.isProviderLoading, false);
});
