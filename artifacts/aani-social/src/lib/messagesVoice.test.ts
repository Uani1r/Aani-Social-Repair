import assert from 'node:assert/strict';
import test from 'node:test';

import { storageBucket, supabaseUrl } from './supabase';
import {
  CHAT_VOICE_MESSAGE_PREFIX,
  VOICE_MESSAGE_MAX_DURATION_MS,
  VOICE_PLAYBACK_RATES,
  VOICE_RECORDER_MIME_CANDIDATES,
  buildVoiceCompressionMetrics,
  isTrustedImageKitVoiceUrl,
  isTrustedSupabaseVoiceUrl,
  isTrustedVoiceUrl,
  normalizeVoiceMimeType,
  parseVoiceMessage,
  pickVoiceRecorderMimeType,
  voiceMessageContent,
} from './messagesVoice';

const IMAGEKIT_URL = 'https://ik.imagekit.io/anisocial/aani/00000000-0000-0000-0000-000000000001/messages/11111111-1111-4111-8111-111111111111.m4a';
const IMAGEKIT_ENDPOINT_PREFIX = IMAGEKIT_URL.slice(0, IMAGEKIT_URL.indexOf('/aani/'));
const IMAGEKIT_URL_WITHOUT_ENDPOINT = IMAGEKIT_URL.slice(IMAGEKIT_ENDPOINT_PREFIX.length);
const SUPABASE_URL = `${supabaseUrl}/storage/v1/object/public/${storageBucket}/00000000-0000-0000-0000-000000000001/messages/11111111-1111-4111-8111-111111111111.webm`;

test('ImageKit voice URLs inside the upload folder are trusted', () => {
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL), true);
  // نفس الرابط بلا معرّف endpoint (شكل بديل مشروع)
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL_WITHOUT_ENDPOINT), true);
  // معامل تحويلات/توقيع لا يغيّر هوية المسار
  assert.equal(isTrustedImageKitVoiceUrl(`${IMAGEKIT_URL}?tr=q-auto`), true);
  assert.equal(isTrustedImageKitVoiceUrl(`${IMAGEKIT_URL}?ik-s=abc&ik-t=123`), true);
  // صيغ أخرى داخل المجلد نفسه
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('.m4a', '.webm')), true);
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('.m4a', '.mp3')), true);
});

test('ImageKit URLs outside the approved host or folder are rejected', () => {
  // نطاق خارجي يدّعي المسار نفسه
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('ik.imagekit.io', 'evil.example')), false);
  // نطاق يشبه ImageKit لكنه ليس تابعاً له (خدعة اللاحقة)
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('ik.imagekit.io', 'ik.imagekit.io.evil.example')), false);
  // مجلد غير مجلد الرسائل
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('/messages/', '/posts/')), false);
  // خارج /aani كلياً
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('/aani/', '/other/')), false);
  // مقطع إضافي قبل aani ليس معرّف endpoint واحداً
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('/aani/', '/one/two/aani/')), false);
  // امتداد غير صوتي
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('.m4a', '.jpg')), false);
  // http بدل https
  assert.equal(isTrustedImageKitVoiceUrl(IMAGEKIT_URL.replace('https://', 'http://')), false);
  assert.equal(isTrustedImageKitVoiceUrl(''), false);
});

test('legacy Supabase Storage voice URLs keep working', () => {
  assert.equal(isTrustedSupabaseVoiceUrl(SUPABASE_URL), true);
  // مسار كائني مختلف داخل الـbucket نفسه (صفوف قديمة)
  assert.equal(
    isTrustedSupabaseVoiceUrl(`${supabaseUrl}/storage/v1/object/public/${storageBucket}/legacy/voice-1.webm`),
    true,
  );
  // مشروع Supabase آخر
  assert.equal(
    isTrustedSupabaseVoiceUrl(SUPABASE_URL.replace(supabaseUrl, 'https://anotherproject.supabase.co')),
    false,
  );
  // bucket آخر
  assert.equal(
    isTrustedSupabaseVoiceUrl(SUPABASE_URL.replace(`/${storageBucket}/`, '/other-bucket/')),
    false,
  );
});

