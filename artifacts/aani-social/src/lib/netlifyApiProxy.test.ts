import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  API_PROXY_PREFIX,
  DEFAULT_API_PROXY_TARGET,
  NETLIFY_SPA_FALLBACK_RULE,
  buildNetlifyRedirects,
  matchesNetlifyPathRule,
  normalizeApiProxyTarget,
  resolveApiProxyTarget,
} from './netlifyApiProxy';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

test('the proven API host is the committed default', () => {
  assert.equal(DEFAULT_API_PROXY_TARGET, 'https://aani-social-repair.onrender.com');
});

test('without any target the builder writes only the SPA fallback', () => {
  const output = buildNetlifyRedirects(null);

  assert.equal(output, `${NETLIFY_SPA_FALLBACK_RULE}\n`);
  assert.equal(/https?:\/\//.test(output), false);
});

test('the default target proxies /api before the SPA fallback', () => {
  const output = buildNetlifyRedirects(resolveApiProxyTarget(''));
  const lines = output.split('\n').filter(Boolean);

  assert.equal(lines.length, 2);
  assert.equal(lines[0], `/api/*   ${DEFAULT_API_PROXY_TARGET}/api/:splat   200`);
  assert.equal(lines[1], NETLIFY_SPA_FALLBACK_RULE);
  // قاعدة /api تسبق قاعدة SPA دائماً
  assert.equal(
    output.indexOf(`${API_PROXY_PREFIX}/*`) < output.indexOf(NETLIFY_SPA_FALLBACK_RULE),
    true,
  );
  // لا أصل آخر غير العنوان المؤكَّد في الملف
  assert.deepEqual(
    [...output.matchAll(/https?:\/\/[^\s]+/g)].map(match => match[0]),
    [`${DEFAULT_API_PROXY_TARGET}/api/:splat`],
  );
});

test('a configured target overrides the default and an invalid one falls back to it', () => {
  assert.equal(resolveApiProxyTarget('https://custom-api.example'), 'https://custom-api.example');
  for (const invalid of ['http://custom-api.example', 'custom-api.example', '/api', '']) {
    assert.equal(resolveApiProxyTarget(invalid), DEFAULT_API_PROXY_TARGET, `for "${invalid}"`);
  }
});

test('the target is normalised: trimmed and without a trailing slash', () => {
  assert.equal(normalizeApiProxyTarget('  https://aani-api.example/  '), 'https://aani-api.example');
  assert.equal(
    normalizeApiProxyTarget('https://aani-api.example/backend/'),
    'https://aani-api.example/backend',
  );
});

test('invalid targets are rejected by the normaliser instead of being written', () => {
  for (const value of ['http://aani-api.example', 'aani-api.example', 'https://', '/api', '']) {
    assert.equal(normalizeApiProxyTarget(value), null, `should reject "${value}"`);
  }
});

test('the single /api rule covers the voice conversion, the signature and the upload paths', () => {
  const [rule] = buildNetlifyRedirects(DEFAULT_API_PROXY_TARGET).split('\n');
  const pattern = rule.split(/\s+/)[0];

  assert.equal(pattern, `${API_PROXY_PREFIX}/*`);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/voice'), true);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/imagekit-auth'), true);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/upload'), true);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/health'), true);
  // القاعدة لا تبتلع صفحات التطبيق
  assert.equal(matchesNetlifyPathRule(pattern, '/feed'), false);
  assert.equal(matchesNetlifyPathRule(pattern, '/apiary'), false);
});

test('both API calls are same-origin relative paths, so one rule serves them', () => {
  const upload = read('./lib/storyUpload.ts');
  const voice = read('./lib/messagesVoiceServer.ts');

  // توقيع رفع الوسائط (الصور والفيديو والرسائل الصوتية) من نفس المضيف
  assert.equal(upload.includes("fetch('/api/media/imagekit-auth'"), true);
  // تحويل الرسالة الصوتية من نفس المضيف
  assert.equal(voice.includes("fetch('/api/media/voice'"), true);
  // لا عنوان API مطلق في أي منهما
  assert.equal(/fetch\(\s*['"`]https?:\/\//.test(upload), false);
  assert.equal(/fetch\(\s*['"`]https?:\/\//.test(voice), false);
});

test('the committed public redirects file stays free of any host', () => {
  const committed = read('../public/_redirects').trim().replace(/\s+/g, ' ');

  assert.equal(committed, NETLIFY_SPA_FALLBACK_RULE.replace(/\s+/g, ' '));
  assert.equal(/https?:\/\//.test(committed), false);
});

test('the build resolves the target and writes the redirects file', () => {
  const config = read('../vite.config.ts');

  assert.equal(config.includes('resolveApiProxyTarget(rawApiProxyTarget)'), true);
  assert.equal(config.includes('buildNetlifyRedirects(apiProxyTarget)'), true);
  assert.equal(config.includes('NETLIFY_REDIRECTS_FILE'), true);
  assert.equal(config.includes('API_PROXY_TARGET_ENV'), true);
});

test('a host that answers API calls with the SPA reports the missing proxy', () => {
  const upload = read('./lib/storyUpload.ts');
  const voice = read('./lib/messagesVoiceServer.ts');

  // رسالة صريحة بدل خطأ غامض عندما يعيد المضيف صفحة بدل JSON
  assert.equal(upload.includes('API_PROXY_TARGET'), true);
  assert.equal(voice.includes('API_PROXY_TARGET'), true);
});
