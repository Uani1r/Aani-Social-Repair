import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOlderRequestTracker,
  hasOlderPage,
  initialOlderPageProgress,
  mergeThreadRows,
  messagesThreadFilter,
  olderCursorFromRows,
  overlayLocalReactions,
  progressAfterLatestPage,
  progressAfterOlderPage,
  reactionsForVisibleMessages,
  reactionsFromThreadRows,
  runThreadFirstPaint,
  sortThreadRows,
  shouldShowEmptyThreadMessage,
} from './messagesThread';
import { mergeRealtimeThreadMessages } from './messagesInbox';
import {
  cancelInitialThreadScroll,
  claimInitialThreadScroll,
  createInitialThreadScrollState,
  isCurrentThreadLoad,
  isThreadNearBottom,
  isUserInitiatedUpwardScroll,
  markInitialThreadServerLoaded,
  scrollTopAfterContentResize,
  scrollTopPreservingAnchor,
  shouldLoadOlderMessagesFromScroll,
} from './messagesThreadScroll';
import {
  handleCurrentHiddenMessagesLookupFailure,
  HiddenMessagesLookupError,
  loadHiddenMessageIds,
  loadVisibleMessagesWithHiddenIds,
  removeThreadCache,
  threadCacheKey,
} from './messagesHidden';

type Row = { id: string; created_at: string; hidden?: boolean };

const row = (id: string, createdAt: string, extra: { hidden?: boolean } = {}): Row => ({
  id,
  created_at: createdAt,
  ...extra,
});

test('thread filter includes messages in both participant directions', () => {
  assert.equal(
    messagesThreadFilter('user-a', 'user-b'),
    'and(sender_id.eq.user-a,recipient_id.eq.user-b),and(sender_id.eq.user-b,recipient_id.eq.user-a)',
  );
});

test('a failed or incomplete thread load does not show the empty-conversation prompt', () => {
  assert.equal(shouldShowEmptyThreadMessage(0, 'error'), false);
  assert.equal(shouldShowEmptyThreadMessage(0, 'loading'), false);
  assert.equal(shouldShowEmptyThreadMessage(0, 'loaded', true), false);
  assert.equal(shouldShowEmptyThreadMessage(0, 'loaded'), true);
  assert.equal(shouldShowEmptyThreadMessage(1, 'error'), false);
});

test('cached messages claim the initial scroll before Supabase responds and only once', () => {
  let state = createInitialThreadScrollState('contact-a', true);
  let initialScrollCount = 0;

  const cacheRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loading', true);
  assert.equal(cacheRender.completed, true);
  assert.equal(cacheRender.shouldScroll, true);
  initialScrollCount += Number(cacheRender.shouldScroll);
  state = cacheRender.state;
  assert.equal(state.phase, 'completed');

  // Server load start/completion cannot put a completed conversation back into an initial phase.
  assert.strictEqual(markInitialThreadServerLoaded(state, 'contact-a'), state);
  const serverRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loaded', true);
  assert.equal(serverRender.completed, false);
  assert.equal(serverRender.shouldScroll, false);
  initialScrollCount += Number(serverRender.shouldScroll);
  assert.equal(initialScrollCount, 1);
});

test('lazy media reflow after opening cached history preserves latest, but never pulls a history reader down', () => {
  // Opening the cache initially reaches the bottom; a lazy image in an older row then expands.
  const beforeImageLoad = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 };
  const afterImageLoad = { scrollTop: 400, scrollHeight: 1280, clientHeight: 600 };
  const followedScrollTop = scrollTopAfterContentResize(
    beforeImageLoad.scrollTop,
    beforeImageLoad,
    afterImageLoad,
    true,
  );
  assert.equal(followedScrollTop, 680);
  assert.equal(afterImageLoad.scrollHeight - afterImageLoad.clientHeight - followedScrollTop, 0);

  // Once the user reads older messages, the same async media resize cannot force the bottom.
  const readerScrollTop = 180;
  assert.equal(scrollTopAfterContentResize(
    readerScrollTop,
    { scrollHeight: 1280, clientHeight: 600 },
    { scrollHeight: 1510, clientHeight: 600 },
    false,
  ), readerScrollTop);

  // A later older-page prepend still restores the actual visible anchor after layout changes.
  assert.equal(scrollTopPreservingAnchor(readerScrollTop, 45, 285), 420);
});