test('untrusted schemes and hosts are rejected', () => {
  assert.equal(isTrustedVoiceUrl('javascript:alert(1)'), false);
  assert.equal(isTrustedVoiceUrl('data:audio/mp4;base64,AAAA'), false);
  assert.equal(isTrustedVoiceUrl('file:///etc/passwd'), false);
  assert.equal(isTrustedVoiceUrl('https://example.com/voice.m4a'), false);
  assert.equal(isTrustedVoiceUrl('not a url'), false);
  assert.equal(isTrustedVoiceUrl(''), false);
  // المعاينة المحلية قبل الرفع تبقى مسموحة
  assert.equal(isTrustedVoiceUrl('blob:https://app.example/11111111-1111-4111-8111-111111111111'), true);
});

test('a voice message with an ImageKit URL parses as a player payload', () => {
  const content = voiceMessageContent(IMAGEKIT_URL.replace('https://', 'http://'), 4200);
  // الرابط http أعلاه غير موثوق عمداً: البناء لا يفحص، لكن التحليل يرفضه
  assert.equal(parseVoiceMessage(content), null);

  const payload = parseVoiceMessage(voiceMessageContent(IMAGEKIT_URL, 4200));
  assert.deepEqual(payload, { url: IMAGEKIT_URL, durationMs: 4200 });
});

test('legacy Supabase messages and blob previews still parse', () => {
  assert.deepEqual(
    parseVoiceMessage(voiceMessageContent(SUPABASE_URL, 12_500)),
    { url: SUPABASE_URL, durationMs: 12_500 },
  );

  const local = 'blob:https://app.example/22222222-2222-4222-8222-222222222222';
  assert.deepEqual(
    parseVoiceMessage(voiceMessageContent(local, 900)),
    { url: 'blob:https://app.example/22222222-2222-4222-8222-222222222222', durationMs: 900 },
  );
});

test('content built and parsed again keeps the same values', () => {
  const content = voiceMessageContent(IMAGEKIT_URL, 7000);
  assert.equal(content.startsWith(CHAT_VOICE_MESSAGE_PREFIX), true);
  const payload = parseVoiceMessage(content);
  assert.ok(payload);
  assert.equal(payload!.url, IMAGEKIT_URL);
  assert.equal(payload!.durationMs, 7000);
});

test('malformed or hostile content is rejected instead of rendered', () => {
  const prefix = CHAT_VOICE_MESSAGE_PREFIX;
  // بادئة بلا JSON
  assert.equal(parseVoiceMessage(prefix), null);
  assert.equal(parseVoiceMessage(`${prefix}{`), null);
  // JSON ليس كائناً
  assert.equal(parseVoiceMessage(`${prefix}null`), null);
  assert.equal(parseVoiceMessage(`${prefix}[]`), null);
  assert.equal(parseVoiceMessage(`${prefix}"text"`), null);
  // حقول ناقصة أو بأنواع خاطئة
  assert.equal(parseVoiceMessage(`${prefix}${JSON.stringify({ url: IMAGEKIT_URL })}`), null);
  assert.equal(parseVoiceMessage(`${prefix}${JSON.stringify({ durationMs: 10 })}`), null);
  assert.equal(parseVoiceMessage(`${prefix}${JSON.stringify({ url: IMAGEKIT_URL, durationMs: '10' })}`), null);
  assert.equal(parseVoiceMessage(`${prefix}${JSON.stringify({ url: 10, durationMs: 10 })}`), null);
  // أرقام غير منتهية
  assert.equal(parseVoiceMessage(`${prefix}${JSON.stringify({ url: IMAGEKIT_URL, durationMs: Infinity })}`), null);
  // رابط غير موثوق داخل محتوى صحيح البنية
  assert.equal(
    parseVoiceMessage(`${prefix}${JSON.stringify({ url: 'https://evil.example/voice.m4a', durationMs: 10 })}`),
    null,
  );
  // بادئة أخرى (رسالة نصية عادية تبدأ بـJSON)
  assert.equal(parseVoiceMessage(JSON.stringify({ url: IMAGEKIT_URL, durationMs: 10 })), null);
  assert.equal(parseVoiceMessage(''), null);
});

