/**
 * Aani Media Engine — unified audio/video facade (Clean Slate Migration
 * compatibility layer).
 *
 * The engine is a thin, fully-typed facade over the battle-tested
 * `instantAudio` singleton (single global <audio> + RAM preview-clip cache +
 * AudioContext unlock). Keeping the singleton as the core IS the
 * compatibility layer: every existing caller (SoundPickerSheet, StoryCreator,
 * ImagePreviewModal, StoriesBar, Shell) keeps its exact API while new
 * components adopt this facade. React re-renders never touch the engine —
 * all state lives in module refs; UI state flows through SoundLibraryStore.
 */
import {
  disposePreviewClips,
  hasPreviewClip,
  installAudioUnlock,
  playSoundPreview,
  pauseInstant,
  playInstant,
  resumeInstant,
  stopInstant,
} from '@/lib/instantAudio';
import { getSoundLibraryState, setSoundLibraryState } from './SoundLibraryStore';

export type EngineSoundRef = { url: string; id?: string; fallbackUrl?: string };
export type EnginePreviewCallbacks = {
  onPlaying?: () => void;
  onBlocked?: () => void;
  onError?: (error?: unknown) => void;
};

let unlockInstalled = false;
let resumeAfterVisible = false;
let engineActive = false;
let activeSoundId: string | null = null;
let visibilityResumeGeneration = 0;

/** Synchronous unlock — safe to call from any gesture handler, repeatedly. */
export function unlock(): void {
  installAudioUnlock();
}

/**
 * Installs the global gesture pipeline ONCE:
 * - Capture-phase pointerdown/touchend/click on the document root: the
 *   earliest possible moment of any user gesture. It synchronously resumes a
 *   suspended AudioContext (ctx.state check + resume) and emits the silent
 *   buffer, defeating the autoplay block on Safari/iOS for the entire app —
 *   including media-picker inputs and the publish flow.
 * - visibilitychange: auto-pauses the active sound while the tab is hidden
 *   and resumes it on return; if the browser refuses the resume, the sound
 *   surfaces the "اضغط للتشغيل" tap-to-play fallback instead of hanging.
 */
export function installGlobalUnlockListener(): void {
  if (unlockInstalled || typeof document === 'undefined') return;
  unlockInstalled = true;
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('touchend', unlock, { capture: true });
  document.addEventListener('click', unlock, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!engineActive) return;
      resumeAfterVisible = true;
      pauseInstant();
    } else if (resumeAfterVisible) {
      resumeAfterVisible = false;
      const generation = ++visibilityResumeGeneration;
      const soundId = getSoundLibraryState().playingId || activeSoundId;
      const markResumeBlocked = () => {
        if (generation !== visibilityResumeGeneration) return;
        engineActive = false;
        activeSoundId = null;
        setSoundLibraryState({ playingId: null, loadingId: null, blockedId: soundId });
      };
      void resumeInstant().then(resumed => {
        if (generation === visibilityResumeGeneration && !resumed) markResumeBlocked();
      }).catch(markResumeBlocked);
    }
  });
}

/**
 * Instant preview in real seconds. Always starts through the shared native
 * HTMLAudioElement immediately; optional trim bounds use the rAF trim watch.
 */
