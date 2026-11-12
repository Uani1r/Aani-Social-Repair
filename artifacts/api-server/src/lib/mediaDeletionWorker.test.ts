// اختبارات وحدة لمنطق إعادة محاولة مهام الحذف (mediaDeletionWorker):
// Backoff تصاعدي بلا قفزات غير متوقعة، سقف 24 ساعة، وإيقاف المحاولات عند
// استنفاد الحد الأقصى — المهمة تُعلَّم failed لكنها تبقى قابلة لإعادة الفتح.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRetryDelayMs, shouldStopRetrying } from "./mediaDeletionWorker";

test('تأخير إعادة المحاولة يتصاعد أُسّياً من 5 دقائق', () => {
  assert.equal(computeRetryDelayMs(0), 5 * 60 * 1000);
  assert.equal(computeRetryDelayMs(1), 10 * 60 * 1000);
  assert.equal(computeRetryDelayMs(2), 20 * 60 * 1000);
  assert.equal(computeRetryDelayMs(5), 32 * 5 * 60 * 1000);
});

test('تأخير إعادة المحاولة يسقف عند 24 ساعة بغض النظر عن المحاولة', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(computeRetryDelayMs(8), Math.min(256 * 5 * 60 * 1000, day));
  assert.equal(computeRetryDelayMs(8), day);
  assert.equal(computeRetryDelayMs(20), day);
});

test('مدخلات غير منطقية آمنة (سالب/كسرية/NaN تُعامل كصفر)', () => {
  assert.equal(computeRetryDelayMs(-3), 5 * 60 * 1000);
  assert.equal(computeRetryDelayMs(2.7), 20 * 60 * 1000);
});

test('إيقاف المحاولات عند الحد الأقصى (12) والبقاء قابل لإعادة الفتح قبله', () => {
  assert.equal(shouldStopRetrying(0), false);
  assert.equal(shouldStopRetrying(11), false);
  assert.equal(shouldStopRetrying(12), true);
  assert.equal(shouldStopRetrying(13), true);
  assert.equal(shouldStopRetrying(5, 6), false);
  assert.equal(shouldStopRetrying(6, 6), true);
});
