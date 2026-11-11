/**
 * Global instant audio player (Single Audio Instance, Direct HTML5 Audio Mode).
 *
 * One HTMLAudioElement is reused for every sound preview in the app
 * (sound library, preview screen, sound page): switching sounds swaps `src`
 * on the same object instead of creating a new one, which aborts the pending
 * network request instantly (no stacked pending requests) and avoids memory
 * pressure / garbage collection churn.
 *
 * Configuration (Direct Mode: no network stall, no CORS lock):
 * - No crossOrigin at all: no CORS handshake, no resource blocking. The
 *   browser streams bytes directly over HTTP Range/206 without waiting.
 * - preload='metadata' only: reads the duration without heavy memory or
 *   bandwidth use. Playback starts the moment play() is called, in parallel
 *   with the download (no waiting on canplaythrough, no full fetch, no
 *   ArrayBuffer).
 * - playInstant must be called inside the direct event handler (no await
 *   before it): src + play() happen in the same millisecond to bypass the
 *   browser autoplay policy, and the play() promise is always caught so no
 *   uncaught audio promises ever reach the console.
 * - onPlaying fires as soon as the first audible sample is emitted
 *   (Spinner -> Pause transition).
 */

export type InstantTrimRange = { start: number; end: number };

export type InstantPlayOptions = {
  /** Sound trim bounds in seconds; the loop is clamped inside them as a safety net over the #t= fragment. */
  trim?: InstantTrimRange | null;
  /** Loop playback (default true). */
  loop?: boolean;
  /** Re-read the draft on every timeupdate tick (live updates while dragging trim handles). */
  getTrim?: () => InstantTrimRange | null;
  /** Fired on the first audible sample: switch the button from Spinner to Pause. */
  onPlaying?: () => void;
  /** Fired when the clip ends naturally. */
  onEnded?: () => void;
  /** Fired when playback fails (missing URL or browser rejection). */
  onError?: () => void;
  /** Fired once the full duration is known (iOS blocks metadata reads before a user gesture, so it is read from the actual playback element). */
  onLoadedMetadata?: (duration: number) => void;
};

let audio: HTMLAudioElement | null = null;
let currentSrc = '';
let playingReported = false;
// Current request generation: invalidates any pending .play() promise or
// callback from a previous attempt when the user switches sounds quickly.
let playGeneration = 0;
// High-frequency trim watch: a requestAnimationFrame loop that clamps the
// playhead inside the trim range every frame (~16ms) instead of relying only
// on timeupdate (~4Hz, up to ~250ms of overshoot). Sample-accurate-perceptual
// looping with zero memory cost: no AudioBuffer decoding of full-length songs.
let trimWatchFrame: number | null = null;
let trimWatchEl: HTMLAudioElement | null = null;

function stopTrimWatch(): void {
  if (typeof window !== 'undefined' && trimWatchFrame !== null) {
    window.cancelAnimationFrame(trimWatchFrame);
  }
  trimWatchFrame = null;
  trimWatchEl = null;
}

function startTrimWatch(el: HTMLAudioElement, read: () => InstantTrimRange | null): void {
  stopTrimWatch();
  trimWatchEl = el;
  const tick = () => {
    trimWatchFrame = null;
    if (trimWatchEl !== el) return;
    const range = read();
    if (!range) return;
    const t = el.currentTime;
    if (t >= range.end - 0.02 || t < range.start - 0.03) {
      try { el.currentTime = range.start; } catch { /* the browser may refuse seeking before readiness */ }
    }
    // Keep ticking only while actually playing; the play event restarts the loop.
    if (!el.paused) {
      trimWatchFrame = window.requestAnimationFrame(tick);
    }
  };
  trimWatchFrame = window.requestAnimationFrame(tick);
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!audio) {
    audio = new Audio();
    // metadata only: reads the duration without heavy memory/bandwidth use,
    // while playback streams immediately over HTTP Range on .play().
    audio.preload = 'metadata';
    audio.loop = true;
  }
  return audio;
}

function clearHandlers(): void {
  stopTrimWatch();
  if (!audio) return;
  audio.onplaying = null;
  audio.onended = null;
  audio.ontimeupdate = null;
  audio.onloadedmetadata = null;
  audio.onplay = null;
  audio.onpause = null;
  playingReported = false;
}

/**
 * Instant playback on the unified player. Call it directly inside the event
 * handler (user tap) with zero waiting: pauses whatever was playing, swaps
 * src when needed, then calls .play() synchronously in the same tick.
 */
