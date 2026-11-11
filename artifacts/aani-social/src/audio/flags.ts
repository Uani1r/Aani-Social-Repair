/**
 * Runtime-switchable feature flag for the unified audio engine adapter.
 * Default: the new engine is on. Override per device via localStorage:
 *   localStorage.setItem('aani:use-new-audio-engine', 'false')
 * The flag routes preview/loop calls between the tiered engine paths while
 * both share the same underlying singleton, so switching is loss-free.
 */
const STORAGE_KEY = 'aani:use-new-audio-engine';

export function USE_NEW_AUDIO_ENGINE(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    /* storage unavailable in this context */
  }
  return true;
}

export function setUseNewAudioEngine(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* ignore */
  }
}
