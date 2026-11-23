import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  API_PROXY_PREFIX,
  NETLIFY_SPA_FALLBACK_RULE,
  buildNetlifyRedirects,
  matchesNetlifyPathRule,
  normalizeApiProxyTarget,
} from './netlifyApiProxy';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

test('without a configured target the redirects file keeps only the SPA fallback', () => {
  const output = buildNetlifyRedirects(undefined);

  assert.equal(output, `${NETLIFY_SPA_FALLBACK_RULE}\n`);
  // لا عنوان مخترع في المستودع: لا أصل https يُكتب بلا إعداد صريح
  assert.equal(/https?:\/\//.test(output), false);
});

test('a configured API target is proxied before the SPA fallback', () => {
  const output = buildNetlifyRedirects('https://aani-api.example');
  const lines = output.split('\n').filter(Boolean);

  assert.equal(lines.length, 2);
  assert.equal(lines[0], '/api/*   https://aani-api.example/api/:splat   200');
  assert.equal(lines[1], NETLIFY_SPA_FALLBACK_RULE);
});

test('the target is normalised: trimmed and without a trailing slash', () => {
  assert.equal(normalizeApiProxyTarget('  https://aani-api.example/  '), 'https://aani-api.example');
  assert.equal(
    normalizeApiProxyTarget('https://aani-api.example/backend/'),
    'https://aani-api.example/backend',
  );
});

test('an invalid target is ignored instead of written into the routing file', () => {
  for (const value of ['http://aani-api.example', 'aani-api.example', 'https://', '/api', '']) {
    assert.equal(normalizeApiProxyTarget(value), null, `should reject "${value}"`);
    assert.equal(buildNetlifyRedirects(value), `${NETLIFY_SPA_FALLBACK_RULE}\n`);
  }
});

test('the single /api rule covers the voice conversion and the ImageKit signature paths', () => {
  const [rule] = buildNetlifyRedirects('https://aani-api.example').split('\n');
  const pattern = rule.split(/\s+/)[0];

  assert.equal(pattern, `${API_PROXY_PREFIX}/*`);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/voice'), true);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/imagekit-auth'), true);
  assert.equal(matchesNetlifyPathRule(pattern, '/api/media/upload'), true);
  // القاعدة لا تبتلع صفحات التطبيق
  assert.equal(matchesNetlifyPathRule(pattern, '/feed'), false);
  assert.equal(matchesNetlifyPathRule(pattern, '/apiary'), false);
});

test('both API calls are same-origin relative paths, so one rule serves them', () => {
  const upload = read('./storyUpload.ts');
  const voice = read('./messagesVoiceServer.ts');

  // توقيع رفع الوسائط (الصور والفيديو والرسائل الصوتية) من نفس المضيف
  assert.equal(upload.includes("fetch('/api/media/imagekit-auth'"), true);
  // تحويل الرسالة الصوتية من نفس المضيف
  assert.equal(voice.includes("fetch('/api/media/voice'"), true);
  // لا عنوان API مطلق في أي منهما
  assert.equal(/fetch\(\s*['"`]https?:\/\//.test(upload), false);
  assert.equal(/fetch\(\s*['"`]https?:\/\//.test(voice), false);
});

test('the committed redirects file carries no unproven API host', () => {
  const committed = read('../public/_redirects').trim().replace(/\s+/g, ' ');

  assert.equal(committed, NETLIFY_SPA_FALLBACK_RULE.replace(/\s+/g, ' '));
  assert.equal(/https?:\/\//.test(committed), false);
});

test('the build writes the redirects file from the build-time target', () => {
  const config = read('../vite.config.ts');

  assert.equal(config.includes('buildNetlifyRedirects(apiProxyTarget)'), true);
  assert.equal(config.includes('NETLIFY_REDIRECTS_FILE'), true);
  assert.equal(config.includes('API_PROXY_TARGET_ENV'), true);
});

test('a host that answers API calls with the SPA reports the missing proxy', () => {
  const upload = read('./storyUpload.ts');
  const voice = read('./messagesVoiceServer.ts');

  // رسالة صريحة بدل خطأ غامض عندما يعيد المضيف صفحة بدل JSON
  assert.equal(upload.includes('API_PROXY_TARGET'), true);
  assert.equal(voice.includes('API_PROXY_TARGET'), true);
});
