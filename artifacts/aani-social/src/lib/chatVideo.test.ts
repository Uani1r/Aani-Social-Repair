import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CHAT_VIDEO_MAX_BYTES,
  CHAT_VIDEO_MAX_DURATION_MS,
  CHAT_VIDEO_MESSAGE_PREFIX,
  buildChatVideoMetrics,
  chatVideoMessageContent,
  chatVideoPreviewText,
  chatVideoRejectMessage,
  chatVideoReplyPreviewText,
  checkChatVideoLimits,
  describeChatVideoMetrics,
  parseChatVideoMessage,
} from './chatVideo';
import { getCompressionMetrics, recordCompressionMetric, resolveRecordedAudioState } from '../utils/mediaCompressor';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

const payload = {
  url: 'https://ik.imagekit.io/anisocial/aani/u1/messages/v1.mp4',
  durationMs: 12_000,
  posterUrl: 'https://ik.imagekit.io/anisocial/aani/u1/messages/p1.jpg',
  caption: 'مقطع',
  viewOnce: true,
  width: 1280,
  height: 720,
};

test('a chat video payload round-trips and keeps its poster, size and duration', () => {
  const parsed = parseChatVideoMessage(chatVideoMessageContent(payload));

  assert.deepEqual(parsed, payload);
});

test('a malformed or non-video payload is rejected instead of rendered', () => {
  assert.equal(parseChatVideoMessage(''), null);
  assert.equal(parseChatVideoMessage('[aani-image:v1]{"urls":[]}'), null);
  assert.equal(parseChatVideoMessage(`${CHAT_VIDEO_MESSAGE_PREFIX}{`), null);
  assert.equal(parseChatVideoMessage(`${CHAT_VIDEO_MESSAGE_PREFIX}{"url":"/aani/u1/v.mp4"}`), null);
  // غلاف غير صالح لا يُسقط الفيديو: يُحذف الغلاف ويبقى الفيديو صالحاً
  const withoutPoster = parseChatVideoMessage(`${CHAT_VIDEO_MESSAGE_PREFIX}{"url":"https://ik.imagekit.io/anisocial/aani/u1/messages/v.mp4","posterUrl":"x"}`);
  assert.equal(withoutPoster?.posterUrl, null);
});

test('the current send limits stay at 60 seconds and 25MB', () => {
  assert.equal(CHAT_VIDEO_MAX_DURATION_MS, 60_000);
  assert.equal(CHAT_VIDEO_MAX_BYTES, 25 * 1000 * 1000);

  assert.equal(checkChatVideoLimits({ durationSeconds: 59.9, sizeBytes: 24_000_000 }), null);
  assert.equal(checkChatVideoLimits({ durationSeconds: 60.5, sizeBytes: 1_000_000 }), 'too-long');
  assert.equal(checkChatVideoLimits({ durationSeconds: 10, sizeBytes: 26_000_000 }), 'too-large');
  // مدة مجهولة لا تُرفض هنا؛ الحجم يُفحص دائماً
  assert.equal(checkChatVideoLimits({ durationSeconds: 0, sizeBytes: 26_000_000 }), 'too-large');
  assert.equal(checkChatVideoLimits({ durationSeconds: 0, sizeBytes: 1_000 }), null);
});

test('every rejection has a clear Arabic message instead of a silent skip', () => {
  for (const reason of ['not-a-video', 'too-long', 'too-large', 'compression-failed', 'audio-lost', 'audio-unverified'] as const) {
    const message = chatVideoRejectMessage(reason);
    assert.ok(message.length > 20, `missing message for ${reason}`);
    assert.equal(/[a-z]{4,}/i.test(message), false, `message must be Arabic: ${message}`);
  }
  // الفشل الصامت غير مقبول: الرسالة توضح أن الملف الأصلي لم يُرفع
  assert.equal(chatVideoRejectMessage('compression-failed').includes('لم يُرفع'), true);
  assert.equal(chatVideoRejectMessage('audio-lost').includes('صامت'), true);
});

test('audio presence is recorded as measured, never assumed', () => {
  const withoutAudio = buildChatVideoMetrics({ originalBytes: 0, finalBytes: 0, hasAudioBefore: false });
  assert.equal(withoutAudio.hasAudioBefore, false);
  assert.equal(withoutAudio.hasAudioAfter, false);

  const lost = buildChatVideoMetrics({ originalBytes: 1000, finalBytes: 500, hasAudioBefore: true, hasAudioAfter: false });
  assert.equal(lost.hasAudioBefore, true);
  assert.equal(lost.hasAudioAfter, false);

  const metrics = buildChatVideoMetrics({
    originalBytes: 4_000_000,
    finalBytes: 1_000_000,
    processingMs: 2400,
    durationSeconds: 12.5,
    width: 1280,
    height: 720,
    fps: 30,
    hasAudioBefore: true,
    hasAudioAfter: true,
  });
  assert.equal(metrics.savingPct, 75);
  assert.equal(metrics.durationSeconds, 12.5);
  assert.equal(metrics.width, 1280);
  assert.equal(metrics.fps, 30);
  assert.equal(describeChatVideoMetrics(metrics).includes('75% توفير'), true);
  assert.equal(describeChatVideoMetrics(metrics).includes('1280×720'), true);
});