test('duration is clamped and never negative', () => {
  const negative = parseVoiceMessage(voiceMessageContent(IMAGEKIT_URL, -500));
  assert.equal(negative?.durationMs, 0);

  const huge = voiceMessageContent(IMAGEKIT_URL, VOICE_MESSAGE_MAX_DURATION_MS * 10);
  assert.equal(parseVoiceMessage(huge)?.durationMs, VOICE_MESSAGE_MAX_DURATION_MS);
});

test('recorder MIME candidates are ordered MP4 first then WebM', () => {
  assert.deepEqual([...VOICE_RECORDER_MIME_CANDIDATES], ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
});

test('the recorder picks the first MIME type the browser really supports', () => {
  assert.equal(pickVoiceRecorderMimeType(() => true), 'audio/mp4');
  assert.equal(
    pickVoiceRecorderMimeType(type => type === 'audio/webm;codecs=opus' || type === 'audio/webm'),
    'audio/webm;codecs=opus',
  );
  assert.equal(pickVoiceRecorderMimeType(type => type === 'audio/webm'), 'audio/webm');
  assert.equal(pickVoiceRecorderMimeType(() => false), null);
  // متصفح يرمي عند الفحص: لا يتوقف الاختيار
  assert.equal(
    pickVoiceRecorderMimeType(type => {
      if (type === 'audio/mp4') throw new Error('unsupported');
      return type === 'audio/webm';
    }),
    'audio/webm',
  );
});

test('the produced MIME type decides the upload format', () => {
  assert.deepEqual(normalizeVoiceMimeType('audio/mp4'), { mimeType: 'audio/mp4', extension: 'm4a' });
  assert.deepEqual(normalizeVoiceMimeType('audio/x-m4a'), { mimeType: 'audio/mp4', extension: 'm4a' });
  assert.deepEqual(normalizeVoiceMimeType('audio/aac'), { mimeType: 'audio/mp4', extension: 'm4a' });
  assert.deepEqual(normalizeVoiceMimeType('audio/webm;codecs=opus'), { mimeType: 'audio/webm', extension: 'webm' });
  assert.deepEqual(normalizeVoiceMimeType('AUDIO/WEBM'), { mimeType: 'audio/webm', extension: 'webm' });
  assert.equal(normalizeVoiceMimeType('audio/ogg'), null);
  assert.equal(normalizeVoiceMimeType('video/mp4'), null);
  assert.equal(normalizeVoiceMimeType(''), null);
});

test('playback rates are 1x, 1.5x and 2x', () => {
  assert.deepEqual([...VOICE_PLAYBACK_RATES], [1, 1.5, 2]);
});

test('compression metrics report the measured saving, not an assumed one', () => {
  const metrics = buildVoiceCompressionMetrics({
    originalBytes: 100_000,
    finalBytes: 18_000,
    processingMs: 640,
    sourceMimeType: 'audio/webm;codecs=opus',
    targetMimeType: 'audio/mp4',
  });
  assert.equal(metrics.savedPercent, 82);
  assert.equal(metrics.outcome, 'transcoded');
  assert.equal(metrics.processingMs, 640);
  assert.equal(metrics.sourceMimeType, 'audio/webm;codecs=opus');

  // ملف كبر: نسبة سالبة صادقة بدل ادّعاء توفير
  const grown = buildVoiceCompressionMetrics({ originalBytes: 10_000, finalBytes: 12_500 });
  assert.equal(grown.savedPercent, -25);

  // صفر أصل: صفر لا NaN
  const empty = buildVoiceCompressionMetrics({ originalBytes: 0, finalBytes: 0, outcome: 'failed', failureReason: 'no-audio' });
  assert.equal(empty.savedPercent, 0);
  assert.equal(empty.outcome, 'failed');
  assert.equal(empty.failureReason, 'no-audio');
});