export function playInstant(url: string, options: InstantPlayOptions = {}): void {
  const el = ensureAudio();
  if (!el || !url) return;
  const generation = ++playGeneration;
  // Cancel pending work: stop immediately and drop the previous clip's handlers.
  if (!el.paused) el.pause();
  clearHandlers();
  stopClipPlayback(); // any RAM clip node from the library tier is released too

  // Swap the source on the same object (never new Audio): the previous
  // network request is aborted automatically. No crossOrigin at all, so
  // there is no CORS handshake and streaming starts instantly.
  if (currentSrc !== url) {
    el.removeAttribute('src');
    el.removeAttribute('crossorigin');
    el.src = url;
    currentSrc = url;
  }
  el.loop = options.loop !== false;

  const fixedTrim = options.trim && options.trim.end > options.trim.start ? options.trim : null;
  const readTrim = options.getTrim
    ? () => {
        const range = options.getTrim?.();
        return range && range.end > range.start ? range : null;
      }
    : fixedTrim
      ? () => fixedTrim
      : null;

  if (options.onPlaying) {
    // Instant response: the first audible sample (the playing event or the
    // resolved .play() promise) flips the button immediately.
    const reportPlaying = () => {
      if (playingReported || generation !== playGeneration) return;
      playingReported = true;
      options.onPlaying?.();
    };
    el.onplaying = reportPlaying;
    // The play() promise is always caught: an autoplay rejection is logged,
    // never thrown, so the app can never freeze on it.
    void el.play().then(reportPlaying).catch((err: unknown) => {
      console.log('Autoplay handled cleanly:', err);
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  } else {
    void el.play().catch((err: unknown) => {
      console.log('Autoplay handled cleanly:', err);
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  }

  if (options.onEnded) {
    el.onended = () => {
      if (generation !== playGeneration) return;
      options.onEnded?.();
    };
  }

  if (options.onLoadedMetadata) {
    el.onloadedmetadata = () => {
      if (generation !== playGeneration) return;
      const duration = el.duration;
      if (Number.isFinite(duration) && duration > 0) options.onLoadedMetadata?.(duration);
    };
  }

  // Loop engine, two layers over the #t= fragment:
  // 1. rAF trim watch: clamps the playhead every frame (~16ms) while playing,
  //    restarted by the play event and halted by the pause event.
  // 2. timeupdate clamp: fallback for browsers that throttle rAF in background.
  if (readTrim) {
    el.ontimeupdate = () => {
      const range = readTrim();
      if (!range) return;
      if (el.currentTime >= range.end - 0.04 || el.currentTime < range.start - 0.05) {
        try { el.currentTime = range.start; } catch { /* the browser may refuse seeking before readiness */ }
      }
    };
    el.onplay = () => startTrimWatch(el, readTrim);
    el.onpause = () => stopTrimWatch();
    startTrimWatch(el, readTrim); // .play() is called right below
  }

  const initialTrim = readTrim?.() ?? null;
  try { el.currentTime = initialTrim ? Math.max(0, initialTrim.start) : 0; } catch { /* the browser may refuse seeking before readiness */ }
}

/** Instant stop and resource release: opening the sound library, closing screens, or removing the sound. */
export function stopInstant(): void {
  stopClipPlayback(); // release any RAM clip node and its cached-state remnants
  playGeneration += 1; // invalidate any pending .play() promise or callback
  clearHandlers();
  if (!audio) return;
  if (!audio.paused) audio.pause();
  try { audio.currentTime = 0; } catch { /* the browser may refuse seeking before readiness */ }
}

/**
 * Resume the unified player only when it is already playing this exact URL
 * (no re-download from scratch): playback continues from the current position
 * instantly. Used by the preview screen so an auto-suggested sound that
 * started on image selection is not interrupted by a restart.
 * Returns true when it handled the resume itself; false when a fresh
 * playInstant call is required.
 */
export function resumeInstantIfSame(url: string): boolean {
  if (!audio || !url || currentSrc !== url) return false;
  if (!audio.paused) return true; // already playing this sound, nothing to do
  const generation = ++playGeneration;
  void audio.play().catch(() => {
    if (generation !== playGeneration) return;
    /* a failed resume is silently ignored; the screen can call playInstant later */
  });
  return true;
}

/**
 * Instant seek on the unified player (live sync while dragging the trim start
 * handle): moves the playhead to the requested time with no reload and no
 * interruption. Returns true when applied.
 */
export function seekInstant(time: number): boolean {
  if (!audio) return false;
  const target = Math.max(0, Number.isFinite(time) ? time : 0);
  try {
    audio.currentTime = target;
    return true;
  } catch {
    /* the browser may refuse seeking before readiness */
    return false;
  }
}

/** Pause the unified player without dropping the position; resume with resumeInstant. */
export function pauseInstant(): void {
  if (activeClipSource && audioContext && activeClipLoopLength > 0) {
    // RAM clip tier: remember the exact position inside the loop so
    // resumeInstant continues from the same sample (no restart, no gap).
    const elapsed = Math.max(0, audioContext.currentTime - activeClipStartedAt);
    activeClipPausedOffset = activeClipLoopStart + (elapsed % activeClipLoopLength);
    try {
      activeClipSource.onended = null;
      activeClipSource.stop();
    } catch { /* already stopped */ }
    try { activeClipSource.disconnect(); } catch { /* ignore */ }
    activeClipSource = null;
    return;
  }
  if (audio && !audio.paused) audio.pause();
}

/** Resume playback on the unified player from the current position. */
export function resumeInstant(): boolean {
  if (activeClipBuffer && audioContext && !activeClipSource && activeClipLoopLength > 0) {
    // RAM clip tier: rebuild the source node and continue from the paused sample.
    const generation = ++playGeneration;
    const source = audioContext.createBufferSource();
    source.buffer = activeClipBuffer;
    source.loop = true;
    source.loopStart = activeClipLoopStart;
    source.loopEnd = activeClipLoopStart + activeClipLoopLength;
    source.connect(audioContext.destination);
    const offset = Math.min(Math.max(activeClipPausedOffset, activeClipLoopStart), activeClipLoopStart + activeClipLoopLength - 0.01);
    activeClipSource = source;
    activeClipStartedAt = audioContext.currentTime - (offset - activeClipLoopStart);
    try {
      source.start(0, offset);
      return true;
    } catch (err) {
      console.log('Autoplay handled cleanly:', err);
      void generation;
      return false;
    }
  }
  if (!audio) return false;
  if (!audio.paused) return true;
  const generation = ++playGeneration;
  void audio.play().catch(() => {
    if (generation !== playGeneration) return;
    /* a failed resume is silently ignored */
  });
  return true;
}

/**
 * Light cache warming (32 KB only) of the first chunk of a sound via an HTTP
 * Range request (206 Partial Content): opens the connection so the next tap
 * starts instantly. No ArrayBuffer and no full download: one small request
 * that aborts itself after 5 seconds.
 */
export function warmAudioCache(url: string, bytes = 32768): void {
  if (!url || typeof window === 'undefined') return;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    void fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: controller.signal })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timer));
  } catch {
    /* warming is optional; ignore any failure silently */
  }
}

