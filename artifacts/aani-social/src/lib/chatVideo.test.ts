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
  chatVideoRejectMessage,
  checkChatVideoLimits,
  describeChatVideoMetrics,
  parseChatVideoMessage,
} from './chatVideo';

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
  assert.equal(parseChatVideoMessage(`${CHAT_VIDEO_MESSAGE_PREFIX}{"url":"https://x/v.mp4","posterUrl":"x"}`), null);
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
  for (const reason of ['not-a-video', 'too-long', 'too-large', 'compression-failed', 'audio-lost'] as const) {
    const message = chatVideoRejectMessage(reason, 'detail');
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

  // لا autoPlay، ولا عنصر فيديو بمصدر قبل ضغط التشغيل
  assert.equal(/autoPlay/.test(player), false);
  assert.equal(player.includes('playsInline'), true);
  assert.equal(player.includes('preload="metadata"'), true);
  assert.equal(player.includes('!started && ('), true);
  // عناصر التحكم المطلوبة
  for (const part of ['type="range"', 'formatChatVideoTime(currentMs)', 'formatChatVideoTime(totalMs)', 'nextChatVideoMuteState', 'isChatVideoFullscreenSupported', 'RotateCcw']) {
    assert.equal(player.includes(part), true, `missing ${part}`);
  }
});
