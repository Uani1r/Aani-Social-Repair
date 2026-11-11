/**
 * Unified sound-picker hook (Clean Slate Migration compatibility layer).
 * Gives components one stable API over the engine + library state:
 *   - openPicker(): opens the unified SoundPickerSheet (post or story target).
 *   - togglePreview(soundId, clipUrl): instant preview with optimistic
 *     Playing / Loading / Blocked states from SoundLibraryStore selectors.
 *   - stopPreview(): full stop on publish/close.
 * No playback position ever enters React state — zero per-frame re-renders.
 */
import { useCallback, useSyncExternalStore } from 'react';

import {
  getSoundLibraryState,
  setSoundLibraryState,
  subscribeSoundLibrary,
  type SoundLibraryState,
} from '@/audio/SoundLibraryStore';
import { pause as pauseAudioEngine, preview, stop as stopAudioEngine } from '@/audio/AudioEngine';
import { openSoundPicker } from '@/lib/sounds';

function useSoundLibraryValue<T>(selector: (state: SoundLibraryState) => T): T {
  return useSyncExternalStore(subscribeSoundLibrary, () => selector(getSoundLibraryState()));
}

export function useSoundPicker() {
  const playingId = useSoundLibraryValue(state => state.playingId);
  const loadingId = useSoundLibraryValue(state => state.loadingId);
  const blockedId = useSoundLibraryValue(state => state.blockedId);

  const togglePreview = useCallback((soundId: string, clipUrl: string, fallbackUrl?: string) => {
    const current = getSoundLibraryState();
    if (current.playingId === soundId) {
      pauseAudioEngine();
      setSoundLibraryState({ playingId: null, loadingId: null });
      return;
    }

    // Optimistically leave the loading state before starting the native audio
    // element. Network buffering never holds the UI on a spinner.
    setSoundLibraryState({ playingId: soundId, loadingId: null, blockedId: null });
    preview({ id: soundId, url: clipUrl, fallbackUrl }, 0, undefined, {
      onPlaying: () => setSoundLibraryState({ loadingId: null, playingId: soundId, blockedId: null }),
      onBlocked: () => setSoundLibraryState({ loadingId: null, playingId: null, blockedId: soundId }),
      onError: () => setSoundLibraryState({ loadingId: null, playingId: null, blockedId: soundId }),
    });
  }, []);

  const stopPreview = useCallback(() => {
    stopAudioEngine();
    setSoundLibraryState({ playingId: null, loadingId: null, blockedId: null });
  }, []);

  return {
    playingId,
    loadingId,
    blockedId,
    togglePreview,
    stopPreview,
    openPicker: openSoundPicker,
  };
}
