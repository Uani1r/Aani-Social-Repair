// اختبارات وحدة للمنطق الصرف في منظومة الضغط (تعمل بـ tsx --test دون متصفح).
// تثبت: أن highlightCover يُعامل كصورة (إصلاح رفعه خاماً)، حدود الحجم،
// حساب معدل بت الفيديو، وتطبيع الروابط الذي يقرر "الملف نفسه أم لا".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateVideoBitrate,
  findMp4CodecMarkers,
  getCompressionMetrics,
  IMAGE_PRESETS,
  isImagePreset,
  MAX_UPLOAD_BYTES,
  normalizeMediaUrl,
  recordCompressionMetric,
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

test('مسح FourCC يثبت ترميز avc1 فعلياً (لا قبول بالامتداد وحده)', () => {
  const encoder = new TextEncoder();
  const chunk = (text: string) => encoder.encode(text);

  // حاوية تحمل avc1 داخل stsd → مقبول للمرور
  const withAvc = findMp4CodecMarkers([chunk('....ftypisom....'), chunk('....avc1.64001f....')]);
  assert.equal(withAvc.hasH264, true);
  assert.equal(withAvc.hasAacAudio, false); // فيديو صامت مشروع

  // فيديو بصوت AAC
  const withBoth = findMp4CodecMarkers([chunk('....avc1....mp4a.40.2....')]);
  assert.equal(withBoth.hasH264, true);
  assert.equal(withBoth.hasAacAudio, true);

  // فيديو بترميز آخر (hevc مثلاً) → لا يُقبل كـ H.264
  const hevc = findMp4CodecMarkers([chunk('....hvc1....')]);
  assert.equal(hevc.hasH264, false);

  // لا علامات إطلاقاً
  const empty = findMp4CodecMarkers([chunk('....ftypisom....mdat....')]);
  assert.equal(empty.hasH264, false);
});

test('العلامات الممتدة عبر حدود القطع تُكتشف (carry 3 بايت)', () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('xxxa');
  const rest = encoder.encode('vc1yyy');
  const split = findMp4CodecMarkers([bytes, rest]);
  assert.equal(split.hasH264, true);
});

test('سجل القياسات يحسب نسبة التوفير وينعّم السجل عند 200', () => {
  recordCompressionMetric({
    kind: 'image',
    preset: 'avatar',
    originalBytes: 1000,
    finalBytes: 200,
    durationMs: 120,
    outcome: 'ok',
  });
  const metrics = getCompressionMetrics();
  const last = metrics[metrics.length - 1];
  assert.equal(last.savingPct, 80); // (1000 - 200) / 1000 = 80%
  assert.equal(last.outcome, 'ok');

  // صفر أصول → توفير 0 لا NaN
  recordCompressionMetric({
    kind: 'video',
    preset: 'video',
    originalBytes: 0,
    finalBytes: 0,
    durationMs: 5,
    outcome: 'failed',
    failureReason: 'test',
  });
  assert.equal(getCompressionMetrics()[getCompressionMetrics().length - 1].savingPct, 0);

  // السجل مخروطي بحد 200
  for (let index = 0; index < 250; index += 1) {
    recordCompressionMetric({
      kind: 'image',
      preset: 'feedImage',
      originalBytes: 100,
      finalBytes: 50,
      durationMs: 1,
      outcome: 'ok',
    });
  }
  assert.ok(getCompressionMetrics().length <= 200);
});
