/**
 * Sound library playback state — tiny external store with Zustand-shaped
 * selectors (Playing / Loading / Blocked) and ZERO playback position in the
 * state, so nothing re-renders per frame.
 *
 * NOTE (deliberate): implemented dependency-free with the exact
 * useSyncExternalStore contract. When `pnpm add zustand` is run on the
 * workspace this file can be swapped for a real Zustand create() store with
 * the same state shape and selectors — no component changes needed.
 */

export type SoundLibraryState = {
  /** Sound currently playing (or paused in place in the RAM clip tier). */
  playingId: string | null;
  /** Sound currently buffering (spinner). */
  loadingId: string | null;
  /** Sound whose autoplay was rejected by the browser — surfaces the "اضغط للتشغيل" tap-to-play fallback. */
  blockedId: string | null;
  /** Singleton active sound id for IntersectionObserver-driven feeds (one active sound at a time). */
  activeSoundId: string | null;
};

let state: SoundLibraryState = {
  playingId: null,
  loadingId: null,
  blockedId: null,
  activeSoundId: null,
};

const listeners = new Set<() => void>();

export function getSoundLibraryState(): SoundLibraryState {
  return state;
}

export function setSoundLibraryState(patch: Partial<SoundLibraryState>): void {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

export function subscribeSoundLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
