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
  if (!audio) return;
  audio.onplaying = null;
  audio.onended = null;
  audio.ontimeupdate = null;
  audio.onloadedmetadata = null;
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
    void el.play().then(reportPlaying).catch((error: unknown) => {
      console.log('Autoplay handled:', error);
      if (generation !== playGeneration) return;
      options.onError?.();
    });
  } else {
    void el.play().catch((error: unknown) => {
      console.log('Autoplay handled:', error);
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

  // Software clamp as a second safety net over the #t= fragment: jump back to
  // the start of the clip whenever playback passes its end (smooth loop).
  if (readTrim) {
    el.ontimeupdate = () => {
      const range = readTrim();
      if (!range) return;
      if (el.currentTime >= range.end - 0.04 || el.currentTime < range.start - 0.05) {
        try { el.currentTime = range.start; } catch { /* the browser may refuse seeking before readiness */ }
      }
    };
  }

  const initialTrim = readTrim?.() ?? null;
  try { el.currentTime = initialTrim ? Math.max(0, initialTrim.start) : 0; } catch { /* the browser may refuse seeking before readiness */ }
}

/** Instant stop and resource release: opening the sound library, closing screens, or removing the sound. */
export function stopInstant(): void {
  if (!audio) return;
  playGeneration += 1; // invalidate any pending .play() promise or callback
  clearHandlers();
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
  if (audio && !audio.paused) audio.pause();
}

/** Resume playback on the unified player from the current position. */
export function resumeInstant(): boolean {
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
    audioContext = new Context();
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