export function preview(
  sound: EngineSoundRef,
  startSec = 0,
  endSec?: number,
  callbacks: EnginePreviewCallbacks = {},
): void {
  console.log('[AudioEngine] Play requested for:', sound.id || sound.url);
  if (!sound.url) {
    console.log('[AudioEngine] Play status:', 'error');
    callbacks.onError?.(new Error('Missing audio URL'));
    return;
  }

  unlock();
  visibilityResumeGeneration += 1;
  engineActive = true;
  activeSoundId = sound.id || null;
  setSoundLibraryState({ blockedId: null });
  const hasTrim = Number.isFinite(startSec)
    && typeof endSec === 'number'
    && Number.isFinite(endSec)
    && endSec > startSec;
  let failureReported = false;
  const isBlockedError = (error?: unknown) => Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'NotAllowedError',
  );
  const reportFailure = (error?: unknown) => {
    if (failureReported) return;
    failureReported = true;
    engineActive = false;
    const isBlocked = isBlockedError(error);
    console.log('[AudioEngine] Play status:', isBlocked ? 'blocked' : 'error');
    if (isBlocked) callbacks.onBlocked?.();
    else callbacks.onError?.(error);
  };
  const onPlaying = () => {
    engineActive = true;
    console.log('[AudioEngine] Play status:', 'success');
    callbacks.onPlaying?.();
  };
  let startDirect: (url: string, allowFallback: boolean) => void;
  const handlePlaybackError = (error?: unknown) => {
    if (sound.fallbackUrl && sound.fallbackUrl !== sound.url && !isBlockedError(error)) {
      console.log('[AudioEngine] Preview source failed; trying direct fallback.');
      startDirect(sound.fallbackUrl, false);
      return;
    }
    reportFailure(error);
  };
  startDirect = (url: string, allowFallback: boolean) => {
    // Start native HTMLAudio streaming in this stack. Never wait for a Range
    // fetch or decodeAudioData; direct media URLs do not use CORS mode.
    playInstant(url, {
      loop: true,
      ...(hasTrim ? { trim: { start: startSec, end: endSec as number } } : {}),
      onPlaying,
      onError: error => {
        if (allowFallback && sound.fallbackUrl && sound.fallbackUrl !== url && !isBlockedError(error)) {
          console.log('[AudioEngine] Preview source failed; trying direct fallback.');
          startDirect(sound.fallbackUrl, false);
          return;
        }
        reportFailure(error);
      },
    });
  };
  if (hasPreviewClip(sound.url)) {
    playSoundPreview(sound.url, { onPlaying, onError: handlePlaybackError });
  } else {
    startDirect(sound.url, true);
  }
}

/**
 * Precise looping in real seconds: trim bounds ride on the #t= fragment plus
 * the rAF trim-watch clamp (~16ms) for streamed songs, and on RAM-cached
 * clips the AudioBufferSourceNode path loops sample-accurately when the
 * decoded head covers the requested range.
 */
export function loop(sound: EngineSoundRef, startSec: number, endSec: number): void {
  unlock();
  visibilityResumeGeneration += 1;
  engineActive = true;
  activeSoundId = sound.id || null;
  playInstant(sound.url, {
    trim: { start: Math.max(0, startSec), end: Math.max(0, endSec) },
    loop: true,
  });
}

/** Stop playback and clear the library playback state. */
export function pause(): void {
  visibilityResumeGeneration += 1;
  resumeAfterVisible = false;
  pauseInstant();
  engineActive = false;
  activeSoundId = null;
}

export function stop(): void {
  visibilityResumeGeneration += 1;
  resumeAfterVisible = false;
  stopInstant();
  engineActive = false;
  activeSoundId = null;
  setSoundLibraryState({ playingId: null, loadingId: null, blockedId: null });
}

/**
 * Session disposal for screen teardown: stops playback, releases RAM clip
 * nodes and cancels (discards) all in-flight clip fetches via the cache
 * epoch. Never touches sounds playing in other screens — the global
 * singleton only owns the preview channel.
 */
export function dispose(): void {
  stop();
  disposePreviewClips();
}

/**
 * Dual-audio mixing for a video element playing alongside a chosen sound.
 *
 * Deliberate architecture note: this uses element-level mixing (original
 * track muted while the chosen sound leads, volume restored otherwise) — the
 * same behavior the app uses everywhere. A MediaElementAudioSourceNode graph
 * was evaluated and rejected: it permanently reroutes the element through
 * the AudioContext, requires CORS-clean sources on every host (the exact
 * "CORS lock" this engine removed earlier), and fails closed when the
 * context is suspended.
 */
export function setDualAudio(video: HTMLVideoElement | null, originalVol: number, musicVol: number): void {
  if (!video) return;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  video.volume = clamp(originalVol);
  video.muted = clamp(musicVol) > 0;
}
