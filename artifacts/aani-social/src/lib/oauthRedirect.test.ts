import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  NATIVE_OAUTH_REDIRECT_URL,
  OAUTH_REDIRECT_MESSAGES,
  PUBLISHED_WEB_ORIGIN,
  describeOAuthReturnError,
  getOAuthRedirectUrl,
  normalizeAllowedOrigins,
  readWebOAuthReturn,
  resolveOAuthRedirect,
} from './oauthRedirect';

const PROD = { native: false, production: true };

test('الإنتاج: عنوان Render المنشور يُقبل كما هو', () => {
  const result = resolveOAuthRedirect({ ...PROD, origin: PUBLISHED_WEB_ORIGIN });
  assert.deepEqual(result, { ok: true, kind: 'web', url: PUBLISHED_WEB_ORIGIN });
  assert.equal(result.ok && result.url.includes('localhost'), false);
});

test('الإنتاج: localhost و127.0.0.1 و0.0.0.0 مرفوضة', () => {
  for (const origin of [
    'http://localhost:3000',
    'http://localhost',
    'https://localhost:3000',
    'http://127.0.0.1:5173',
    'http://0.0.0.0:3000',
    'http://[::1]:3000',
  ]) {
    const result = resolveOAuthRedirect({ ...PROD, origin });
    assert.deepEqual(result, { ok: false, error: OAUTH_REDIRECT_MESSAGES.localhostNotAllowed });
    assert.equal(result.ok, false, `${origin} must be refused`);
  }
});

test('الإنتاج: http مرفوض ولو كان الأصل مسموحاً', () => {
  const result = resolveOAuthRedirect({ ...PROD, origin: 'http://aani-social-repair.onrender.com' });
  assert.deepEqual(result, { ok: false, error: OAUTH_REDIRECT_MESSAGES.insecureOrigin });
});

test('الإنتاج: عنوان https غير مدرج مرفوض (لا Redirect URL عشوائي)', () => {
  const result = resolveOAuthRedirect({ ...PROD, origin: 'https://example.com' });
  assert.deepEqual(result, { ok: false, error: OAUTH_REDIRECT_MESSAGES.originNotAllowed });

  const withPath = resolveOAuthRedirect({ ...PROD, origin: 'https://aani-social-repair.onrender.com/post/123' });
  assert.deepEqual(withPath, { ok: false, error: OAUTH_REDIRECT_MESSAGES.originUnavailable });

  const withQuery = resolveOAuthRedirect({ ...PROD, origin: 'https://aani-social-repair.onrender.com/?next=1' });
  assert.deepEqual(withQuery, { ok: false, error: OAUTH_REDIRECT_MESSAGES.originUnavailable });
});

test('الإنتاج: عنوان مضاف في VITE_AUTH_ALLOWED_ORIGINS يُقبل', () => {
  const result = resolveOAuthRedirect({
    ...PROD,
    origin: 'https://anisocial.example',
    allowedOrigins: 'https://Anisocial.example, not-a-url, http://localhost:3000',
  });
  assert.deepEqual(result, { ok: true, kind: 'web', url: 'https://anisocial.example' });
});

test('التطوير المحلي: localhost يُقبل بلا قائمة إنتاج', () => {
  const result = resolveOAuthRedirect({
    native: false,
    production: false,
    origin: 'http://localhost:5173',
  });
  assert.deepEqual(result, { ok: true, kind: 'web', url: 'http://localhost:5173' });
});

test('الهاتف: deep link دائماً، ولا يختلط بعنوان الويب', () => {
  const nativeResult = resolveOAuthRedirect({ native: true, production: true, origin: PUBLISHED_WEB_ORIGIN });
  assert.deepEqual(nativeResult, { ok: true, kind: 'native', url: NATIVE_OAUTH_REDIRECT_URL });
  assert.equal(nativeResult.ok && nativeResult.url.startsWith('anisocial://'), true);
  // حتى لو كان الأصل غير مسموح: مسار الهاتف لا يعتمد عليه.
  const nativeWithoutOrigin = resolveOAuthRedirect({ native: true, production: true, origin: 'https://example.com' });
  assert.equal(nativeWithoutOrigin.ok, true);
  assert.equal(nativeWithoutOrigin.ok && nativeWithoutOrigin.url, NATIVE_OAUTH_REDIRECT_URL);
});

test('بلا origin (بيئة بلا متصفح) لا يُبنى عنوان عودة', () => {
  const result = resolveOAuthRedirect({ native: false, production: true, origin: '' });
  assert.deepEqual(result, { ok: false, error: OAUTH_REDIRECT_MESSAGES.originUnavailable });
  // في بيئة الاختبار (بلا window) لا عنوان معتمد.
  assert.equal(getOAuthRedirectUrl(), '');
});

test('تنظيف قائمة العناوين: أصل صرف فقط وبأحرف صغيرة وبلا تكرار', () => {
  // الأصل الصرف فقط يُقبل: ما يحمل مساراً أو استعلاماً أو مخططاً غير http(s)
  // يُهمل، فلا يُقبل عنوان دخول غير مقصود من قيمة إعداد.
  assert.deepEqual(
    normalizeAllowedOrigins(' https://A.example , , https://a.example, https://b.example/path, javascript:alert(1) '),
    ['https://a.example'],
  );
  assert.deepEqual(normalizeAllowedOrigins(undefined), []);
  assert.deepEqual(normalizeAllowedOrigins(['https://c.example', 'bad']), ['https://c.example']);
});

test('عودة OAuth على الويب: رمز أو إلغاء أو لا شيء', () => {
  assert.deepEqual(readWebOAuthReturn('?code=abc'), { kind: 'code' });
  assert.deepEqual(readWebOAuthReturn(''), { kind: 'none' });
  assert.deepEqual(readWebOAuthReturn('?state=1'), { kind: 'none' });
  assert.deepEqual(readWebOAuthReturn('?error=access_denied'), {
    kind: 'error',
    message: describeOAuthReturnError('access_denied'),
  });
  // error_description وحدها تُقرأ أيضاً.
  assert.equal(readWebOAuthReturn('?error_description=access_denied').kind, 'error');
  // رمز الخطأ غير المعروف يعطي رسالة عامة، لا نص المزوّد.
  assert.equal(
    describeOAuthReturnError('some_unknown_code'),
    'تعذر إكمال تسجيل الدخول عبر Google. حاول مرة أخرى.',
  );
});


test('كود المصادقة على الويب لا يكتب عنوان localhost صريحاً', () => {
  // الحارس الأخير ضد تكرار المشكلة: لا عنوان محلي مكتوب في الكود يُرسل إلى
  // Supabase في الإنتاج. التعليقات مستثناة (تشرح سبب المشكلة فقط).
  const codeOnly = (source: string) => source
    .split('\n')
    .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  for (const file of ['./oauthRedirect.ts', './oauthProvider.ts', './supabase.ts']) {
    const code = codeOnly(readFileSync(new URL(file, import.meta.url), 'utf8'));
    assert.equal(code.includes('localhost:3000'), false, `${file} must not hard-code localhost:3000`);
    assert.equal(code.includes('http://localhost'), false, `${file} must not hard-code http://localhost`);
  }
});
