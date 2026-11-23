import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  claimVoicePlayback,
  failVoicePlayback,
  needsVoicePlaybackSourceRefresh,
  resolveVoicePlaybackSource,
  stopActiveVoicePlayback,
  toggleVoicePlayback,
  type VoiceAudioLike,
} from './messagesVoicePlayback';
import { isTrustedImageKitVoiceUrl, isTrustedVoiceUrl } from './messagesVoice';
import { storageBucket, supabaseUrl } from './supabase';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

function createAudio(options: { paused?: boolean; fail?: boolean } = {}) {
  const calls = { play: 0, pause: 0, load: 0 };
  const audio: VoiceAudioLike = {
    paused: options.paused ?? true,
    currentTime: options.paused ? 0 : 7.5,
    async play() {
      calls.play += 1;
      if (options.fail) throw new Error('NotAllowedError');
      audio.paused = false;
    },
    pause() {
      calls.pause += 1;
      audio.paused = true;
    },
    load() {
      calls.load += 1;
    },
  };
  return { audio, calls };
}

test('a successful play reports loading then playing', async () => {
  const { audio, calls } = createAudio();
  const loading: boolean[] = [];
  const playing: boolean[] = [];

  const result = await toggleVoicePlayback(audio, {
    onLoading: value => { loading.push(value); },
    onPlaying: value => { playing.push(value); },
  });

  assert.equal(result, 'playing');
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(playing, [true]);
  assert.equal(calls.play, 1);
});

test('a rejected play clears the spinner and reports an error', async () => {
  const { audio } = createAudio({ fail: true });
  const loading: boolean[] = [];
  const playing: boolean[] = [];
  let errors = 0;

  const result = await toggleVoicePlayback(audio, {
    onLoading: value => { loading.push(value); },
    onPlaying: value => { playing.push(value); },
    onError: () => { errors += 1; },
  });

  assert.equal(result, 'error');
  // لا Spinner عالق: التحميل أُنهي، ولم تُعلن حالة تشغيل
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(playing, [false]);
  assert.equal(errors, 1);
});

test('a media-file load error clears waiting and playing state', () => {
  const loading: boolean[] = [];
  const playing: boolean[] = [];
  const mediaError = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
  let receivedError: unknown;

  failVoicePlayback({
    onLoading: value => { loading.push(value); },
    onPlaying: value => { playing.push(value); },
    onError: error => { receivedError = error; },
  }, mediaError);

  assert.deepEqual(loading, [false]);
  assert.deepEqual(playing, [false]);
  assert.equal(receivedError, mediaError);
});

test('a missing or failed signed URL is not handed to the audio element', async () => {
  const trusted = (value: string) => isTrustedImageKitVoiceUrl(value);

  assert.equal(await resolveVoicePlaybackSource('https://ik.imagekit.io/anisocial/aani/u/messages/a.m4a', async () => null, trusted), null);
  assert.equal(await resolveVoicePlaybackSource('https://ik.imagekit.io/anisocial/aani/u/messages/a.m4a', async () => { throw new Error('403'); }, trusted), null);
  assert.equal(await resolveVoicePlaybackSource('https://ik.imagekit.io/anisocial/aani/u/messages/a.m4a', async () => '<html>forbidden</html>', trusted), null);
});

test('a valid signed M4A source is preserved for iOS-compatible audio playback', async () => {
  const stored = 'https://ik.imagekit.io/anisocial/aani/u/messages/voice-1.m4a';
  const signed = `${stored}?ik-t=1999999999&ik-s=validsignature`;
  let requested = '';

  const result = await resolveVoicePlaybackSource(stored, async raw => {
    requested = raw;
    return signed;
  }, isTrustedImageKitVoiceUrl);

  assert.equal(requested, stored);
  assert.equal(result, signed);
  assert.match(result ?? '', /\.m4a\?ik-t=/);
});

test('a signed Supabase object URL resolves as a valid voice playback source', async () => {
  const stored = `${supabaseUrl}/storage/v1/object/public/${storageBucket}/user/messages/voice.m4a`;
  const signed = `${supabaseUrl}/storage/v1/object/sign/${storageBucket}/user/messages/voice.m4a?token=signed-token`;

  assert.equal(await resolveVoicePlaybackSource(stored, async () => signed, isTrustedVoiceUrl), signed);
});

test('a pre-refreshed source lets the next error retry skip resolution and use one tap', () => {
  const refreshedSignedUrl = `${supabaseUrl}/storage/v1/object/sign/${storageBucket}/user/messages/voice.m4a?token=signed-token`;

  assert.equal(needsVoicePlaybackSourceRefresh(true, refreshedSignedUrl, true, true), false);
  assert.equal(needsVoicePlaybackSourceRefresh(true, refreshedSignedUrl, true, false), true);
  assert.equal(needsVoicePlaybackSourceRefresh(false, refreshedSignedUrl, true, false), false);
});

test('a hanging URL resolver times out instead of leaving source loading active', async () => {
  const result = await resolveVoicePlaybackSource(
    'https://ik.imagekit.io/anisocial/aani/u/messages/voice-1.m4a',
    () => new Promise<string | null>(() => undefined),
    isTrustedImageKitVoiceUrl,
    2,
  );

  assert.equal(result, null);
});

test('pressing play while playing pauses instead of starting twice', async () => {
  const { audio, calls } = createAudio({ paused: false });
  const result = await toggleVoicePlayback(audio, {});

  assert.equal(result, 'paused');
  assert.equal(calls.pause, 1);
  assert.equal(calls.play, 0);
});

test('retrying after an error reloads the source from the start', async () => {
  const { audio, calls } = createAudio();
  audio.currentTime = 4.2;

  const result = await toggleVoicePlayback(audio, {}, { reloadOnError: true });

  assert.equal(result, 'playing');
  assert.equal(calls.load, 1);
  assert.equal(audio.currentTime, 0);
});

