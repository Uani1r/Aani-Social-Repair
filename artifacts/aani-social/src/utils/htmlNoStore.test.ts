// اختبارات منطق no-store لاستجابات HTML (htmlNoStore) — بلا شبكة أو متصفح:
// - Cache-Control قبل Content-Type: يُفرض no-store دون تغيير قيمة Content-Type.
// - Content-Type قبل Cache-Control: يُفرض no-store كترويسة منفصلة.
// - Content-Type ممرَّر مباشرة داخل كائن/مصفوفة ترويسات writeHead.
// - عدم المساس بـ JS/CSS/الصور (لا no-store) وعدم كسر استدعاءات Node الأصلية.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyHtmlNoStoreInterceptors, type HttpResponseLike } from './htmlNoStore';

/** استجابة وهمية تسجّل كل عمليات Node الأصلية مع حالة الإرسال */
function fakeResponse() {
  const headers = new Map<string, unknown>();
  const calls: { op: string; args: unknown[] }[] = [];
  let sent = false;
  const res = {
    get headersSent() {
      return sent;
    },
    commit() {
      sent = true;
    },
    getHeader(name: string): unknown {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: unknown) {
      calls.push({ op: 'setHeader', args: [name, value] });
      headers.set(name.toLowerCase(), value);
      return res;
    },
    writeHead(...args: unknown[]) {
      calls.push({ op: 'writeHead', args });
      sent = true;
      return res;
    },
    end(...args: unknown[]) {
      calls.push({ op: 'end', args });
      sent = true;
      return res;
    },
    calls,
    header: (name: string) => headers.get(name.toLowerCase()),
  };
  return res;
}

test('Cache-Control قبل Content-Type: يُفرض no-store ويبقى Content-Type أصلياً', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('ok');

  assert.equal(res.header('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.header('Cache-Control'), 'no-store');
  assert.equal(res.header('Cache-Control'), 'no-store');
});

test('Content-Type قبل Cache-Control: يُفرض no-store كترويسة منفصلة دون تغيير النوع', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-cache');
  res.end('ok');

  assert.equal(res.header('Content-Type'), 'text/html');
  assert.equal(res.header('Cache-Control'), 'no-store');
});

test('writeHead بصيغة الكائن: Content-Type ضمن الترويسات الممرَّرة مباشرة', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end('ok');

  const writeHeadCall = res.calls.find(call => call.op === 'writeHead');
  assert.ok(writeHeadCall, 'writeHead الأصلي نُادي مرة واحدة');
  const passedHeaders = writeHeadCall.args[1] as Record<string, unknown>;
  assert.equal(passedHeaders['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(passedHeaders['Cache-Control'], 'no-store');
});

test('writeHead بصيغة المصفوفة المتزامنة: (status, message, headers)', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.writeHead(200, 'OK', [
    ['Content-Type', 'text/html; charset=utf-8'],
    ['Cache-Control', 'private'],
  ]);
  res.end('ok');

  const writeHeadCall = res.calls.find(call => call.op === 'writeHead');
  assert.ok(writeHeadCall, 'writeHead الأصلي نُادي مرة واحدة');
  const passedHeaders = writeHeadCall.args[2] as [string, unknown][];
  const cacheTuple = passedHeaders.find(tuple => tuple[0].toLowerCase() === 'cache-control');
  const typeTuple = passedHeaders.find(tuple => tuple[0].toLowerCase() === 'content-type');
  assert.equal(cacheTuple?.[1], 'no-store');
  assert.equal(typeTuple?.[1], 'text/html; charset=utf-8');
});

test('writeHead مع Content-Type على res وCache-Control ممرَّرة: يُفرض no-store على الممرَّرة', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'text/html');
  res.writeHead(200, { 'Cache-Control': 'max-age=3600' });
  res.end('ok');

  const writeHeadCall = res.calls.find(call => call.op === 'writeHead');
  const passedHeaders = writeHeadCall.args[1] as Record<string, unknown>;
  assert.equal(passedHeaders['Cache-Control'], 'no-store');
  assert.equal(res.header('Cache-Control'), 'no-store');
});

test('JS: لا يُفرض no-store وتبقى ترويساته كما هي', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end('ok');

  assert.equal(res.header('Content-Type'), 'application/javascript');
  assert.equal(res.header('Cache-Control'), 'public, max-age=31536000, immutable');
});

test('CSS/صور: لا يُفرض no-store', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'max-age=3600');
  res.setHeader('Content-Type', 'image/png');
  res.end('x');

  assert.equal(res.header('Cache-Control'), 'max-age=3600');
  assert.equal(res.header('Content-Type'), 'image/png');
});

test('end() بدون writeHead: يُفرض no-store قبل الإرسال الفعلي مرة واحدة', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'text/html');
  res.end('ok');

  const setHeaderCalls = res.calls.filter(call => call.op === 'setHeader' && String(call.args[0]).toLowerCase() === 'cache-control');
  assert.equal(setHeaderCalls.length, 1);
  assert.equal(res.header('Cache-Control'), 'no-store');
});

test('الاستدعاءات الأصلية تعمل: writeHead/end يناديان مرة واحدة لكل منهما', () => {
  const res = fakeResponse();
  applyHtmlNoStoreInterceptors(res as unknown as HttpResponseLike);

  res.setHeader('Content-Type', 'text/html');
  res.writeHead(200);
  res.end('done');

  assert.equal(res.calls.filter(call => call.op === 'writeHead').length, 1);
  assert.equal(res.calls.filter(call => call.op === 'end').length, 1);
});