test('without cache, initial scroll waits for a successful server render', () => {
  let state = createInitialThreadScrollState('contact-a', false);
  let initialScrollCount = 0;

  assert.equal(claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loading', true).completed, false);
  assert.equal(claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'error', true).completed, false);
  assert.equal(state.phase, 'waiting-for-server');

  state = markInitialThreadServerLoaded(state, 'contact-a');
  assert.equal(state.phase, 'waiting-for-server-render');
  assert.equal(claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loading', true).completed, false);

  const firstServerRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loaded', true);
  assert.equal(firstServerRender.completed, true);
  assert.equal(firstServerRender.shouldScroll, true);
  initialScrollCount += Number(firstServerRender.shouldScroll);
  state = firstServerRender.state;

  const repeatedRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loaded', true);
  assert.equal(repeatedRender.completed, false);
  initialScrollCount += Number(repeatedRender.shouldScroll);
  assert.equal(initialScrollCount, 1);
});

test('cached history stays ready while Supabase is delayed and automatic layout events cannot page older rows', () => {
  let state = createInitialThreadScrollState('contact-a', true);
  const cachedRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loading', true);
  state = cachedRender.state;
  assert.equal(state.phase, 'completed');
  assert.strictEqual(markInitialThreadServerLoaded(state, 'contact-a'), state);

  const atTop = { scrollTop: 30, scrollHeight: 1800, clientHeight: 600 };
  for (const automaticCause of ['open', 'cache-render', 'programmatic-scroll', 'DOM-update', 'Supabase-update', 'resize', 'keyboard']) {
    const upwardUserScroll = isUserInitiatedUpwardScroll(100, 30, true, false);
    assert.equal(shouldLoadOlderMessagesFromScroll(atTop, true, false, upwardUserScroll), false, automaticCause);
  }
  const upwardUserScroll = isUserInitiatedUpwardScroll(100, 30, true, true);
  assert.equal(shouldLoadOlderMessagesFromScroll(atTop, true, false, upwardUserScroll), true);
});

test('server updates preserve completed initial state and merge without duplicates while following latest', () => {
  let state = createInitialThreadScrollState('contact-a', true);
  const cacheRender = claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loading', true);
  state = cacheRender.state;
  state = markInitialThreadServerLoaded(state, 'contact-a');

  const merged = mergeThreadRows(
    [row('cached', '2026-01-01T10:00:00Z')],
    [row('cached', '2026-01-01T10:00:00Z'), row('latest', '2026-01-01T10:00:01Z')],
  );
  assert.deepEqual(merged.map(message => message.id), ['cached', 'latest']);
  assert.equal(isThreadNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }), true);
  assert.equal(state.phase, 'completed');
  assert.equal(claimInitialThreadScroll(state, 'contact-a', 'contact-a', 'loaded', true).completed, false);
});

test('thread refreshes keep monotonic receipts while accepting fresh message content', () => {
  const delivered = {
    ...row('message-a', '2026-01-01T10:00:00Z'),
    delivered_at: '2026-01-01T10:01:00Z',
    read_at: '2026-01-01T10:02:00Z',
    content: 'before edit',
  };
  const refreshed = {
    ...row('message-a', '2026-01-01T10:00:00Z'),
    delivered_at: '2026-01-01T10:00:30Z',
    read_at: '2026-01-01T10:01:00Z',
    content: 'fresh edit',
  };

  const merged = mergeThreadRows([delivered], [refreshed]);
  assert.equal(merged[0].delivered_at, delivered.delivered_at);
  assert.equal(merged[0].read_at, delivered.read_at);
  assert.equal(merged[0].content, 'fresh edit');
  assert.equal(merged.length, 1);
});

test('a stale conversation load cannot change a newer conversation scroll state or DOM source', () => {
  const stateB = createInitialThreadScrollState('contact-b', true);

  assert.equal(isCurrentThreadLoad(1, 1, 'contact-a', 'contact-b'), false);
  assert.strictEqual(markInitialThreadServerLoaded(stateB, 'contact-a'), stateB);
  assert.equal(claimInitialThreadScroll(stateB, 'contact-b', 'contact-a', 'loaded', true).completed, false);

  const currentCacheRender = claimInitialThreadScroll(stateB, 'contact-b', 'contact-b', 'loading', true);
  assert.equal(currentCacheRender.completed, true);
  assert.equal(currentCacheRender.shouldScroll, true);
});

