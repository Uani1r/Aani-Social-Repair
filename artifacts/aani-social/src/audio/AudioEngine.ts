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
  installAudioUnlock,
  pauseInstant,
  playInstant,
  playSoundPreview,
  resumeInstant,
  stopInstant,
} from '@/lib/instantAudio';
import { getSoundLibraryState, setSoundLibraryState } from './SoundLibraryStore';
import { USE_NEW_AUDIO_ENGINE } from './flags';

export type EngineSoundRef = { url: string };

let unlockInstalled = false;
let resumeAfterVisible = false;
let engineActive = false;

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
      if (!resumeInstant()) {
        const wasPlaying = getSoundLibraryState().playingId;
        setSoundLibraryState({ playingId: null, ...(wasPlaying ? { blockedId: wasPlaying } : {}) });
      }
    }
  });
}

/**
 * Instant preview in real seconds. With start/end the clip loops inside the
 * bounds (media-element engine with the rAF trim watch); without them the
 * tiered engine runs (RAM AudioBuffer hit < 10ms, else native streaming).
 */
export function preview(sound: EngineSoundRef, startSec = 0, endSec?: number): void {
  unlock();
  engineActive = true;
  setSoundLibraryState({ blockedId: null });
  const hasTrim = Number.isFinite(startSec)
    && typeof endSec === 'number'
    && Number.isFinite(endSec)
    && endSec > startSec;
  if (USE_NEW_AUDIO_ENGINE() && !hasTrim) {
    playSoundPreview(sound.url, {
      onPlaying: () => {
        engineActive = true;
      },
      onError: () => {
        engineActive = false;
      },
    });
    return;
  }
  playInstant(sound.url, {
    loop: true,
    ...(hasTrim ? { trim: { start: startSec, end: endSec as number } } : {}),
  });
}

/**
 * Precise looping in real seconds: trim bounds ride on the #t= fragment plus
 * the rAF trim-watch clamp (~16ms) for streamed songs, and on RAM-cached
 * clips the AudioBufferSourceNode path loops sample-accurately when the
 * decoded head covers the requested range.
 */
export function loop(sound: EngineSoundRef, startSec: number, endSec: number): void {
  unlock();
  engineActive = true;
  playInstant(sound.url, {
    trim: { start: Math.max(0, startSec), end: Math.max(0, endSec) },
    loop: true,
  });
}

/** Stop playback and clear the library playback state. */
export function stop(): void {
  stopInstant();
  engineActive = false;
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
