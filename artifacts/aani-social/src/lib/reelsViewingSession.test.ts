// اختبارات جلسة عرض الريلز — منطق خالص بلا متصفح وبلا شبكة:
// - زيارة جديدة (جلسة جديدة) لا تُمنع من ترتيب جديد بسبب التخزين المؤقت.
// - إعادة تركيب المكوّن داخل الجلسة نفسها لا تُكرّر الطلب قبل انتهاء المدة.
// - انتهاء المدة داخل الجلسة نفسها يسمح بجلب جديد.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentReelsViewingSession,
  isReelsCacheFresh,
  startReelsViewingSession,
} from './reelsViewingSession';

test('كل بدء جلسة عرض يعطي رقمًا جديدًا أكبر من السابق', () => {
  const first = startReelsViewingSession();
  const second = startReelsViewingSession();
  assert.ok(second > first);
  assert.equal(currentReelsViewingSession(), second);
});

test('جلسة جديدة لا تُستخدم فيها دفعة جلسة سابقة حتى لو كانت حديثة', () => {
  const session = startReelsViewingSession();
  const mark = { session, at: 1_000 };

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: true,
    cacheMark: mark,
    viewingSession: session,
    now: 2_000,
    ttlMs: 300_000,
  }), true);

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: true,
    cacheMark: mark,
    viewingSession: session + 1,
    now: 2_000,
    ttlMs: 300_000,
  }), false);
});

test('داخل الجلسة نفسها: حديثة تُستخدم، ومنتهية تُجلب من الخادم', () => {
  const session = startReelsViewingSession();
  const mark = { session, at: 10_000 };

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: true,
    cacheMark: mark,
    viewingSession: session,
    now: 10_000 + 299_999,
    ttlMs: 300_000,
  }), true);

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: true,
    cacheMark: mark,
    viewingSession: session,
    now: 10_000 + 300_000,
    ttlMs: 300_000,
  }), false);
});

test('بلا دفعة محفوظة أو بلا بصمة جلب: لا نعتبر الكاش صالحًا', () => {
  const session = startReelsViewingSession();

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: false,
    cacheMark: { session, at: 0 },
    viewingSession: session,
    now: 1,
    ttlMs: 300_000,
  }), false);

  assert.equal(isReelsCacheFresh({
    hasCachedBatch: true,
    cacheMark: undefined,
    viewingSession: session,
    now: 1,
    ttlMs: 300_000,
  }), false);
});