test('manual upward reading cancels initial scroll without cancelling a completed scroll', () => {
  const pending = createInitialThreadScrollState('contact-a', false);
  const cancelled = cancelInitialThreadScroll(pending, 'contact-a');
  assert.equal(cancelled.phase, 'cancelled');
  assert.strictEqual(markInitialThreadServerLoaded(cancelled, 'contact-a'), cancelled);
  assert.equal(claimInitialThreadScroll(cancelled, 'contact-a', 'contact-a', 'loaded', true).completed, false);

  const completed = createInitialThreadScrollState('contact-a', true);
  const afterCache = claimInitialThreadScroll(completed, 'contact-a', 'contact-a', 'loading', true).state;
  assert.strictEqual(cancelInitialThreadScroll(afterCache, 'contact-a'), afterCache);
});

test('latest-message following uses the bottom threshold', () => {
  assert.equal(isThreadNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 320 }), true);
  assert.equal(isThreadNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 320 }), false);
});

test('older paging requires actual user-initiated upward movement at the top edge', () => {
  const atTop = { scrollTop: 30, scrollHeight: 1800, clientHeight: 600 };
  assert.equal(isUserInitiatedUpwardScroll(31, 30, true, true), true);
  assert.equal(isUserInitiatedUpwardScroll(30, 30, true, true), false);
  assert.equal(isUserInitiatedUpwardScroll(31, 30, false, true), false);
  assert.equal(isUserInitiatedUpwardScroll(31, 30, true, false), false);
  assert.equal(shouldLoadOlderMessagesFromScroll(
    atTop,
    true,
    false,
    isUserInitiatedUpwardScroll(31, 30, true, true),
  ), true);
  assert.equal(shouldLoadOlderMessagesFromScroll(atTop, true, false, false), false);
  assert.equal(shouldLoadOlderMessagesFromScroll(atTop, true, true, true), false);
  assert.equal(shouldLoadOlderMessagesFromScroll(atTop, false, false, true), false);
  assert.equal(shouldLoadOlderMessagesFromScroll({ ...atTop, scrollTop: 120 }, true, false, true), false);
});

test('older-page restoration keeps the current visible anchor in place', () => {
  assert.equal(scrollTopPreservingAnchor(300, 40, 340), 600);
  assert.equal(scrollTopPreservingAnchor(20, 80, 10), 0);
});

test('hidden message rows are removed after a successful hide lookup', async () => {
  const result = await loadVisibleMessagesWithHiddenIds([
    row('hidden-message', '2026-01-01T10:00:00Z'),
    row('visible-message', '2026-01-01T10:00:01Z'),
  ], async () => new Set(['hidden-message']));

  assert.deepEqual([...result.hiddenMessageIds], ['hidden-message']);
  assert.deepEqual(result.visibleMessages.map(message => message.id), ['visible-message']);
});

test('a hide lookup failure runs current-conversation cleanup and removes its local cache key', async () => {
  const queryError = new Error('message_hides query failed');
  const userId = 'user-1';
  const contactId = 'contact-a';
  const targetKey = threadCacheKey(userId, contactId);
  const otherKey = threadCacheKey(userId, 'contact-b');
  const cache = new Map([[targetKey, 'cached thread'], [otherKey, 'other conversation']]);
  const fakeLocalStorage = { removeItem: (key: string) => cache.delete(key) };
  let cleanupCount = 0;

  await assert.rejects(loadHiddenMessageIds(async () => ({
    data: [{ message_id: 'possibly-hidden' }],
    error: queryError,
  })), error => {
    assert(error instanceof HiddenMessagesLookupError);
    assert.equal(error.originalError, queryError);
    assert.equal(handleCurrentHiddenMessagesLookupFailure(error, () => true, lookupError => {
      assert.equal(lookupError, error);
      cleanupCount += 1;
      removeThreadCache(userId, contactId, fakeLocalStorage);
    }), true);
    return true;
  });

  assert.equal(cleanupCount, 1);
  assert.equal(cache.has(targetKey), false);
  assert.equal(cache.has(otherKey), true);
});

test('a rejected hide query is wrapped without losing its original error', async () => {
  const queryError = new Error('message_hides request rejected');

  await assert.rejects(loadHiddenMessageIds(async () => {
    throw queryError;
  }), error => error instanceof HiddenMessagesLookupError && error.originalError === queryError);
});

