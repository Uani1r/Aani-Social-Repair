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
import { pauseInstant, playSoundPreview, stopInstant } from '@/lib/instantAudio';
import { openSoundPicker } from '@/lib/sounds';

function useSoundLibraryValue<T>(selector: (state: SoundLibraryState) => T): T {
  return useSyncExternalStore(subscribeSoundLibrary, () => selector(getSoundLibraryState()));
}

export function useSoundPicker() {
  const playingId = useSoundLibraryValue(state => state.playingId);
  const loadingId = useSoundLibraryValue(state => state.loadingId);
  const blockedId = useSoundLibraryValue(state => state.blockedId);

  const togglePreview = useCallback((soundId: string, clipUrl: string) => {
    const current = getSoundLibraryState();
    if (current.playingId === soundId) {
      // In-place pause: RAM clips resume from the same sample on the next tap.
      pauseInstant();
      setSoundLibraryState({ playingId: null });
      return;
    }
    if (current.loadingId === soundId) return;
    setSoundLibraryState({ loadingId: soundId, playingId: null, blockedId: null });
    playSoundPreview(clipUrl, {
      onPlaying: () => setSoundLibraryState({ loadingId: null, playingId: soundId }),
      onEnded: () => {
        if (getSoundLibraryState().playingId === soundId) setSoundLibraryState({ playingId: null });
      },
      onError: () => setSoundLibraryState({ loadingId: null, blockedId: soundId }),
    });
  }, []);

  const stopPreview = useCallback(() => {
    stopInstant();
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