let audioContext: AudioContext | null = null;

/**
 * Silent Web Audio warm-up: creates an AudioContext and plays a very short
 * silent buffer (one empty sample) so the browser treats the session as
 * user-gesture unlocked, allowing instant auto-play without blocking.
 * Call it inside a user gesture (publish flow opening / first tap); later
 * calls just resume a suspended context.
 */
export function warmAudioContext(): void {
  if (typeof window === 'undefined') return;
  if (audioContext) {
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined);
    return;
  }
  try {
    const Context = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audioContext = new Context({ latencyHint: 'interactive' });
    // Empty buffer (one silent sample): a playback signal with no audible sound.
    const silentBuffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    const source = audioContext.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(audioContext.destination);
    source.start(0);
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined);
  } catch {
    /* AudioContext unsupported in this context; normal playback still works */
  }
}

/**
 * Canonical name for the synchronous unlock routine: call it inside the first
 * user gesture (media-picker tap, publish-flow open, first pointerdown) to
 * resume the AudioContext, emit the silent buffer, and arm the global audio
 * element — defeating the autoplay block on Safari/iOS.
 */
export const installAudioUnlock = warmAudioContext;

// ===== Tier 1: RAM preview-clip cache (short decoded heads, never full songs)
// =====
// The sound-library list previews play through an AudioBufferSourceNode
// straight from RAM in under 10ms (sample-accurate looping, zero network
// wait). Only a bounded head slice of each sound is fetched (HTTP 206
// Range) and decoded; full-length playback everywhere else in the app keeps
// using native streaming so RAM stays bounded.

const PREVIEW_CLIP_BYTES = 786432; // ~768 KB head request per clip
const PREVIEW_CLIP_SECONDS = 15;   // head seconds kept in RAM per clip
const MAX_CACHED_CLIPS = 6;        // oldest clips are evicted beyond this

