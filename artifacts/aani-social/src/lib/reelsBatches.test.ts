// اختبارات طابور الدفعات المعلّقة للريلز — منطق خالص بلا متصفح وبلا شبكة:
// - لا يُستبدل الترتيب المعروض أثناء المشاهدة (تدفئة الدفعة الجديدة بدل تطبيقها).
// - الدفعة المعلّقة تُطبَّق مرة واحدة فقط ثم تُحذف.
// - كل مفتاح (مستخدم/سطح) مستقل فلا تتسرب دفعة حساب إلى حساب آخر.
// - دفعة فارغة لا تُخزَّن، فلا تُستبدل قائمة سليمة بقائمة فارغة.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearPendingReelsBatch,
  getPendingReelsBatch,
  hasPendingReelsBatch,
  setPendingReelsBatch,
  shouldDeferReelsBatch,
} from './reelsBatches';

const batchOf = (...ids: string[]) => ids.map(id => ({ id }));

test('قرار التطبيق: وجود دفعة ظاهرة يؤجّل التبديل، وغيابها يطبّق فوراً', () => {
  assert.equal(shouldDeferReelsBatch(true), true);
  assert.equal(shouldDeferReelsBatch(false), false);
});

test('الدفعة المعلّقة تُقرأ دون حذف، ثم تُحذف عند التطبيق مرة واحدة', () => {
  const key = 'reel::user-a';
  clearPendingReelsBatch(key);

  setPendingReelsBatch(key, batchOf('p1', 'p2', 'p3'));
  assert.equal(hasPendingReelsBatch(key), true);
  assert.deepEqual(getPendingReelsBatch(key)?.map(post => post.id), ['p1', 'p2', 'p3']);

  // القراءة المتكررة لا تحذفها، فلا تضيع عند إعادة تركيب المكوّن.
  assert.deepEqual(getPendingReelsBatch(key)?.map(post => post.id), ['p1', 'p2', 'p3']);

  clearPendingReelsBatch(key);
  assert.equal(hasPendingReelsBatch(key), false);
  assert.equal(getPendingReelsBatch(key), undefined);
});

test('الدفعة الأحدث تستبدل الأقدم لنفس المفتاح ولا تُراكم دفعتين', () => {
  const key = 'reel::user-a';
  clearPendingReelsBatch(key);

  setPendingReelsBatch(key, batchOf('old-1', 'old-2'));
  setPendingReelsBatch(key, batchOf('new-1', 'new-2', 'new-3'));

  assert.deepEqual(getPendingReelsBatch(key)?.map(post => post.id), ['new-1', 'new-2', 'new-3']);
  clearPendingReelsBatch(key);
});

test('تبديل الحساب لا يعرض دفعة المستخدم السابق', () => {
  const previousUserKey = 'reel::user-a';
  const nextUserKey = 'reel::user-b';
  clearPendingReelsBatch(previousUserKey);
  clearPendingReelsBatch(nextUserKey);

  setPendingReelsBatch(previousUserKey, batchOf('a-1'));

  assert.equal(hasPendingReelsBatch(nextUserKey), false);
  assert.equal(getPendingReelsBatch(nextUserKey), undefined);
  assert.deepEqual(getPendingReelsBatch(previousUserKey)?.map(post => post.id), ['a-1']);

  clearPendingReelsBatch(previousUserKey);
});

test('سطح الريلز منفصل عن سطح الـFeed في نفس الحساب', () => {
  const reelsKey = 'reel::user-a';
  const feedKey = 'feed::user-a';
  clearPendingReelsBatch(reelsKey);
  clearPendingReelsBatch(feedKey);

  setPendingReelsBatch(reelsKey, batchOf('r-1'));

  assert.equal(hasPendingReelsBatch(feedKey), false);
  assert.deepEqual(getPendingReelsBatch(reelsKey)?.map(post => post.id), ['r-1']);

  clearPendingReelsBatch(reelsKey);
});

test('دفعة فارغة لا تُخزَّن فلا تمسح قائمة معروضة', () => {
  const key = 'reel::user-a';
  clearPendingReelsBatch(key);

  setPendingReelsBatch(key, []);

  assert.equal(hasPendingReelsBatch(key), false);
  assert.equal(getPendingReelsBatch(key), undefined);
});
