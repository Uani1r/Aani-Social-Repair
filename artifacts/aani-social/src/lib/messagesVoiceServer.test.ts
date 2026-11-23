import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  VOICE_TRANSCODE_ATTEMPTS,
  prepareVoiceMessageSource,
} from './messagesVoiceServer';
import { buildVoiceCompressionMetrics } from './messagesVoice';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

const WEBM = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' });
const M4A = new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'audio/mp4' });
const IMAGEKIT_URL = 'https://ik.imagekit.io/anisocial/aani/user-1/messages/msg-1.m4a';

const ready = () => ({
  url: IMAGEKIT_URL,
  metrics: buildVoiceCompressionMetrics({
    originalBytes: 4,
    finalBytes: 2,
    sourceMimeType: 'audio/webm;codecs=opus',
    targetMimeType: 'audio/mp4',
  }),
});

test('a WebM source whose server conversion fails is never sent as a voice message', async () => {
  let attempts = 0;
  const waits: number[] = [];

  const outcome = await prepareVoiceMessageSource(WEBM, 'msg-1', {
    transcode: async () => {
      attempts += 1;
      return null;
    },
    wait: async delayMs => { waits.push(delayMs); },
  });

  assert.deepEqual(outcome, { ok: false, reason: 'transcode-failed' });
  // محاولات محدودة، لا حلقة، ولا مسار بديل يرفع الـWebM
  assert.equal(attempts, VOICE_TRANSCODE_ATTEMPTS);
  assert.equal(waits.length, VOICE_TRANSCODE_ATTEMPTS - 1);
});

test('an M4A source is still not sent unless the server verified it', async () => {
  const outcome = await prepareVoiceMessageSource(M4A, 'msg-2', {
    transcode: async () => null,
    wait: async () => undefined,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'transcode-failed');
});

test('a conversion that succeeds on the retry is used', async () => {
  let attempts = 0;

  const outcome = await prepareVoiceMessageSource(WEBM, 'msg-3', {
    transcode: async () => {
      attempts += 1;
      return attempts === 1 ? null : ready();
    },
    wait: async () => undefined,
  });

  assert.equal(attempts, 2);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.url, IMAGEKIT_URL);
});

test('an empty recording is rejected before any conversion attempt', async () => {
  let attempts = 0;

  const outcome = await prepareVoiceMessageSource(new Blob([]), 'msg-4', {
    transcode: async () => { attempts += 1; return null; },
    wait: async () => undefined,
  });

  assert.deepEqual(outcome, { ok: false, reason: 'empty-recording' });
  assert.equal(attempts, 0);
});

test('the client source has no raw-upload fallback for voice', () => {
  const module = read('./lib/messagesVoiceServer.ts');
  // لا وسيط رفع مباشر: التسجيل الخام لا يُرفع كرسالة صوتية أبداً
  assert.equal(/uploadMedia\s*\(/.test(module), false);
  assert.equal(/uploadFileToImageKit/.test(module), false);
  assert.equal(/createObjectURL/.test(module), false);
});

test('the page keeps the recording for retry instead of uploading the raw blob', () => {
  const page = read('./pages/MessagesPage.tsx');
  // لا تمرير لصيغة المسجل الأصلية عند فشل الخادم
  assert.equal(page.includes("preset: 'voiceMessage'"), false);
  assert.equal(page.includes('prepareVoiceMessageSource('), true);
  assert.equal(page.includes('retryPendingVoice'), true);
});