const previewClipCache = new Map<string, AudioBuffer>();
const previewClipPending = new Map<string, Promise<AudioBuffer | null>>();

function ensureMediaContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  try {
    const Context = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    audioContext = new Context({ latencyHint: 'interactive' });
    return audioContext;
  } catch {
    return null;
  }
}

/** Fetch + decode a short head clip into RAM (idempotent per URL). Resolves null on failure. */
export function warmPreviewClip(url: string): Promise<AudioBuffer | null> {
  if (!url || typeof window === 'undefined') return Promise.resolve(null);
  const cached = previewClipCache.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = previewClipPending.get(url);
  if (pending) return pending;
  const job = (async (): Promise<AudioBuffer | null> => {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${PREVIEW_CLIP_BYTES - 1}` },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      const raw = await response.arrayBuffer();
      const context = ensureMediaContext();
      if (!context) return null;
      const decoded = await context.decodeAudioData(raw);
      // Bound RAM: keep only the head seconds of the decoded buffer.
      let clip = decoded;
      const headLength = Math.min(decoded.length, Math.ceil(PREVIEW_CLIP_SECONDS * decoded.sampleRate));
      if (headLength < decoded.length) {
        clip = context.createBuffer(decoded.numberOfChannels, headLength, decoded.sampleRate);
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          clip.copyToChannel(decoded.getChannelData(channel).subarray(0, headLength), channel);
        }
      }
      previewClipCache.set(url, clip);
      if (previewClipCache.size > MAX_CACHED_CLIPS) {
        const oldest = previewClipCache.keys().next().value;
        if (oldest !== undefined) previewClipCache.delete(oldest);
      }
      return clip;
    } catch {
      return null;
    } finally {
      previewClipPending.delete(url);
    }
  })();
  previewClipPending.set(url, job);
  return job;
}

// Active RAM clip playback state (module singleton, outside React).
let activeClipSource: AudioBufferSourceNode | null = null;
let activeClipBuffer: AudioBuffer | null = null;
let activeClipLoopStart = 0;
let activeClipLoopLength = 0;
let activeClipPausedOffset = 0;
let activeClipStartedAt = 0;

function stopClipPlayback(): void {
  if (activeClipSource) {
    try {
      activeClipSource.onended = null;
      activeClipSource.stop();
    } catch { /* already stopped */ }
    try { activeClipSource.disconnect(); } catch { /* ignore */ }
  }
  activeClipSource = null;
  activeClipBuffer = null;
  activeClipLoopStart = 0;
  activeClipLoopLength = 0;
  activeClipPausedOffset = 0;
}

export type PreviewClipOptions = {
  onPlaying?: () => void;
  onEnded?: () => void;
  onError?: () => void;
};

/**
 * Sound-library list preview, three tiers:
 * 1. RAM hit -> AudioBufferSourceNode from RAM in <10ms (sample-accurate
 *    looping via loopStart/loopEnd, no rAF, no timeupdate, no gaps).
 * 2. Miss -> native streaming starts instantly while the clip is decoded in
 *    the background for the next tap.
 * 3. No AudioContext -> plain native streaming.
 */
export function playSoundPreview(url: string, options: PreviewClipOptions = {}): void {
  const cached = previewClipCache.get(url);
  const context = ensureMediaContext();
  if (!cached || !context) {
    // Tier 2/3: instant native streaming; warm the RAM clip for next time.
    void warmPreviewClip(url);
    playInstant(url, {
      loop: true,
      onPlaying: options.onPlaying,
      onEnded: options.onEnded,
      onError: options.onError,
    });
    return;
  }
  // Tier 1: RAM playback. stopInstant() first so the media element and any
  // previous node are fully released, then this node owns the channel.
  stopInstant();
  const generation = ++playGeneration;
  const source = context.createBufferSource();
  source.buffer = cached;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.min(cached.duration, PREVIEW_CLIP_SECONDS);
  source.connect(context.destination);
  activeClipSource = source;
  activeClipBuffer = cached;
  activeClipLoopStart = 0;
  activeClipLoopLength = source.loopEnd - source.loopStart;
  activeClipPausedOffset = 0;
  activeClipStartedAt = context.currentTime;
  source.onended = () => {
    if (generation !== playGeneration) return;
    options.onEnded?.();
  };
  try {
    source.start(0, 0);
    // RAM playback starts on the same tick: report playing immediately.
    if (generation === playGeneration) options.onPlaying?.();
  } catch (err) {
    console.log('Autoplay handled cleanly:', err);
    if (generation === playGeneration) options.onError?.();
  }
}