test('the compression pipeline keeps AAC encoding and never returns a silent video', () => {
  const compressor = read('./utils/mediaCompressor.ts');

  // مُرمِّز AAC يُسجَّل قبل التحويل (Safari وChrome بلا AAC افتراضياً)
  assert.equal(/sourceHasAudio\s*\?\s*await ensureAacEncoder\(mb\)|if \(sourceHasAudio\) await ensureAacEncoder\(mb\)/.test(compressor), true);
  // التحقق من الصوت بعد الترميز، ورفض الناتج الصامت
  assert.equal(compressor.includes('لن يُرفع فيديو صامت'), true);
  assert.equal(compressor.includes('hasAudioAfter'), true);

  const chatVideo = read('./lib/chatVideoCompression.ts');
  // الضغط قبل الرفع، ولا رفع للملف الأصلي بصمت
  assert.equal(chatVideo.includes('compressVideo('), true);
  assert.equal(chatVideo.includes('checkChatVideoLimits('), true);
  assert.equal(chatVideo.includes('createVideoPoster('), true);
  assert.equal(chatVideo.includes('audio-lost'), true);
});

test('the chat video player never autoplays and loads only after a tap', () => {
  const player = read('./components/ChatVideoMessage.tsx');

  // لا خاصية تشغيل تلقائي، ولا عنصر فيديو بمصدر قبل ضغط التشغيل
  assert.equal(/autoPlay\s*=/.test(player), false);
  assert.equal(player.includes('playsInline'), true);
  assert.equal(player.includes('preload="metadata"'), true);
  assert.equal(player.includes('!started && ('), true);
  // عناصر التحكم المطلوبة
  for (const part of ['type="range"', 'formatChatVideoTime(currentMs)', 'formatChatVideoTime(totalMs)', 'nextChatVideoMuteState', 'isChatVideoFullscreenSupported', 'RotateCcw']) {
    assert.equal(player.includes(part), true, `missing ${part}`);
  }
});


test('audio after compression is never inherited from the source audio', () => {
  // بلا فحص مستقل: الحالة غير متحققة، ولا يُسجّل وجود صوت إطلاقاً
  assert.deepEqual(resolveRecordedAudioState(null), { audioVerification: 'unverified' });
  assert.deepEqual(resolveRecordedAudioState(undefined), { audioVerification: 'unverified' });
  assert.equal('hasAudioAfter' in resolveRecordedAudioState(null), false);

  // مع فحص مستقل: النتيجة كما فُحصت (وجوداً أو غياباً)
  assert.deepEqual(resolveRecordedAudioState({ hasAudio: true }), {
    hasAudioAfter: true,
    audioVerification: 'measured',
  });
  assert.deepEqual(resolveRecordedAudioState({ hasAudio: false }), {
    hasAudioAfter: false,
    audioVerification: 'measured',
  });
});

test('a skipped-passthrough metric with no audio check stays unverified, not "audio kept"', () => {
  recordCompressionMetric({
    kind: 'video',
    preset: 'video',
    originalBytes: 1_000,
    finalBytes: 1_000,
    durationMs: 1,
    outcome: 'skipped-passthrough',
    failureReason: 'no-webcodecs: mp4-structure-verified',
    audioVerification: 'unverified',
  });

  const metrics = getCompressionMetrics();
  const stored = metrics[metrics.length - 1];

  assert.equal(stored?.outcome, 'skipped-passthrough');
  assert.equal(stored?.audioVerification, 'unverified');
  // لا حقل صوت بعد الضغط: لا يُفترض بقاء صوت الأصل
  assert.equal(stored !== undefined && 'hasAudioAfter' in stored, false);
});


test('the conversation preview shows a readable video line, never the tag or JSON', () => {
  const content = chatVideoMessageContent(payload);
  assert.ok(parseChatVideoMessage(content));

  const sent = chatVideoPreviewText(true);
  const received = chatVideoPreviewText(false);

  assert.equal(sent, 'أنت: أرسلت فيديو');
  assert.equal(received, 'أرسل فيديو');
  assert.equal(chatVideoReplyPreviewText(), 'فيديو');

  for (const text of [sent, received, chatVideoReplyPreviewText()]) {
    assert.equal(text.includes(CHAT_VIDEO_MESSAGE_PREFIX), false);
    assert.equal(text.includes('[aani-'), false);
    assert.equal(/[{}"]/.test(text), false);
  }
});

test('an image message is never mistaken for a video preview', () => {
  const imageContent = '[aani-image:v1]{"urls":["https://ik.imagekit.io/anisocial/aani/u1/messages/a.jpg"],"caption":"","viewOnce":false}';
  assert.equal(parseChatVideoMessage(imageContent), null);
});

test('the message list checks video before it falls back to the raw content', () => {
  const page = read('./pages/MessagesPage.tsx');

  assert.equal(page.includes('if (chatVideoMessage) return chatVideoPreviewText(message.sender_id === currentUserId);'), true);
  assert.equal(page.includes('if (chatVideoMessage) return chatVideoReplyPreviewText();'), true);
  // الفحص بعد تحليل الحمولة وقبل أي إرجاع للمحتوى الخام في المعاينة
  const parseIndex = page.indexOf('const chatVideoMessage = parseChatVideoMessage(content);');
  const previewIndex = page.indexOf('if (chatVideoMessage) return chatVideoPreviewText(');
  assert.ok(parseIndex >= 0 && previewIndex > parseIndex);
});
