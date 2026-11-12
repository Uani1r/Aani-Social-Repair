// اختبارات وحدة للمنطق الصرف في منظومة الضغط (تعمل بـ tsx --test دون متصفح).
// تثبت: أن highlightCover يُعامل كصورة (إصلاح رفعه خاماً)، حدود الحجم،
// حساب معدل بت الفيديو، وتطبيع الروابط الذي يقرر "الملف نفسه أم لا".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateVideoBitrate,
  decideMp4Passthrough,
  findMp4CodecMarkers,
  getCompressionMetrics,
  IMAGE_PRESETS,
  inspectMp4Bytes,
  isImagePreset,
  MAX_UPLOAD_BYTES,
  normalizeMediaUrl,
  recordCompressionMetric,
  UNCOMPRESSIBLE_IMAGE_MAX_BYTES,
  verifyMp4Passthrough,
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

/* ------------------------------------------------------------------ */
/* أدوات بناء MP4 اصطناعي للتحقق البنيوي (شجرة صناديق حقيقية)          */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32Bytes(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function u16Bytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  return concatBytes([u32Bytes(8 + payload.length), encoder.encode(type), payload]);
}

function buildSampleEntry(kind: 'video' | 'audio', codec: string, withConfig: boolean): Uint8Array {
  const configType = kind === 'video' ? 'avcC' : 'esds';
  // 8 بايت (reserved + data_reference_index) ثم ثوابت النوع البنيوية:
  // 78-8=70 للفيديو، 28-8=20 للصوت (ISO 14496-12 Visual/AudioSampleEntry)
  const fixedBody = concatBytes([
    new Uint8Array(6),
    u16Bytes(1),
    new Uint8Array(kind === 'video' ? 70 : 20),
  ]);
  return mp4Box(codec, withConfig
    ? concatBytes([fixedBody, mp4Box(configType, new Uint8Array(12))])
    : fixedBody);
}

function buildTrack(kind: 'video' | 'audio', codec: string, withConfig: boolean): Uint8Array {
  const stsd = mp4Box('stsd', concatBytes([
    u32Bytes(0), // version/flags
    u32Bytes(1), // entry_count
    buildSampleEntry(kind, codec, withConfig),
  ]));
  return mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', stsd))));
}

function buildMoov(...tracks: Uint8Array[]): Uint8Array {
  return mp4Box('moov', concatBytes(tracks));
}

function buildFtyp(): Uint8Array {
  return mp4Box('ftyp', concatBytes([
    encoder.encode('isom'),
    u32Bytes(512),
    encoder.encode('isom'),
    encoder.encode('mp41'),
  ]));
}

/* ------------------------------------------------------------------ */
/* التحقق البنيوي من MP4: لا مرور إلا على مواصفات مثبتة فعلاً          */
/* ------------------------------------------------------------------ */

test('التحقق البنيوي: avc1+avcC و mp4a+esds يُقبلان للمرور', () => {
  const bytes = concatBytes([buildFtyp(), buildMoov(buildTrack('video', 'avc1', true), buildTrack('audio', 'mp4a', true))]);
  const inspection = inspectMp4Bytes(bytes);
  assert.equal(inspection.containerVerified, true);
  assert.equal(inspection.moovVerified, true);
  assert.equal(inspection.tracks.length, 2);
  const decision = decideMp4Passthrough(inspection);
  assert.equal(decision.accepted, true);
  assert.ok(decision.reason.includes('avc1+avcC'));
  assert.ok(decision.reason.includes('mp4a/esds'));
});

test('avc1 بلا صندوق إعداد avcC يُرفض (الترميز غير مثبت بنيوياً)', () => {
  const bytes = concatBytes([buildFtyp(), buildMoov(buildTrack('video', 'avc1', false))]);
  const inspection = inspectMp4Bytes(bytes);
  const track = inspection.tracks.find(entry => entry.kind === 'video');
  assert.ok(track);
  assert.equal(track!.codec, 'avc1');
  assert.equal(track!.hasCodecConfig, false);
  assert.equal(decideMp4Passthrough(inspection).accepted, false);
  assert.equal(decideMp4Passthrough(inspection).reason, 'avc-configuration-box-missing');
});

test('hevc1 يُرفض (ليس H.264) ولا يمرر بالامتداد أو FourCC وحده', () => {
  const bytes = concatBytes([buildFtyp(), buildMoov(buildTrack('video', 'hvc1', true))]);
  const inspection = inspectMp4Bytes(bytes);
  const decision = decideMp4Passthrough(inspection);
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'video-codec-not-h264(hvc1)');
});

test('moov مفقود → بنية غير قابلة للتحقق → رفض', () => {
  const bytes = buildFtyp();
  const inspection = inspectMp4Bytes(bytes);
  assert.equal(inspection.moovVerified, false);
  const decision = decideMp4Passthrough(inspection);
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'moov-missing-or-unparseable');
});

test('صوت Opus داخل MP4 يُرفض (ليس AAC مثبتاً)', () => {
  const bytes = concatBytes([buildFtyp(), buildMoov(buildTrack('video', 'avc1', true), buildTrack('audio', 'Opus', true))]);
  const decision = decideMp4Passthrough(inspectMp4Bytes(bytes));
  assert.equal(decision.accepted, false);
  assert.ok(decision.reason.startsWith('audio-track-Opus-'));
});

test('فيديو صامت بلا مسار صوتي يُقبل (الصوت اختياري مشروع)', () => {
  const bytes = concatBytes([buildFtyp(), buildMoov(buildTrack('video', 'avc1', true))]);
  const decision = decideMp4Passthrough(inspectMp4Bytes(bytes));
  assert.equal(decision.accepted, true);
  assert.ok(decision.reason.includes('(silent)'));
});

test('verifyMp4Passthrough: moov بعد mdat ضخم يُكتشف بقراءة الصناديق العليا', async () => {
  const mdatPayload = new Uint8Array(2 * 1024 * 1024);
  const bytes = concatBytes([
    buildFtyp(),
    mp4Box('mdat', mdatPayload), // mdat بحجم صريح (الحجم صفر يعني آخر صندوق)
    buildMoov(buildTrack('video', 'avc1', true), buildTrack('audio', 'mp4a', true)),
  ]);
  const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
  assert.equal(await verifyMp4Passthrough(file), true);
});

test('verifyMp4Passthrough: بلا ftyp يُرفض مهما كانت شجرة moov سليمة', async () => {
  const bytes = buildMoov(buildTrack('video', 'avc1', true));
  const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
  assert.equal(await verifyMp4Passthrough(file), false);
});

test('verifyMp4Passthrough: hevc1 مخفي بعد mdat يُرفض', async () => {
  const bytes = concatBytes([
    buildFtyp(),
    mp4Box('mdat', new Uint8Array(64 * 1024)),
    buildMoov(buildTrack('video', 'hvc1', true)),
  ]);
  const file = new File([bytes], 'video.mp4', { type: 'video/mp4' });
  assert.equal(await verifyMp4Passthrough(file), false);
});