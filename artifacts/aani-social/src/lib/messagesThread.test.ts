import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOlderRequestTracker,
  hasOlderPage,
  initialOlderPageProgress,
  mergeThreadRows,
  olderCursorFromRows,
  progressAfterLatestPage,
  progressAfterOlderPage,
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

const PAGE = 60;

const makeThreadRows = (count: number): Row[] => Array.from({ length: count }, (_, index) => row(
  `m${String(index).padStart(3, '0')}`,
  new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
));

test('paging a whole thread never duplicates a message and keeps one order', () => {
  const ascending = makeThreadRows(130);
  const descending = [...ascending].reverse();

  let progress = initialOlderPageProgress();
  let threadRows: Row[] = [];

  // الدفعة الأولى: أحدث ٦٠ رسالة (كما تعيدها القاعدة، تنازلياً).
  const latestPage = descending.slice(0, PAGE);
  threadRows = mergeThreadRows(threadRows, [...latestPage].reverse());
  progress = progressAfterLatestPage(progress, latestPage, PAGE);

  assert.equal(progress.hasOlder, true);
  assert.equal(progress.olderPagesLoaded, 0);
  assert.deepEqual(progress.cursor, { createdAt: latestPage[PAGE - 1].created_at, id: latestPage[PAGE - 1].id });

  // دفعتان أقدم تُطلبان بالمؤشر نفسه المستخدم في الاستعلام.
  for (let page = 1; page <= 2; page += 1) {
    const olderPage = descending.slice(page * PAGE, (page + 1) * PAGE);
    threadRows = mergeThreadRows(threadRows, [...olderPage].reverse());
    progress = progressAfterOlderPage(progress, olderPage, PAGE);
  }

  assert.equal(progress.olderPagesLoaded, 2);
  assert.equal(progress.hasOlder, false);
  assert.equal(threadRows.length, 130);
  assert.equal(new Set(threadRows.map(item => item.id)).size, 130);
  assert.deepEqual(threadRows.map(item => item.id), ascending.map(item => item.id));
});

test('a realtime refresh of the newest page never resets the paging progress', () => {
  const descending = [...makeThreadRows(130)].reverse();
  let progress = progressAfterLatestPage(initialOlderPageProgress(), descending.slice(0, PAGE), PAGE);
  progress = progressAfterOlderPage(progress, descending.slice(PAGE, PAGE * 2), PAGE);
  progress = progressAfterOlderPage(progress, descending.slice(PAGE * 2), PAGE);

  const cursorBefore = progress.cursor;
  assert.equal(progress.hasOlder, false);

  // وصول Realtime: تحميل كامل أحدث صفحة مرة أخرى.
  const afterLatestAgain = progressAfterLatestPage(progress, descending.slice(0, PAGE), PAGE);

  assert.equal(afterLatestAgain, progress);
  assert.deepEqual(afterLatestAgain.cursor, cursorBefore);
  assert.equal(afterLatestAgain.hasOlder, false);
  assert.equal(afterLatestAgain.olderPagesLoaded, 2);
});

test('an empty newest page leaves paging closed', () => {
  const progress = progressAfterLatestPage(initialOlderPageProgress(), [], PAGE);
  assert.equal(progress.cursor, null);
  assert.equal(progress.hasOlder, false);
  assert.equal(progress.olderPagesLoaded, 0);
});

test('a stale older page is dropped and does not reopen paging progress', () => {
  const descending = [...makeThreadRows(130)].reverse();
  const tracker = createOlderRequestTracker();

  let progress = progressAfterLatestPage(initialOlderPageProgress(), descending.slice(0, PAGE), PAGE);
  const requestId = tracker.begin('contact-a');

  // Realtime: تحميل كامل جديد للمحادثة نفسها يُبطل الدفعة الجارية.
  tracker.invalidate();
  progress = progressAfterLatestPage(progress, descending.slice(0, PAGE), PAGE);

  // الدفعة القديمة تنتهي بعد ذلك: لا تُطبَّق ولا تُغلق Pagination.
  assert.equal(tracker.finish(requestId), false);
  assert.equal(tracker.isLoading(), false);
  assert.equal(progress.olderPagesLoaded, 0);

  // التمرير التالي يبدأ دفعة جديدة بنجاح.
  const nextRequestId = tracker.begin('contact-a');
  assert.equal(tracker.isCurrent(nextRequestId, 'contact-a'), true);
  const olderPage = descending.slice(PAGE, PAGE * 2);
  progress = progressAfterOlderPage(progress, olderPage, PAGE);
  assert.equal(progress.olderPagesLoaded, 1);
  assert.equal(tracker.finish(nextRequestId), true);
  assert.equal(tracker.isLoading(), false);
});

test('an empty older page advances nothing but closes paging', () => {
  const descending = [...makeThreadRows(PAGE)].reverse();
  const progress = progressAfterLatestPage(initialOlderPageProgress(), descending, PAGE);
  assert.equal(progress.hasOlder, false);

  const afterEmpty = progressAfterOlderPage(progress, [], PAGE);
  assert.equal(afterEmpty.cursor, progress.cursor);
  assert.equal(afterEmpty.hasOlder, false);
  assert.equal(afterEmpty.olderPagesLoaded, 1);
});