test('starting another message stops the previous player, and an old release cannot stop the new one', async () => {
  stopActiveVoicePlayback();
  let firstStopped = 0;
  let secondStopped = 0;

  const releaseFirst = claimVoicePlayback(() => { firstStopped += 1; });
  const releaseSecond = claimVoicePlayback(() => { secondStopped += 1; });

  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 0);

  // تحرير الحجز القديم لا يوقف المشغّل الأحدث
  releaseFirst();
  stopActiveVoicePlayback();
  assert.equal(secondStopped, 1);
  assert.equal(firstStopped, 1);
  releaseSecond();
});

test('a paused player releases its old claim so it can safely claim again', () => {
  stopActiveVoicePlayback();
  let firstStopped = 0;
  let secondStopped = 0;

  const releaseFirstPlay = claimVoicePlayback(() => { firstStopped += 1; });
  releaseFirstPlay(); // نفس ما يحصل عند pause/end/error في عنصر الصوت
  const releaseFirstReplay = claimVoicePlayback(() => { firstStopped += 1; });
  const releaseSecond = claimVoicePlayback(() => { secondStopped += 1; });

  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 0);
  stopActiveVoicePlayback();
  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 1);
  releaseFirstPlay(); // التحرير القديم لا يمس الحجز الثاني
  releaseFirstReplay();
  releaseSecond();
});

test('the audio element is inline, preloads metadata, and keeps a retryable error state', () => {
  const page = read('./pages/MessagesPage.tsx');
  const playerStart = page.indexOf('function VoiceMessagePlayer');
  const playerEnd = page.indexOf('\n}\n', playerStart);
  const player = page.slice(playerStart, playerEnd);

  assert.equal(page.includes('playsInline'), true);
  assert.equal(page.includes('preload="metadata"'), true);
  assert.equal(page.includes('resolveVoicePlaybackSource(url, resolveMediaUrl, isTrustedVoiceUrl)'), true);
  assert.equal(player.includes('src={playbackUrl ?? undefined}'), true);
  assert.equal(player.includes('src={url}'), false);
  // إعادة المحاولة بعد الفشل تُعيد التحميل من البداية
  assert.equal(page.includes('reloadOnError: hasError'), true);
  // لا مؤشر عالق: مسار الفشل ينهي التحميل
  assert.equal(page.includes('onError: handlePlaybackError'), true);
  assert.equal(page.includes('refreshSourceForRetry();'), true);
  assert.equal(page.includes('needsVoicePlaybackSourceRefresh(audio.paused, playbackUrl, hasError, retrySourceReadyRef.current)'), true);
  assert.equal(page.includes('onPlay={() => { setHasError(false); retrySourceReadyRef.current = false; }}'), true);
  assert.equal(page.includes('onPlaying={() => { clearLoadingTimeout(); setIsLoading(false); setIsPlaying(true); }}'), true);
  assert.equal(page.includes('onWaiting={() => { setIsLoading(true); startLoadingTimeout(); }}'), true);
  assert.equal(page.includes('if (loadingTimeoutRef.current !== null) return;'), true);
  assert.equal(page.includes('onCanPlay={() => { clearLoadingTimeout(); setIsLoading(false); }}'), true);
  assert.equal(page.includes('onError={event => {'), true);
  assert.equal(page.includes('failVoicePlayback({'), true);
  assert.equal(page.includes('onPause={() => { clearLoadingTimeout(); setIsPlaying(false); setIsLoading(false); releasePlaybackClaim(); }}'), true);
  assert.equal(page.includes('onEnded={() => { clearLoadingTimeout(); setIsPlaying(false); setIsLoading(false); setCurrentTimeMs(0); releasePlaybackClaim(); }}'), true);
});

test('playback rates are gone from the UI, the module, and the styles', () => {
  const page = read('./pages/MessagesPage.tsx');
  const lib = read('./lib/messagesVoice.ts');
  const css = read('./index.css');

  for (const source of [page, lib, css]) {
    assert.equal(source.includes('VOICE_PLAYBACK_RATES'), false);
    assert.equal(source.includes('messages-voice-rate'), false);
    assert.equal(source.includes('playbackRate'), false);
  }
  assert.equal(page.includes('1.5×'), false);
});

test('the voice bubble is compact, has no mic icon, and keeps RTL row alignment', () => {
  const page = read('./pages/MessagesPage.tsx');
  const css = read('./index.css');

  // لا أيقونة ميكروفون ولا حاوية لاعب زائدة داخل فقاعة الصوت
  assert.equal(page.includes('messages-voice-player'), false);
  assert.equal(css.includes('.messages-voice-player'), false);
  assert.equal(css.includes('.messages-voice-rate'), false);

  // فقاعة مدمجة بحد أقصى واضح
  assert.equal(css.includes('max-width: min(68%, 230px)'), true);
  // السطر الداخلي لا يتمدد بعرض الفقاعة
  assert.equal(/\.messages-voice-line\s*\{[^}]*width:\s*100%/.test(css), false);
  // محاذاة الصفوف الحالية: رسائلي يميناً (RTL flex-start) والواردة يساراً
  assert.equal(/\.messages-message-row\.is-mine\s*\{[^}]*justify-content:\s*flex-start/.test(css), true);
  assert.equal(/\.messages-message-row\.is-theirs\s*\{[^}]*justify-content:\s*flex-end/.test(css), true);
  // العناصر الزمنية تبقى LTR دون قلب محاذاة الفقاعة
  assert.equal(page.includes('className="messages-voice-duration" dir="ltr"'), true);
  assert.equal(page.includes('className={`messages-bubble messages-voice-bubble'), true);
});