test('ordinary message errors do not run cleanup or remove the conversation cache', () => {
  const userId = 'user-1';
  const contactId = 'contact-a';
  const key = threadCacheKey(userId, contactId);
  const cache = new Map([[key, 'cached thread']]);
  const fakeLocalStorage = { removeItem: (storageKey: string) => cache.delete(storageKey) };
  let cleanupCount = 0;
  const handled = handleCurrentHiddenMessagesLookupFailure(new Error('messages query failed'), () => true, () => {
    cleanupCount += 1;
    removeThreadCache(userId, contactId, fakeLocalStorage);
  });

  assert.equal(handled, false);
  assert.equal(cleanupCount, 0);
  assert.equal(cache.has(key), true);
});

test('a stale older hide lookup failure after switching conversations preserves the new thread and cache', async () => {
  const userId = 'user-1';
  const oldContactId = 'contact-a';
  const newContactId = 'contact-b';
  const oldKey = threadCacheKey(userId, oldContactId);
  const newKey = threadCacheKey(userId, newContactId);
  const cache = new Map([[oldKey, 'old thread'], [newKey, 'new thread']]);
  const fakeLocalStorage = { removeItem: (key: string) => cache.delete(key) };
  const tracker = createOlderRequestTracker();
  const requestId = tracker.begin(oldContactId);
  let selectedContactId = oldContactId;
  let displayedThread = ['new conversation message'];
  let reactionsByMessage: Record<string, string[]> = { 'new conversation message': ['👍'] };
  let rejectLookup!: (error: Error) => void;
  const pendingLookup = loadHiddenMessageIds(() => new Promise<never>((_resolve, reject) => {
    rejectLookup = reject;
  }));
  selectedContactId = newContactId;
  rejectLookup(new Error('message_hides query failed'));

  let lookupFailure: unknown;
  try {
    await pendingLookup;
  } catch (error) {
    lookupFailure = error;
  }

  assert(lookupFailure instanceof HiddenMessagesLookupError);
  const handled = handleCurrentHiddenMessagesLookupFailure(
    lookupFailure,
    () => tracker.isCurrent(requestId, selectedContactId),
    () => {
      displayedThread = [];
      reactionsByMessage = {};
      removeThreadCache(userId, oldContactId, fakeLocalStorage);
    },
  );

  assert.equal(handled, false);
  assert.deepEqual(displayedThread, ['new conversation message']);
  assert.deepEqual(reactionsByMessage, { 'new conversation message': ['👍'] });
  assert.equal(cache.has(oldKey), true);
  assert.equal(cache.has(newKey), true);
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
  // أحدث صفحة أقصر من حجم الصفحة: لا شيء أقدم أصلاً.
  const descending = [...makeThreadRows(PAGE - 1)].reverse();
  const progress = progressAfterLatestPage(initialOlderPageProgress(), descending, PAGE);
  assert.equal(progress.hasOlder, false);

  const afterEmpty = progressAfterOlderPage(progress, [], PAGE);
  assert.equal(afterEmpty.cursor, progress.cursor);
  assert.equal(afterEmpty.hasOlder, false);
  assert.equal(afterEmpty.olderPagesLoaded, 1);
});


function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

interface ThreadMessageLike {
  id: string;
  created_at: string;
  sender_id: string;
  recipient_id: string;
  delivered_at: string | null;
  read_at: string | null;
  content?: string;
}

function threadMessage(id: string, createdAt: string, senderId = 'user-b', recipientId = 'user-a'): ThreadMessageLike {
  return {
    id,
    created_at: createdAt,
    sender_id: senderId,
    recipient_id: recipientId,
    delivered_at: null,
    read_at: null,
    content: id,
  };
}

test('thread messages paint before the reactions request settles', async () => {
  const reactionsRequest = createDeferred<void>();
  const events: string[] = [];
  let threadStatus = 'loading';
  let paintedCount = 0;

  const paint = runThreadFirstPaint({
    load: async () => ['m1', 'm2'],
    show: messages => {
      events.push('messages');
      paintedCount = messages.length;
      // في الصفحة: setThread ثم setThreadLoadStatus('loaded').
      threadStatus = 'loaded';
    },
    loadReactions: () => {
      events.push('reactions:start');
      return reactionsRequest.promise;
    },
    onLoadError: () => {
      threadStatus = 'error';
    },
  });

  // الرسائل حُلّت والتفاعلات ما زالت معلّقة.
  await paint;

  assert.equal(events[0], 'messages');
  assert.equal(paintedCount, 2);
  assert.equal(threadStatus, 'loaded');

  reactionsRequest.resolve();
  await reactionsRequest.promise;
  await flushMicrotasks(2);

  assert.deepEqual(events, ['messages', 'reactions:start']);
});

