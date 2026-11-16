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
import { resolveMediaUrl } from '@/lib/mediaAccess';
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
    // توقيع الروابط أولاً: مشغّل الصوت يستخدم الرابط كما وصله، وعند تفعيل
    // التوقيع الإلزامي لا يجوز أن يصل إليه رابط ImageKit عام. فشل التوقيع
    // يعني «محظور» بلا محاولة طلب الملف.
    void (async () => {
      const signedClip = await resolveMediaUrl(clipUrl);
      const signedFallback = fallbackUrl ? await resolveMediaUrl(fallbackUrl) : null;
      if (!signedClip) {
        setSoundLibraryState({ playingId: null, loadingId: null, blockedId: soundId });
        return;
      }
      preview({ id: soundId, url: signedClip, fallbackUrl: signedFallback || undefined }, 0, undefined, {
        onPlaying: () => setSoundLibraryState({ loadingId: null, playingId: soundId, blockedId: null }),
        onBlocked: () => setSoundLibraryState({ loadingId: null, playingId: null, blockedId: soundId }),
        onError: () => setSoundLibraryState({ loadingId: null, playingId: null, blockedId: soundId }),
      });
    })();
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
