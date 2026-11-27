import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyStaticRequest } from './spaFallback';

test('مسارات API لا تُوجَّه إلى الواجهة أبداً', () => {
  assert.equal(classifyStaticRequest('/api/health', 'GET'), 'api');
  assert.equal(classifyStaticRequest('/api', 'GET'), 'api');
  assert.equal(classifyStaticRequest('/api/media/voice', 'POST'), 'api');
  assert.equal(classifyStaticRequest('/api/media/imagekit-sign', 'GET'), 'api');
});

test('المسارات المباشرة وتحديث الصفحة وauth callback تُخدم بـindex.html', () => {
  for (const path of ['/', '/feed', '/post/123', '/messages/user-1', '/auth/callback', '/login']) {
    assert.equal(classifyStaticRequest(path, 'GET'), 'spa', `spa route: ${path}`);
  }
  // مسار الاستعلام لا يغيّر التصنيف (req.path بلا استعلام).
  assert.equal(classifyStaticRequest('/auth/callback', 'HEAD'), 'spa');
});

test('طلب ملف غير موجود لا يعيد HTML مكان JS أو CSS', () => {
  assert.equal(classifyStaticRequest('/assets/index-abc123.js', 'GET'), 'static');
  assert.equal(classifyStaticRequest('/firebase-messaging-sw.js', 'GET'), 'static');
  assert.equal(classifyStaticRequest('/fonts/alexandria-400.ttf', 'GET'), 'static');
  assert.equal(classifyStaticRequest('/favicon.svg', 'GET'), 'static');
});

test('غير GET/HEAD يُرفض بدل إعادة index.html', () => {
  assert.equal(classifyStaticRequest('/feed', 'POST'), 'method_not_allowed');
  assert.equal(classifyStaticRequest('/auth/callback', 'PUT'), 'method_not_allowed');
  assert.equal(classifyStaticRequest('/', 'DELETE'), 'method_not_allowed');
});

test('مسار مشوّه يُعامل كجذر بلا كسر التصنيف', () => {
  assert.equal(classifyStaticRequest('', 'GET'), 'spa');
  assert.equal(classifyStaticRequest('feed', 'GET'), 'spa');
});
