import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildChatVideoMetrics } from './chatVideo';
import {
  claimChatVideoPlayback,
  startChatVideoOnUserTap,
  stopActiveChatVideoPlayback,
  toggleChatVideoPlayback,
  type ChatVideoSourceLike,
} from './chatVideoPlayback';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

function createVideo(options: { paused?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  const video: ChatVideoSourceLike & { src?: string } = {
    paused: options.paused ?? true,
    muted: false,
    volume: 1,
    currentTime: 0,
    duration: 10,
    src: '',
    async play() {
      calls.push('play');
      if (options.fail) throw new Error('NotAllowedError');
      video.paused = false;
    },
    pause() {
      calls.push('pause');
      video.paused = true;
    },
  };
  return { video, calls };
}

test('the first tap calls play() synchronously, inside the tap handler itself', async () => {
  const { video, calls } = createVideo();

  const pending = startChatVideoOnUserTap(video, 'https://ik.imagekit.io/anisocial/aani/u1/messages/v.mp4', {});

  // قبل أي await: المصدر أُسند وplay() نُفّذ داخل مهمة المستخدم نفسها
  assert.equal(video.src, 'https://ik.imagekit.io/anisocial/aani/u1/messages/v.mp4');
  assert.deepEqual(calls, ['play']);
  assert.equal(await pending, 'playing');
});

test('nothing starts before the tap: the player renders an element without a source', () => {
  const player = read('./components/ChatVideoMessage.tsx');

  // عنصر <video> دائم بلا src وبلا autoPlay: لا تنزيل قبل الضغط
  assert.equal(player.includes('src={src}'), false);
  assert.equal(/autoPlay/.test(player), false);
  assert.equal(player.includes('playsInline'), true);
  assert.equal(player.includes('preload="metadata"'), true);
  // لا تشغيل من useEffect: play() يُستدعى من معالج الضغط فقط
  assert.equal(/useEffect\([^)]*startChatVideoOnUserTap/.test(player), false);
  assert.equal(player.includes('startChatVideoOnUserTap('), true);
  assert.equal(player.includes('onClick={onPressPlay}'), true);
});

test('a rejected play() ends loading and leaves a retry instead of a stuck spinner', async () => {
  const { video } = createVideo({ fail: true });
  const loading: boolean[] = [];
  let errors = 0;

  const result = await toggleChatVideoPlayback(video, {
    onLoading: value => loading.push(value),
    onError: () => { errors += 1; },
  });

  assert.equal(result, 'error');
  assert.deepEqual(loading, [true, false]);
  assert.equal(errors, 1);
});

test('starting a second video stops the first, and an old release cannot stop the new one', () => {
  stopActiveChatVideoPlayback();
  let firstStopped = 0;
  let secondStopped = 0;

  const releaseFirst = claimChatVideoPlayback(() => { firstStopped += 1; });
  const releaseSecond = claimChatVideoPlayback(() => { secondStopped += 1; });

  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 0);

  releaseFirst();
  stopActiveChatVideoPlayback();
  assert.equal(secondStopped, 1);
  assert.equal(firstStopped, 1);
  releaseSecond();
});

test('FPS stays unavailable instead of being recorded as a zero measurement', () => {
  const metrics = buildChatVideoMetrics({ originalBytes: 1000, finalBytes: 500, durationSeconds: 12 });
  assert.equal('fps' in metrics, false);

  const measured = buildChatVideoMetrics({ originalBytes: 1000, finalBytes: 500, fps: 29.97 });
  assert.equal(measured.fps, 29.97);

  // القيمة صفر لا تُسجل كقياس
  const zero = buildChatVideoMetrics({ originalBytes: 1000, finalBytes: 500, fps: 0 });
  assert.equal('fps' in zero, false);
});
