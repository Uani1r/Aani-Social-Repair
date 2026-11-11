import { useEffect, useMemo, useState } from 'react';
import { Music2, Search, X } from 'lucide-react';

import { MusicTracksSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';

import {
  MUSIC_FEATURE_ENABLED,
  getMusicProvider,
  type MusicProvider,
  type MusicTrack,
} from '@/lib/music';

interface StoryMusicSheetProps {
  open: boolean;
  onClose: () => void;
  onSelect: (track: MusicTrack) => void;
}

export default function StoryMusicSheet({ open, onClose, onSelect }: StoryMusicSheetProps) {
  const provider = useMemo<MusicProvider | null>(
    () => (MUSIC_FEATURE_ENABLED ? getMusicProvider() : null),
    [],
  );

  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || !provider) return;

    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const request = query.trim() ? provider.search(query.trim()) : provider.trending();

    request
      .then(tracks => {
        if (!cancelled) setTracks(tracks);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, provider, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center px-6" dir="rtl">
      <button
        type="button"
        aria-label="إغلاق"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px]"
      />

      {!provider ? (
        <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-[#141519] p-5 text-center text-white shadow-2xl">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#FF3B30] to-[#AF52DE] text-white">
            <Music2 size={22} />
          </div>

          <h3 className="text-[15px] font-bold">🎵 ميزة الموسيقى قادمة قريباً!</h3>
          <p className="mt-2 text-[12px] leading-6 text-white/60">
            نعمل على تجهيز مكتبة موسيقية لتعبّر عن حالتك في الستوري.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-[12px] font-bold text-[#121212] transition active:scale-[0.98]"
          >
            إغلاق
          </button>
        </div>
      ) : (
        <div className="flex h-[420px] w-full max-w-sm flex-col rounded-3xl bg-[#141519] p-4 text-white shadow-2xl">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-bold">الموسيقى</span>
            <button type="button" onClick={onClose} className="rounded-full p-1 text-white/70">
              <X size={18} />
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
            <Search size={15} className="text-white/50" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="ابحث عن أغنية"
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-white/40"
            />
          </div>

          <div className="aani-hscroll mt-3 flex-1 overflow-y-auto">
            {loading && <MusicTracksSkeleton count={6} />}
            {!loading && failed && (
              <p className="py-4 text-center text-[11px] text-white/50">تعذّر تحميل المكتبة</p>
            )}
            {!loading && !failed && tracks.length === 0 && (
              <EmptyState />
            )}
            {!loading &&
              !failed &&
              tracks.map(track => (
                <button
                  key={track.id}
                  type="button"
                  onClick={() => onSelect(track)}
                  className="flex w-full items-center gap-2 rounded-xl p-2 text-right transition active:scale-[0.98] hover:bg-white/10"
                >
                  {track.artworkUrl ? (
                    <img src={track.artworkUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10">
                      <Music2 size={16} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold">{track.title}</span>
                    <span className="block truncate text-[10px] text-white/50">{track.artist}</span>
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
