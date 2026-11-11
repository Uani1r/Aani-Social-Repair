import { useEffect, useRef } from 'react';

import type { MusicTrack } from '@/lib/music';
import { openSoundPicker } from '@/lib/sounds';

interface StoryMusicSheetProps {
  open: boolean;
  onClose: () => void;
  onSelect?: (track: MusicTrack) => void;
}

/**
 * جسر توافق (Compatibility Bridge): زر الموسيقى في القصة لم يعد يعرض
 * نافذة «ميزة الموسيقى قادمة قريباً» — فتحه يشغّل مكتبة الأصوات الموحدة
 * (SoundPickerSheet) باتجاه القصة، ويصل الاختيار عبر حدث USE_SOUND_EVENT
 * بمصدر 'story' مع sound_id وزمني القص sound_trim_start/sound_trim_end.
 */
export default function StoryMusicSheet({ open, onClose }: StoryMusicSheetProps) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      firedRef.current = false;
      return;
    }
    if (firedRef.current) return;
    firedRef.current = true;
    openSoundPicker('story');
    onClose();
  }, [open, onClose]);
  return null;
}
