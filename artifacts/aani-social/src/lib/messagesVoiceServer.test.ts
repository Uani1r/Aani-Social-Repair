import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  VOICE_TRANSCODE_ATTEMPTS,
  hasM4aContainer,
  prepareVoiceMessageSource,
} from './messagesVoiceServer';
import { buildVoiceCompressionMetrics } from './messagesVoice';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

const IMAGEKIT_URL = 'https://ik.imagekit.io/anisocial/aani/user-1/messages/msg-1.m4a';

function m4aBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0, 0, 0, 16], 0); // box size
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  bytes.set([0x4d, 0x34, 0x41, 0x20], 8); // 'M4A '
  return bytes;
}

function webmBytes(): Uint8Array {
  // 1A 45 DF A3 — ترويسة EBML/WebM
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0]);
}

const M4A = new Blob([m4aBytes()], { type: 'audio/mp4' });
const WEBM = new Blob([webmBytes()], { type: 'audio/webm;codecs=opus' });

const ready = () => ({
  url: IMAGEKIT_URL,
  metrics: buildVoiceCompressionMetrics({
    originalBytes: 16,
    finalBytes: 2,
    sourceMimeType: 'audio/mp4',
    targetMimeType: 'audio/mp4',
  }),
});

test('the M4A container check accepts a real ftyp header and rejects WebM', () => {
  assert.equal(hasM4aContainer(m4aBytes()), true);
  assert.equal(hasM4aContainer(webmBytes()), false);
  assert.equal(hasM4aContainer(new Uint8Array(4)), false);
  const bogus = new Uint8Array(16);
  bogus.set([0, 0, 0, 16], 0);
  bogus.set([0x66, 0x74, 0x79, 0x70], 4);
  bogus.set([0x61, 0x76, 0x63, 0x31], 8); // 'avc1'
  assert.equal(hasM4aContainer(bogus), false);
});

test('a WebM recording whose server conversion fails is never uploaded raw', async () => {
  let transcodeCalls = 0;
  let uploadCalls = 0;

  const outcome = await prepareVoiceMessageSource(WEBM, 'msg-1', {
    transcode: async () => { transcodeCalls += 1; return null; },
    uploadM4a: async () => { uploadCalls += 1; return ready(); },
    wait: async () => undefined,
  });

  assert.deepEqual(outcome, { ok: false, reason: 'transcode-failed' });
  assert.equal(transcodeCalls, VOICE_TRANSCODE_ATTEMPTS);
  assert.equal(uploadCalls, 0);
});

test('an iPhone M4A recording falls back to a direct ImageKit upload when the server fails', async () => {
  let uploadCalls = 0;
  let uploadedType = '';

  const outcome = await prepareVoiceMessageSource(M4A, 'msg-2', {
    transcode: async () => null,
    uploadM4a: async blob => { uploadCalls += 1; uploadedType = blob.type; return ready(); },
    wait: async () => undefined,
  });

  assert.equal(uploadCalls, 1);
  assert.equal(uploadedType, 'audio/mp4');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.url, IMAGEKIT_URL);
  assert.equal(outcome.ok === true && outcome.source, 'direct-m4a');
});

test('an M4A-typed blob with a broken container is not uploaded', async () => {
  const broken = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], { type: 'audio/mp4' });
  let uploadCalls = 0;

  const outcome = await prepareVoiceMessageSource(broken, 'msg-3', {
    transcode: async () => null,
    uploadM4a: async () => { uploadCalls += 1; return ready(); },
    wait: async () => undefined,
  });

  assert.equal(uploadCalls, 0);
  assert.deepEqual(outcome, { ok: false, reason: 'transcode-failed' });
});

test('a conversion that succeeds on retry wins and no direct upload happens', async () => {
  let attempts = 0;
  let uploadCalls = 0;

  const outcome = await prepareVoiceMessageSource(M4A, 'msg-4', {
    transcode: async () => {
      attempts += 1;
      return attempts === 1 ? null : ready();
    },
    uploadM4a: async () => { uploadCalls += 1; return ready(); },
    wait: async () => undefined,
  });

  assert.equal(attempts, 2);
  assert.equal(uploadCalls, 0);
  assert.equal(outcome.ok === true && outcome.source, 'server');
});

test('an empty recording is rejected before any attempt', async () => {
  let attempts = 0;

  const outcome = await prepareVoiceMessageSource(new Blob([]), 'msg-5', {
    transcode: async () => { attempts += 1; return null; },
    wait: async () => undefined,
  });

  assert.deepEqual(outcome, { ok: false, reason: 'empty-recording' });
  assert.equal(attempts, 0);
});

test('an untrusted URL from the server is rejected, never handed to the player', async () => {
  let uploadCalls = 0;

  const outcome = await prepareVoiceMessageSource(M4A, 'msg-8', {
    transcode: async () => ({
      url: 'https://evil.example/aani/user-1/messages/msg-8.m4a',
      metrics: ready().metrics,
    }),
    uploadM4a: async () => { uploadCalls += 1; return ready(); },
    wait: async () => undefined,
  });

  // يُرفض رابط الخادم غير الموثوق ويُكمَل بالمسار البديل المتحقق منه
  assert.equal(uploadCalls, 1);
  assert.equal(outcome.ok === true && outcome.source, 'direct-m4a');
});

test('a fallback upload whose URL is not trusted is rejected instead of saved', async () => {
  const outcome = await prepareVoiceMessageSource(M4A, 'msg-6', {
    transcode: async () => null,
    uploadM4a: async () => ({
      url: 'https://evil.example/aani/user-1/messages/msg-6.m4a',
      metrics: ready().metrics,
    }),
    wait: async () => undefined,
  });

  assert.deepEqual(outcome, { ok: false, reason: 'transcode-failed' });
});

test('a fallback upload that throws leaves the recording for retry', async () => {
  const outcome = await prepareVoiceMessageSource(M4A, 'msg-7', {
    transcode: async () => null,
    uploadM4a: async () => { throw new Error('ImageKit HTTP 403'); },
    wait: async () => undefined,
  });

  assert.deepEqual(outcome, { ok: false, reason: 'transcode-failed' });
});

test('the send path keeps the guarded fallback and never sends an unverified recording', () => {
  const module = read('./lib/messagesVoiceServer.ts');
  const page = read('./pages/MessagesPage.tsx');

  // لا تحويل على الجهاز: preset الصوت المحوّل محلياً لم يعد مستخدماً
  assert.equal(page.includes("preset: 'voiceMessage'"), false);
  assert.equal(page.includes('prepareVoiceMessageSource('), true);
  // البديل المباشر مقيّد بفحص الحاوية
  assert.equal(module.includes('isPlayableM4aRecording'), true);
  assert.equal(module.includes('hasM4aContainer'), true);
  assert.equal(module.includes('uploadMedia({ file, path })'), true);
});
