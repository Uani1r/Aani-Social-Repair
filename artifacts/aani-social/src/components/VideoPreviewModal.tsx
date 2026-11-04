import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Check, Music2, Scissors, X } from 'lucide-react';

import type { VideoTrimRange } from '@/lib/types';

type VideoPreviewModalProps = {
  open: boolean;
  src: string;
  initialTrim: VideoTrimRange | null;
  onTrimChange: (range: VideoTrimRange) => void;
  onClose: () => void;
  onNext: (range: VideoTrimRange) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const minimumSelection = (duration: number) => Math.min(0.1, duration);

function normalizeRange(range: VideoTrimRange | null, duration: number): VideoTrimRange {
  const minLength = minimumSelection(duration);
  const end = clamp(range?.end ?? duration, minLength, duration);
  const start = clamp(range?.start ?? 0, 0, Math.max(0, end - minLength));
  return { start, end, duration };
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export default function VideoPreviewModal({
  open,
  src,
  initialTrim,
  onTrimChange,
  onClose,
  onNext,
}: VideoPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [savedRange, setSavedRange] = useState<VideoTrimRange | null>(null);
  const [draftRange, setDraftRange] = useState<VideoTrimRange | null>(null);
  const [isTrimming, setIsTrimming] = useState(false);
  const [musicNotice, setMusicNotice] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isTrimming) setIsTrimming(false);
      else onClose();
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isTrimming, onClose, open]);

  useEffect(() => {
    if (!open) return;
    setDuration(0);
    setSavedRange(null);
    setDraftRange(null);
    setIsTrimming(false);
  }, [open, src]);

  useEffect(() => {
    if (!musicNotice) return undefined;
    const timer = window.setTimeout(() => setMusicNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [musicNotice]);

  const handleLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const loadedDuration = event.currentTarget.duration;
    if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) return;

    const initialRange = normalizeRange(initialTrim, loadedDuration);
    setDuration(loadedDuration);
    setSavedRange(current => current ? normalizeRange(current, loadedDuration) : initialRange);
    setDraftRange(current => current ? normalizeRange(current, loadedDuration) : initialRange);
    event.currentTarget.currentTime = initialRange.start;
  };

  const activeRange = isTrimming ? draftRange : savedRange;

  const handleTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!activeRange || video.currentTime < activeRange.end - 0.04) return;
    video.currentTime = activeRange.start;
    if (video.paused) void video.play().catch(() => undefined);
  };

  const updateDraftRange = (part: 'start' | 'end', value: number) => {
    if (!draftRange) return;
    const minLength = minimumSelection(duration);
    setDraftRange(current => {
      if (!current) return current;
      if (part === 'start') {
        return { ...current, start: clamp(value, 0, Math.max(0, current.end - minLength)) };
      }
      return { ...current, end: clamp(value, Math.min(duration, current.start + minLength), duration) };
    });
  };

  const beginTrimming = () => {
    if (!duration) return;
    setDraftRange(savedRange || normalizeRange(null, duration));
    setIsTrimming(true);
  };

  const cancelTrimming = () => {
    setDraftRange(savedRange || normalizeRange(null, duration));
    setIsTrimming(false);
  };

  const saveTrim = () => {
    if (!draftRange) return;
    const range = normalizeRange(draftRange, duration);
    setSavedRange(range);
    setDraftRange(range);
    onTrimChange(range);
    setIsTrimming(false);
    const video = videoRef.current;
    if (video) video.currentTime = range.start;
  };

  const continueToCaption = () => {
    const range = savedRange || normalizeRange(null, duration);
    onTrimChange(range);
    onNext(range);
  };

  if (!open) return null;

  const range = draftRange || savedRange || normalizeRange(null, duration || 0.1);
  const startPosition = duration > 0 ? (range.start / duration) * 100 : 0;
  const endPosition = duration > 0 ? (range.end / duration) * 100 : 100;

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="معاينة الفيديو المختار">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        {isTrimming ? (
          <>
            <button type="button" onClick={cancelTrimming} className="rounded-full px-4 py-2 text-sm text-white/75">إلغاء</button>
            <span className="text-sm font-semibold">قص مدة الفيديو</span>
            <button type="button" onClick={saveTrim} disabled={!draftRange} className="flex min-w-24 items-center justify-center gap-1 rounded-full bg-[#f1a17f] px-4 py-2 text-sm font-bold text-black disabled:opacity-60">
              <Check size={17} /> حفظ القص
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} aria-label="إغلاق معاينة الفيديو" className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10">
              <X size={23} />
            </button>
            <span className="text-sm font-semibold text-white/70">معاينة الفيديو</span>
            <button type="button" onClick={continueToCaption} disabled={!duration} className="rounded-full bg-[#f1a17f] px-6 py-2.5 text-base font-bold text-black transition active:scale-95 disabled:opacity-60">التالي</button>
          </>
        )}
      </header>

      <div className={`relative flex min-h-0 flex-1 flex-col items-center justify-center ${isTrimming ? 'pb-60' : 'pb-28'}`}>
        <div className="relative h-full max-h-full w-auto max-w-full shrink-0 overflow-hidden rounded-xl bg-black" style={{ aspectRatio: '4 / 5' }}>
          <video
            ref={videoRef}
            src={src}
            autoPlay
            muted
            playsInline
            controls
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onEnded={event => {
              if (!activeRange) return;
              event.currentTarget.currentTime = activeRange.start;
              void event.currentTarget.play().catch(() => undefined);
            }}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      </div>

      {isTrimming && (
        <section className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 w-[min(92vw,420px)] -translate-x-1/2 rounded-3xl border border-white/10 bg-[#1a1b22]/95 p-4 shadow-2xl backdrop-blur-xl" aria-label="تحديد مدة الفيديو">
          <div className="mb-3 flex items-center justify-between text-xs text-white/65" dir="ltr">
            <span>{formatTime(range.start)}</span>
            <span>{formatTime(range.end)} / {formatTime(duration)}</span>
          </div>
          <div className="relative mb-4 h-2 rounded-full bg-white/15" dir="ltr" aria-hidden="true">
            <span className="absolute inset-y-0 rounded-full bg-[#f1a17f]" style={{ left: `${startPosition}%`, right: `${100 - endPosition}%` }} />
          </div>
          <label className="mb-1 flex items-center justify-between text-xs text-white/80" dir="rtl">
            <span>بداية المقطع</span><span dir="ltr">{formatTime(range.start)}</span>
          </label>
          <input
            type="range"
            aria-label="تحديد بداية الفيديو"
            min="0"
            max={Math.max(0, range.end - minimumSelection(duration))}
            step="0.1"
            value={range.start}
            onChange={event => updateDraftRange('start', Number(event.currentTarget.value))}
            className="mb-3 block w-full accent-[#f1a17f]"
            disabled={!duration}
          />
          <label className="mb-1 flex items-center justify-between text-xs text-white/80" dir="rtl">
            <span>نهاية المقطع</span><span dir="ltr">{formatTime(range.end)}</span>
          </label>
          <input
            type="range"
            aria-label="تحديد نهاية الفيديو"
            min={Math.min(duration, range.start + minimumSelection(duration))}
            max={duration}
            step="0.1"
            value={range.end}
            onChange={event => updateDraftRange('end', Number(event.currentTarget.value))}
            className="block w-full accent-[#f1a17f]"
            disabled={!duration}
          />
        </section>
      )}

      {!isTrimming && (
        <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-[#242326]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
          <button type="button" onClick={() => setMusicNotice(true)} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-[#f1a17f] transition hover:bg-white/5">
            <Music2 size={24} />
            <span className="text-xs font-medium">موسيقى</span>
          </button>
          <button type="button" onClick={beginTrimming} disabled={!duration} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-white/85 transition hover:bg-white/5 disabled:opacity-50">
            <Scissors size={24} />
            <span className="text-xs font-medium">قص المدة</span>
          </button>
        </div>
      )}

      {musicNotice && !isTrimming && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