test('a slow or failed reactions request never changes the loaded thread state', async () => {
  const reactionsRequest = createDeferred<void>();
  let threadStatus = 'loading';
  let painted = false;
  let reactionsError: unknown = null;

  const paint = runThreadFirstPaint({
    load: async () => ['m1'],
    show: () => {
      painted = true;
      threadStatus = 'loaded';
    },
    loadReactions: () => reactionsRequest.promise,
    onLoadError: () => {
      threadStatus = 'error';
    },
    onReactionsError: error => {
      reactionsError = error;
    },
  });

  await paint;
  assert.equal(painted, true);
  assert.equal(threadStatus, 'loaded');
  assert.equal(reactionsError, null);

  reactionsRequest.reject(new Error('reactions unavailable'));
  await flushMicrotasks();
  await flushMicrotasks();

  // فشل التفاعلات لا يخفي الرسائل ولا يحوّل المحادثة إلى خطأ.
  assert.equal(painted, true);
  assert.equal(threadStatus, 'loaded');
  assert.equal(reactionsError instanceof Error, true);
});

test('a hidden-messages lookup failure prevents any thread paint', async () => {
  let threadStatus = 'loading';
  let painted = false;
  let loadFailure: unknown = null;

  await runThreadFirstPaint({
    load: async () => {
      // فشل التحقق من الإخفاء يصل من loadVisibleMessagesWithHiddenIds كما هو.
      throw new HiddenMessagesLookupError(new Error('hides unavailable'));
    },
    show: () => {
      painted = true;
    },
    loadReactions: async () => {
      throw new Error('should not run after a failed paint gate');
    },
    onLoadError: error => {
      loadFailure = error;
      threadStatus = 'error';
    },
  });

  assert.equal(painted, false);
  assert.equal(threadStatus, 'error');
  assert.equal(loadFailure instanceof HiddenMessagesLookupError, true);
});

test('hidden and deleted messages never reach the painted thread', async () => {
  const rows = [
    row('visible', '2027-01-01T10:00:00Z'),
    row('hidden', '2027-01-01T10:01:00Z'),
    row('deleted', '2027-01-01T10:02:00Z'),
  ];

  const { hiddenMessageIds, visibleMessages } = await loadVisibleMessagesWithHiddenIds(
    rows,
    async () => new Set(['hidden']),
  );
  const deletedMessageIds = new Set(['deleted']);
  const painted = visibleMessages.filter(message => !deletedMessageIds.has(message.id));

  assert.equal(hiddenMessageIds.has('hidden'), true);
  assert.deepEqual(painted.map(message => message.id), ['visible']);
});

test('the hidden-messages lookup starts before the message page arrives', async () => {
  const messagePage = createDeferred<Row[]>();
  const events: string[] = [];

  // نفس ترتيب loadThread: التحقق يبدأ قبل وعد الرسائل، ثم يُنتظر بعد وصولها.
  const hiddenRequest = (async () => {
    events.push('hidden:start');
    await Promise.resolve();
    events.push('hidden:done');
    return new Set(['hidden']);
  })();

  const paintMessages = (async () => {
    const rows = await messagePage.promise;
    const { visibleMessages } = await loadVisibleMessagesWithHiddenIds(rows, () => hiddenRequest);
    return visibleMessages;
  })();

  messagePage.resolve([
    row('visible', '2027-01-01T10:00:00Z'),
    row('hidden', '2027-01-01T10:01:00Z'),
  ]);

  const visible = await paintMessages;

  assert.deepEqual(events.slice(0, 2), ['hidden:start', 'hidden:done']);
  assert.deepEqual(visible.map(message => message.id), ['visible']);
});

