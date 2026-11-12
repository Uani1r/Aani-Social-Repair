// اختبارات وحدة للمنطق الصرف في منظومة الضغط (تعمل بـ tsx --test دون متصفح).
// تثبت: أن highlightCover يُعامل كصورة (إصلاح رفعه خاماً)، حدود الحجم،
// حساب معدل بت الفيديو، وتطبيع الروابط الذي يقرر "الملف نفسه أم لا".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateVideoBitrate,
  IMAGE_PRESETS,
  isImagePreset,
  MAX_UPLOAD_BYTES,
  normalizeMediaUrl,
  UNCOMPRESSIBLE_IMAGE_MAX_BYTES,
} from './mediaCompressor';

test('حد الرفع العام يحتفظ بهامش أمان تحت 25MB عشرياً', () => {
  assert.equal(MAX_UPLOAD_BYTES, 23.5 * 1024 * 1024);
  assert.ok(MAX_UPLOAD_BYTES < 25 * 1000 * 1000);
});

test('سقف GIF/SVG غير المضغوطة = 2MB', () => {
  assert.equal(UNCOMPRESSIBLE_IMAGE_MAX_BYTES, 2 * 1024 * 1024);
});

test('highlightCover يُعامل كصورة عبر الضغط المركزي (إصلاح الرفع الخام)', () => {
  for (const preset of ['avatar', 'cover', 'feedImage', 'highlightCover', 'storyImage', 'chatImage']) {
    assert.ok(IMAGE_PRESETS.has(preset as never), `الإعداد ${preset} يجب أن يكون ضمن IMAGE_PRESETS`);
    assert.equal(isImagePreset(preset as never), true);
  }
});

test('إعدادات الفيديو والصوت ليست إعدادات صور', () => {
  assert.equal(isImagePreset('video'), false);
  assert.equal(isImagePreset('voiceMessage'), false);
  assert.equal(isImagePreset('extractedSound'), false);
  assert.equal(isImagePreset(null), false);
  assert.equal(isImagePreset(undefined), false);
});

test('حساب معدل بت الفيديو يلتزم الحدود [500k, 4.5M]', () => {
  // فيديو قصير بميزانية كبيرة → السقف 4.5Mbps
  assert.equal(calculateVideoBitrate(1, 12 * 1024 * 1024), 4_500_000);
  // فيديو طويل جداً بميزانية صغيرة → الحد الأدنى 500kbps
  assert.equal(calculateVideoBitrate(3600, 1024 * 1024), 500_000);
  // حالة وسطى تطبق المعادلة نفسها
  const expected = Math.floor((1024 * 1024 * 8) / 10 - 128_000 - 80_000);
  assert.equal(calculateVideoBitrate(10, 1024 * 1024), expected);
  // المدة صفر أو سالبة آمنة (تُعامل كثانية واحدة)
  assert.equal(calculateVideoBitrate(0, 1024 * 1024), calculateVideoBitrate(1, 1024 * 1024));
});

test('تطبيع الروابط يوحد الملف بغض النظر عن معاملات العرض', () => {
  const base = 'https://ik.imagekit.io/anisocial/aani/u123/video-abc.mp4';
  assert.equal(normalizeMediaUrl(`${base}?tr=w-400`), base);
  assert.equal(normalizeMediaUrl(`${base}#t=5,10`), base);
  assert.equal(normalizeMediaUrl(`${base}?tr=q-auto#crop=1`), base);
  assert.equal(normalizeMediaUrl(base), base);
});

test('تطبيع الروابط القديمة النسبية لا يفشل', () => {
  assert.equal(normalizeMediaUrl('/aani/u123/x.jpg?v=1'), '/aani/u123/x.jpg');
  assert.equal(normalizeMediaUrl(''), '');
  assert.equal(normalizeMediaUrl(null), '');
  assert.equal(normalizeMediaUrl(42), '');
});
