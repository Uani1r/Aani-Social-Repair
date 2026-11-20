import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOlderRequestTracker,
  hasOlderPage,
  mergeThreadRows,
  olderCursorFromRows,
  sortThreadRows,
} from './messagesThread';

type Row = { id: string; created_at: string; hidden?: boolean };

const row = (id: string, createdAt: string, extra: { hidden?: boolean } = {}): Row => ({
  id,
  created_at: createdAt,
  ...extra,
});

test('merge keeps a stable created_at then id order and never duplicates', () => {
  const page = [row('b', '2026-01-01T10:00:01Z'), row('a', '2026-01-01T10:00:00Z')];
  const realtime = [
    row('c', '2026-01-01T10:00:02Z'),
    row('b', '2026-01-01T10:00:01Z'),
  ];
  const merged = mergeThreadRows(page, realtime);
  assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c']);

  const realtimeAgain = mergeThreadRows(merged, [row('b', '2026-01-01T10:00:01Z')]);
  assert.deepEqual(realtimeAgain.map(item => item.id), ['a', 'b', 'c']);
});

test('equal timestamps fall back to id ordering', () => {
  const sorted = sortThreadRows([row('z', '2026-01-01T00:00:00Z'), row('a', '2026-01-01T00:00:00Z')]);
  assert.deepEqual(sorted.map(item => item.id), ['a', 'z']);
});

test('cursor comes from the oldest raw row even when visible rows are filtered out', () => {
  const rawPageDescending = [
    row('c', '2026-01-01T10:00:05Z'),
    row('b', '2026-01-01T10:00:03Z', { hidden: true }),
    row('a', '2026-01-01T10:00:01Z', { hidden: true }),
  ];
  const visible = rawPageDescending.filter(item => !item.hidden);

  assert.equal(visible.length, 1);
  assert.deepEqual(olderCursorFromRows(rawPageDescending), {
    createdAt: '2026-01-01T10:00:01Z',
    id: 'a',
  });
});

test('an all-hidden page still advances the cursor and keeps pagination open', () => {
  const rawPageDescending = [row('c', '2026-01-01T10:00:05Z', { hidden: true }), row('b', '2026-01-01T10:00:04Z', { hidden: true })];
  const cursor = olderCursorFromRows(rawPageDescending);
  const visible = rawPageDescending.filter(item => !item.hidden);

  assert.equal(visible.length, 0);
  assert.deepEqual(cursor, { createdAt: '2026-01-01T10:00:04Z', id: 'b' });
  // صفحة كاملة (حتى لو كلها مخفية) تعني أن هناك ما هو أقدم.
  assert.equal(hasOlderPage(rawPageDescending.length, 2), true);
});

test('pagination stops only when the database returns a short page', () => {
  assert.equal(hasOlderPage(60, 60), true);
  assert.equal(hasOlderPage(59, 60), false);
  assert.equal(hasOlderPage(0, 60), false);
});

test('a page that arrived after switching conversations is dropped', () => {
  const tracker = createOlderRequestTracker();
  const requestId = tracker.begin('contact-a');

  assert.equal(tracker.isCurrent(requestId, 'contact-a'), true);
  assert.equal(tracker.isCurrent(requestId, 'contact-b'), false);
  assert.equal(tracker.isCurrent(requestId, null), false);
  assert.equal(tracker.isCurrent(requestId + 1, 'contact-a'), false);
});

test('a stale older page cannot wedge pagination after a realtime reload', () => {
  const tracker = createOlderRequestTracker();
  const firstRequestId = tracker.begin('contact-a');
  assert.equal(tracker.isLoading(), true);

  // Realtime أو إعادة اتصال: تحميل كامل جديد للمحادثة نفسها.
  tracker.invalidate();
  assert.equal(tracker.isLoading(), false);
  assert.equal(tracker.isCurrent(firstRequestId, 'contact-a'), false);

  // الطلب القديم ينتهي بعد ذلك: لا يحرّر شيئاً ولا يعيد تعليق التحميل.
  assert.equal(tracker.finish(firstRequestId), false);
  assert.equal(tracker.isLoading(), false);

  // لذلك التمرير التالي يجلب دفعة جديدة بدل أن يبقى محجوزاً.
  const secondRequestId = tracker.begin('contact-a');
  assert.notEqual(secondRequestId, firstRequestId);
  assert.equal(tracker.isCurrent(secondRequestId, 'contact-a'), true);
  assert.equal(tracker.isLoading(), true);

  assert.equal(tracker.finish(secondRequestId), true);
  assert.equal(tracker.isLoading(), false);
});

test('an older request never clears the state of a newer one', () => {
  const tracker = createOlderRequestTracker();
  const firstRequestId = tracker.begin('contact-a');
  tracker.invalidate();
  const secondRequestId = tracker.begin('contact-a');

  assert.equal(tracker.finish(firstRequestId), false);
  assert.equal(tracker.isLoading(), true);
  assert.equal(tracker.isCurrent(secondRequestId, 'contact-a'), true);

  assert.equal(tracker.finish(secondRequestId), true);
  assert.equal(tracker.isLoading(), false);
});

test('finishing an unknown request changes nothing', () => {
  const tracker = createOlderRequestTracker();
  const requestId = tracker.begin('contact-a');

  assert.equal(tracker.finish(requestId + 99), false);
  assert.equal(tracker.isLoading(), true);
  assert.equal(tracker.isCurrent(requestId, 'contact-a'), true);

  assert.equal(tracker.finish(requestId), true);
  assert.equal(tracker.isLoading(), false);
  assert.equal(tracker.isCurrent(requestId, 'contact-a'), false);
});