test('a Realtime message that arrives during the load survives the merge', () => {
  const fetched = [threadMessage('m1', '2027-01-01T10:00:00Z')];
  const realtime = [threadMessage('m2', '2027-01-01T10:05:00Z')];

  const merged = mergeRealtimeThreadMessages(
    [],
    fetched,
    realtime,
    'user-a',
    'user-b',
    mergeThreadRows,
  );

  assert.deepEqual(merged.map(message => message.id), ['m1', 'm2']);
});

test('merging a fetched page with the same Realtime event never duplicates a message', () => {
  const fetched = [
    threadMessage('m1', '2027-01-01T10:00:00Z'),
    threadMessage('m2', '2027-01-01T10:05:00Z'),
  ];
  const realtime = [threadMessage('m2', '2027-01-01T10:05:00Z')];

  const merged = mergeRealtimeThreadMessages(
    [threadMessage('m1', '2027-01-01T10:00:00Z')],
    fetched,
    realtime,
    'user-a',
    'user-b',
    mergeThreadRows,
  );

  assert.deepEqual(merged.map(message => message.id), ['m1', 'm2']);
  assert.equal(merged.filter(message => message.id === 'm2').length, 1);
});

test('an older thread request is not current once a newer load or conversation starts', () => {
  assert.equal(isCurrentThreadLoad(1, 2, 'contact-a', 'contact-a'), false);
  assert.equal(isCurrentThreadLoad(2, 2, 'contact-a', 'contact-b'), false);
  assert.equal(isCurrentThreadLoad(2, 2, 'contact-a', 'contact-a'), true);
});

test('a local reaction edit made while reactions load is not overwritten', async () => {
  const reactionsRequest = createDeferred<Array<{ message_id: string; user_id: string; emoji: string }>>();
  const visibleMessageIds = new Set(['m1']);
  const versionsAtRequestStart = new Map([['m1', 1]]);
  const mutationVersions = new Map(versionsAtRequestStart);
  const currentReactions = {
    m1: [{ user_id: 'other', emoji: '❤️' }, { user_id: 'user-a', emoji: '👍' }],
  };

  // المستخدم يعدّل تفاعله بعد بدء طلب التفاعلات.
  mutationVersions.set('m1', 2);
  reactionsRequest.resolve([
    { message_id: 'm1', user_id: 'other', emoji: '❤️' },
    { message_id: 'm1', user_id: 'user-a', emoji: '😢' },
  ]);

  const next = overlayLocalReactions(
    reactionsFromThreadRows(await reactionsRequest.promise, visibleMessageIds),
    {
      actorId: 'user-a',
      visibleMessageIds,
      mutationVersions,
      versionsAtRequestStart,
      currentReactions,
      pendingReactions: new Map(),
    },
  );

  assert.deepEqual(next.m1, [
    { user_id: 'other', emoji: '❤️' },
    { user_id: 'user-a', emoji: '👍' },
  ]);
});

test('a pending reaction removal wins over a stale server row', () => {
  const visibleMessageIds = new Set(['m1']);
  const next = overlayLocalReactions(
    reactionsFromThreadRows([{ message_id: 'm1', user_id: 'user-a', emoji: '😢' }], visibleMessageIds),
    {
      actorId: 'user-a',
      visibleMessageIds,
      mutationVersions: new Map(),
      versionsAtRequestStart: new Map(),
      currentReactions: {},
      pendingReactions: new Map([['m1', { emoji: null }]]),
    },
  );

  assert.equal(next.m1, undefined);
});

test('a failed reactions request keeps the visible local reactions', () => {
  const current = {
    m1: [{ user_id: 'other', emoji: '❤️' }],
    m2: [{ user_id: 'other', emoji: '👍' }],
  };
  const next = reactionsForVisibleMessages(current, new Set(['m1']));

  assert.deepEqual(Object.keys(next), ['m1']);
  assert.strictEqual(next.m1, current.m1);
});

test('reaction rows for messages outside the painted page are ignored', () => {
  const next = reactionsFromThreadRows([
    { message_id: 'm1', user_id: 'other', emoji: '❤️' },
    { message_id: 'old-page', user_id: 'other', emoji: '👍' },
    { message_id: 'm1', user_id: 'other', emoji: 5 },
  ] as Array<{ message_id: string; user_id: string; emoji: string }>, new Set(['m1']));

  assert.deepEqual(Object.keys(next), ['m1']);
  assert.deepEqual(next.m1, [{ user_id: 'other', emoji: '❤️' }]);
});
