import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import { Check, Crop, Music2, Scissors, Volume2, VolumeX, X } from 'lucide-react';

import type { VideoAspectRatio, VideoCropTransform, VideoTrimRange } from '@/lib/types';
import { DEFAULT_VIDEO_CROP, getVideoAspectRatio, getVideoCropTransform, normalizeVideoCrop } from '@/lib/videoMedia';

type VideoPreviewModalProps = {
  open: boolean;
  src: string;
  initialTrim: VideoTrimRange | null;
  initialCrop: VideoCropTransform | null;
  onTrimChange: (range: VideoTrimRange) => void;
  onCropChange: (crop: VideoCropTransform) => void;
  onClose: () => void;
  onNext: (range: VideoTrimRange, crop: VideoCropTransform) => void;
};

type CropPointer = { x: number; y: number };
type CropGesture =
  | { type: 'pan'; pointerId: number; startPoint: CropPointer; startCrop: VideoCropTransform }
  | { type: 'pinch'; startDistance: number; startCrop: VideoCropTransform }
  | { type: 'resize'; pointerId: number; corner: string; startPoint: CropPointer; startCrop: VideoCropTransform };

const ASPECT_RATIOS: { key: VideoAspectRatio; label: string }[] = [
  { key: 'free', label: 'حر / أصلي' },
  { key: '4:5', label: '4:5' },
  { key: '1:1', label: '1:1' },
  { key: '9:16', label: '9:16' },
];
const NEW_VIDEO_CROP: VideoCropTransform = { ...DEFAULT_VIDEO_CROP, aspectRatio: 'free' };
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const distanceBetween = (first: CropPointer, second: CropPointer) => Math.hypot(second.x - first.x, second.y - first.y);
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
  initialCrop,
  onTrimChange,
  onCropChange,
  onClose,
  onNext,
}: VideoPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cropFrameRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const draggingTrimRef = useRef<'start' | 'end' | null>(null);
  const cropPointersRef = useRef(new Map<number, CropPointer>());
  const cropGestureRef = useRef<CropGesture | null>(null);
  const initialCropRef = useRef(initialCrop);
  const activeRangeRef = useRef<VideoTrimRange | null>(null);
  const [duration, setDuration] = useState(0);
  const [savedRange, setSavedRange] = useState<VideoTrimRange | null>(null);
  const [draftRange, setDraftRange] = useState<VideoTrimRange | null>(null);
  const [savedCrop, setSavedCrop] = useState<VideoCropTransform>(NEW_VIDEO_CROP);
  const [draftCrop, setDraftCrop] = useState<VideoCropTransform>(NEW_VIDEO_CROP);
  const [isMuted, setIsMuted] = useState(false);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [isTrimming, setIsTrimming] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [musicNotice, setMusicNotice] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!open) return undefined;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isTrimming) setIsTrimming(false);
      else if (isCropping) setIsCropping(false);
      else onClose();
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isCropping, isTrimming, onClose, open]);

  useEffect(() => {
    if (!open) initialCropRef.current = initialCrop;
  }, [initialCrop, open]);

  useEffect(() => {
    if (!open) return;
    setIsMuted(false);
    if (videoRef.current) {
      videoRef.current.muted = false;
      videoRef.current.volume = 1;
    }
    setDuration(0);
    setSavedRange(null);
    setDraftRange(null);
    activeRangeRef.current = null;
    const startingCrop = normalizeVideoCrop(initialCropRef.current ?? NEW_VIDEO_CROP);
    setSavedCrop(startingCrop);
    setDraftCrop(startingCrop);
    setThumbnails([]);
    setIsTrimming(false);
    setIsCropping(true);
    cropPointersRef.current.clear();
    cropGestureRef.current = null;
  }, [open, src]);

  useEffect(() => {
    if (!open) return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measureStage = () => {
      const style = window.getComputedStyle(stage);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setStageSize({
        width: Math.max(0, stage.clientWidth - (Number.isFinite(horizontalPadding) ? horizontalPadding : 0)),
        height: Math.max(0, stage.clientHeight - (Number.isFinite(verticalPadding) ? verticalPadding : 0)),
      });
    };
    measureStage();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureStage);
      return () => window.removeEventListener('resize', measureStage);
    }
    const observer = new ResizeObserver(measureStage);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [open, isCropping, isTrimming]);

  useEffect(() => {
    if (!musicNotice) return undefined;
    const timer = window.setTimeout(() => setMusicNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [musicNotice]);

  useEffect(() => {
    if (!open || duration <= 0 || !src) return undefined;
    let cancelled = false;
    const frameVideo = document.createElement('video');
    frameVideo.muted = true;
    frameVideo.preload = 'auto';
    frameVideo.playsInline = true;

    const createFilmstrip = async () => {
      try {
        frameVideo.src = src;
        frameVideo.load();
        await new Promise<void>((resolve, reject) => {
          if (frameVideo.readyState >= 1) {
            resolve();
            return;
          }
          const onReady = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('تعذر قراءة إطارات الفيديو')); };
          const cleanup = () => {
            frameVideo.removeEventListener('loadedmetadata', onReady);
            frameVideo.removeEventListener('error', onError);
          };
          frameVideo.addEventListener('loadedmetadata', onReady, { once: true });
          frameVideo.addEventListener('error', onError, { once: true });
        });

        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 120;
        const context = canvas.getContext('2d');
        if (!context) return;
        const frames: string[] = [];
        const count = 10;
        for (let index = 0; index < count && !cancelled; index += 1) {
          const time = Math.min(Math.max(0, duration - 0.08), duration * ((index + 0.5) / count));
          if (Math.abs(frameVideo.currentTime - time) > 0.01) {
            await new Promise<void>(resolve => {
              const timeout = window.setTimeout(() => {
                frameVideo.removeEventListener('seeked', onSeeked);
                resolve();
              }, 1800);
              const onSeeked = () => {
                window.clearTimeout(timeout);
                frameVideo.removeEventListener('seeked', onSeeked);
                resolve();
              };
              frameVideo.addEventListener('seeked', onSeeked, { once: true });
              try {
                frameVideo.currentTime = time;
              } catch {
                window.clearTimeout(timeout);
                frameVideo.removeEventListener('seeked', onSeeked);
                resolve();
              }
            });
          }
          if (cancelled || frameVideo.readyState < 2) continue;
          try {
            context.drawImage(frameVideo, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL('image/jpeg', 0.62));
          } catch {
            // Keep the timeline usable even when a browser cannot snapshot a frame.
          }
        }
        if (!cancelled) setThumbnails(frames);
      } catch {
        if (!cancelled) setThumbnails([]);
      }
    };

    void createFilmstrip();
    return () => {
      cancelled = true;
      frameVideo.pause();
      frameVideo.removeAttribute('src');
      frameVideo.load();
    };
  }, [duration, open, src]);

  // إيقاف الفيديو الرئيسي وإطلاق موارده عند إغلاق المعاينة حتى لا
  // يستمر صوته بعد الخروج (WebKit يشغّل صوت العناصر المنزوعة).
  useEffect(() => () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* العنصر قد يكون أفلت مرجعه بالفعل */
    }
  }, []);

  const handleLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const loadedDuration = video.duration;
    if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) return;

    const initialRange = normalizeRange(initialTrim, loadedDuration);
    const sourceAspectRatio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : undefined;
    activeRangeRef.current = initialRange;
    setDuration(loadedDuration);
    setSavedRange(current => current ? normalizeRange(current, loadedDuration) : initialRange);
    setDraftRange(current => current ? normalizeRange(current, loadedDuration) : initialRange);
    if (sourceAspectRatio && Number.isFinite(sourceAspectRatio)) {
      setSavedCrop(current => normalizeVideoCrop({ ...current, sourceAspectRatio }));
      setDraftCrop(current => normalizeVideoCrop({ ...current, sourceAspectRatio }));
    }
    if (!isMuted) video.volume = 1;
    video.currentTime = initialRange.start;
    void video.play().catch(() => undefined);
  };

  const activeRange = isTrimming ? draftRange : savedRange;
  activeRangeRef.current = activeRange;
  const activeCrop = isCropping ? draftCrop : savedCrop;
  const frameAspectRatio = getVideoAspectRatio(activeCrop) ?? 4 / 5;

  const handleTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const range = activeRangeRef.current;
    if (!range) return;
    if (video.currentTime < range.start || video.currentTime >= range.end - 0.04) {
      video.currentTime = range.start;
    }
  };

  const updateDraftRange = (part: 'start' | 'end', value: number) => {
    if (!draftRange) return;
    const minLength = minimumSelection(duration);
    const nextRange = part === 'start'
      ? { ...draftRange, start: clamp(value, 0, Math.max(0, draftRange.end - minLength)) }
      : { ...draftRange, end: clamp(value, Math.min(duration, draftRange.start + minLength), duration) };
    activeRangeRef.current = nextRange;
    setDraftRange(nextRange);

    const video = videoRef.current;
    if (!video) return;
    if (part === 'start') {
      video.currentTime = nextRange.start;
    } else if (video.currentTime >= nextRange.end) {
      video.currentTime = nextRange.start;
    }
  };

  const beginTrimming = () => {
    if (!duration) return;
    const range = savedRange || normalizeRange(null, duration);
    activeRangeRef.current = range;
    setDraftRange(range);
    setIsCropping(false);
    setIsTrimming(true);
  };

  const cancelTrimming = () => {
    const range = savedRange || normalizeRange(null, duration);
    activeRangeRef.current = range;
    setDraftRange(range);
    setIsTrimming(false);
  };

  const saveTrim = () => {
    if (!draftRange) return;
    const range = normalizeRange(draftRange, duration);
    activeRangeRef.current = range;
    setSavedRange(range);
    setDraftRange(range);
    onTrimChange(range);
    setIsTrimming(false);
    const video = videoRef.current;
    if (video) video.currentTime = range.start;
  };

  const beginCropping = () => {
    activeRangeRef.current = savedRange;
    setDraftCrop(savedCrop);
    setIsTrimming(false);
    setIsCropping(true);
  };

  const cancelCropping = () => {
    setDraftCrop(savedCrop);
    setIsCropping(false);
  };

  const saveCrop = () => {
    const crop = normalizeVideoCrop(draftCrop);
    setSavedCrop(crop);
    setDraftCrop(crop);
    onCropChange(crop);
    setIsCropping(false);
  };

  const handleTimelinePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, part: 'start' | 'end') => {
    draggingTrimRef.current = part;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleTimelinePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const part = draggingTrimRef.current;
    const track = timelineRef.current;
    if (!part || !track || !duration) return;
    const rect = track.getBoundingClientRect();
    const position = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    updateDraftRange(part, duration * position);
  };

  const endTimelinePointer = () => { draggingTrimRef.current = null; };

  const selectAspectRatio = (aspectRatio: VideoAspectRatio) => {
    setDraftCrop(current => normalizeVideoCrop({ ...current, aspectRatio, zoom: 1, x: 0, y: 0 }));
  };

  const beginCropDrag = (event: ReactPointerEvent<HTMLElement>, corner?: string) => {
    if (!isCropping) return;
    event.preventDefault();
    if (corner) event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    if (corner) {
      cropGestureRef.current = { type: 'resize', pointerId: event.pointerId, corner, startPoint: point, startCrop: draftCrop };
    } else {
      cropPointersRef.current.set(event.pointerId, point);
      const pointers = Array.from(cropPointersRef.current.values());
      cropGestureRef.current = pointers.length >= 2
        ? { type: 'pinch', startDistance: distanceBetween(pointers[0], pointers[1]), startCrop: draftCrop }
        : { type: 'pan', pointerId: event.pointerId, startPoint: point, startCrop: draftCrop };
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  };

  const moveCrop = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = cropGestureRef.current;
    if (!gesture || !isCropping) return;
    if (gesture.type !== 'resize') {
      if (!cropPointersRef.current.has(event.pointerId)) return;
      cropPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const cropFrame = cropFrameRef.current;
    if (!cropFrame) return;
    const rect = cropFrame.getBoundingClientRect();
    if (gesture.type === 'pinch') {
      const pointers = Array.from(cropPointersRef.current.values());
      if (pointers.length < 2) return;
      const zoom = clamp(gesture.startCrop.zoom * distanceBetween(pointers[0], pointers[1]) / Math.max(gesture.startDistance, 1), 1, 3);
      setDraftCrop(normalizeVideoCrop({ ...gesture.startCrop, zoom }));
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startPoint.x;
    const deltaY = event.clientY - gesture.startPoint.y;
    if (gesture.type === 'resize') {
      const directionX = gesture.corner.includes('right') ? 1 : -1;
      const directionY = gesture.corner.includes('bottom') ? 1 : -1;
      const outwardDelta = (deltaX * directionX + deltaY * directionY) / 2;
      const zoom = clamp(gesture.startCrop.zoom - outwardDelta / Math.max(1, Math.min(rect.width, rect.height)) * 2, 1, 3);
      setDraftCrop(normalizeVideoCrop({ ...gesture.startCrop, zoom }));
      return;
    }

    if (gesture.startCrop.zoom <= 1.001) return;
    const maxX = Math.max(1, rect.width * (gesture.startCrop.zoom - 1) * 0.5);
    const maxY = Math.max(1, rect.height * (gesture.startCrop.zoom - 1) * 0.5);
    setDraftCrop(normalizeVideoCrop({
      ...gesture.startCrop,
      x: gesture.startCrop.x + deltaX / maxX,
      y: gesture.startCrop.y + deltaY / maxY,
    }));
  };

  const endCropDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = cropGestureRef.current;
    cropPointersRef.current.delete(event.pointerId);
    if (gesture?.type === 'pinch' && cropPointersRef.current.size === 1) {
      const [pointerId, point] = Array.from(cropPointersRef.current.entries())[0];
      cropGestureRef.current = { type: 'pan', pointerId, startPoint: point, startCrop: draftCrop };
    } else if (gesture?.type === 'resize' && gesture.pointerId === event.pointerId) {
      cropGestureRef.current = null;
    } else if (gesture?.type === 'pan' && gesture.pointerId === event.pointerId) {
      cropGestureRef.current = null;
    } else if (cropPointersRef.current.size === 0) {
      cropGestureRef.current = null;
    }
  };

  const continueToCaption = () => {
    const range = savedRange || normalizeRange(null, duration);
    const crop = normalizeVideoCrop(savedCrop);
    onTrimChange(range);
    onCropChange(crop);
    onNext(range, crop);
  };

  if (!open) return null;

  const range = draftRange || savedRange || normalizeRange(null, duration || 0.1);
  const startPosition = duration > 0 ? (range.start / duration) * 100 : 0;
  const endPosition = duration > 0 ? (range.end / duration) * 100 : 100;
  const frameWidth = stageSize.width > 0 && stageSize.height > 0
    ? Math.min(stageSize.width, stageSize.height * frameAspectRatio)
    : undefined;
  const frameHeight = frameWidth ? frameWidth / frameAspectRatio : undefined;

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
        ) : isCropping ? (
          <>
            <button type="button" onClick={cancelCropping} className="rounded-full px-4 py-2 text-sm text-white/75">إلغاء</button>
            <span className="text-sm font-semibold">قص إطار الفيديو</span>
            <button type="button" onClick={saveCrop} className="flex min-w-24 items-center justify-center gap-1 rounded-full bg-[#f1a17f] px-4 py-2 text-sm font-bold text-black">
              <Check size={17} /> حفظ الإطار
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

      <div ref={stageRef} className={`relative flex min-h-0 flex-1 flex-col items-center justify-center ${isTrimming ? 'pb-[19rem]' : isCropping ? 'pb-56' : 'pb-28'}`}>
        <div
          ref={cropFrameRef}
          className={`relative max-h-full shrink-0 overflow-hidden rounded-xl bg-black ${isCropping ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={{
            aspectRatio: String(frameAspectRatio),
            width: frameWidth ? `${frameWidth}px` : '100%',
            height: frameHeight ? `${frameHeight}px` : '100%',
            touchAction: isCropping ? 'none' : undefined,
          }}
          onPointerDown={beginCropDrag}
          onPointerMove={moveCrop}
          onPointerUp={endCropDrag}
          onPointerCancel={endCropDrag}
        >
          {isCropping && (
            <div className="pointer-events-none absolute inset-0 z-10 border border-white/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]">
              {[1, 2].map(line => (
                <Fragment key={line}>
                  <span className="absolute inset-y-0 border-l border-white/30" style={{ left: `${(line * 100) / 3}%` }} />
                  <span className="absolute inset-x-0 border-t border-white/30" style={{ top: `${(line * 100) / 3}%` }} />
                </Fragment>
              ))}
              {[
                { corner: 'top-left', position: '-left-2 -top-2' },
                { corner: 'top-right', position: '-right-2 -top-2' },
                { corner: 'bottom-left', position: '-bottom-2 -left-2' },
                { corner: 'bottom-right', position: '-bottom-2 -right-2' },
              ].map(({ corner, position }) => (
                <button
                  key={corner}
                  type="button"
                  aria-label={`تغيير إطار القص من الزاوية ${corner}`}
                  onPointerDown={event => beginCropDrag(event, corner)}
                  onPointerMove={moveCrop}
                  onPointerUp={endCropDrag}
                  onPointerCancel={endCropDrag}
                  className={`pointer-events-auto absolute z-10 h-5 w-5 rounded-full border-2 border-black bg-white shadow ${position}`}
                />
              ))}
            </div>
          )}
          <video
            ref={videoRef}
            src={src}
            autoPlay
            muted={isMuted}
            playsInline
            controls={!isCropping}
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onSeeking={event => {
              const video = event.currentTarget;
              const range = activeRangeRef.current;
              if (!range) return;
              if (video.currentTime < range.start || video.currentTime >= range.end) {
                video.currentTime = range.start;
              }
            }}
            onPlay={event => {
              const video = event.currentTarget;
              const range = activeRangeRef.current;
              if (range && (video.currentTime < range.start || video.currentTime >= range.end)) {
                video.currentTime = range.start;
              }
            }}
            onEnded={event => {
              const range = activeRangeRef.current;
              if (!range) return;
              event.currentTarget.currentTime = range.start;
              void event.currentTarget.play().catch(() => undefined);
            }}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ transform: getVideoCropTransform(activeCrop), transformOrigin: 'center' }}
          />
          <button
            type="button"
            aria-label={isMuted ? 'تشغيل الصوت' : 'كتم الصوت'}
            aria-pressed={!isMuted}
            onPointerDown={event => event.stopPropagation()}
            onClick={() => {
              const nextMuted = !isMuted;
              setIsMuted(nextMuted);
              const video = videoRef.current;
              if (!video) return;
              video.muted = nextMuted;
              if (!nextMuted) {
                video.volume = 1;
                void video.play().catch(() => undefined);
              }
            }}
            className="absolute right-3 top-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur"
          >
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        </div>
      </div>

      {isTrimming && (
        <section className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 w-[min(92vw,420px)] -translate-x-1/2 rounded-3xl border border-white/10 bg-[#1a1b22]/95 p-4 shadow-2xl backdrop-blur-xl" aria-label="تحديد مدة الفيديو">
          <div className="mb-3 flex items-center justify-between text-xs text-white/65" dir="ltr">
            <span>{formatTime(range.start)}</span>
            <span>{formatTime(range.end)} / {formatTime(duration)}</span>
          </div>
          <div
            ref={timelineRef}
            className="relative mb-4 h-14 touch-none overflow-hidden rounded-lg bg-white/10"
            dir="ltr"
            aria-label="شريط الفيديو المصغّر؛ اسحب مقابض التحديد"
            onPointerMove={handleTimelinePointerMove}
            onPointerUp={endTimelinePointer}
            onPointerCancel={endTimelinePointer}
          >
            <div className="absolute inset-0 flex">
              {Array.from({ length: 10 }, (_, index) => (
                <span
                  key={index}
                  className="h-full min-w-0 flex-1 bg-zinc-700"
                  style={thumbnails[index] ? { backgroundImage: `url("${thumbnails[index]}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
                />
              ))}
            </div>
            <span className="pointer-events-none absolute inset-y-0 left-0 bg-black/65" style={{ width: `${startPosition}%` }} />
            <span className="pointer-events-none absolute inset-y-0 right-0 bg-black/65" style={{ width: `${100 - endPosition}%` }} />
            <span className="pointer-events-none absolute inset-y-0 border-y-2 border-[#f1a17f]" style={{ left: `${startPosition}%`, width: `${Math.max(0, endPosition - startPosition)}%` }} />
            <button
              type="button"
              aria-label="اسحب لتحديد بداية المقطع"
              className="absolute top-0 z-10 h-full w-5 -translate-x-1/2 touch-none rounded-sm border-x-2 border-white bg-[#f1a17f]/85 shadow-lg"
              style={{ left: `${startPosition}%` }}
              onPointerDown={event => handleTimelinePointerDown(event, 'start')}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const delta = Math.max(0.1, duration / 100) * (event.key === 'ArrowRight' ? 1 : -1);
                updateDraftRange('start', range.start + delta);
              }}
            />
            <button
              type="button"
              aria-label="اسحب لتحديد نهاية المقطع"
              className="absolute top-0 z-10 h-full w-5 -translate-x-1/2 touch-none rounded-sm border-x-2 border-white bg-[#f1a17f]/85 shadow-lg"
              style={{ left: `${endPosition}%` }}
              onPointerDown={event => handleTimelinePointerDown(event, 'end')}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const delta = Math.max(0.1, duration / 100) * (event.key === 'ArrowRight' ? 1 : -1);
                updateDraftRange('end', range.end + delta);
              }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-white/75" dir="rtl">
            <span>اسحب المقابض لتحديد المقطع</span>
            <span dir="ltr">{formatTime(range.end - range.start)}</span>
          </div>
        </section>
      )}

      {isCropping && (
        <section className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 w-[min(94vw,420px)] -translate-x-1/2 rounded-3xl border border-white/10 bg-[#1a1b22]/95 p-3 shadow-2xl backdrop-blur-xl" aria-label="قص إطار الفيديو">
          <div className="mb-2 flex items-center justify-between text-xs text-white/70" dir="rtl">
            <span>حرّك الفيديو أو اسحب مقابض الزوايا</span>
            <span dir="ltr">{draftCrop.zoom.toFixed(1)}×</span>
          </div>
          <div className="mb-3 flex items-center justify-between gap-1" role="group" aria-label="نسبة أبعاد الفيديو" dir="rtl">
            {ASPECT_RATIOS.map(preset => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={(draftCrop.aspectRatio || 'free') === preset.key}
                onClick={() => selectAspectRatio(preset.key)}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${((draftCrop.aspectRatio || 'free') === preset.key) ? 'bg-[#f1a17f] text-black' : 'bg-white/10 text-white/75 hover:bg-white/15'}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label className="mb-1 flex items-center justify-between text-xs text-white/80" dir="rtl">
            <span>التكبير</span><span dir="ltr">{draftCrop.zoom.toFixed(1)}×</span>
          </label>
          <input
            type="range"
            aria-label="تكبير إطار الفيديو"
            min="1"
            max="3"
            step="0.01"
            value={draftCrop.zoom}
            onChange={event => {
              const zoom = Number(event.currentTarget.value);
              setDraftCrop(current => normalizeVideoCrop({ ...current, zoom, ...(zoom <= 1.01 ? { x: 0, y: 0 } : {}) }));
            }}
            className="block w-full accent-[#f1a17f]"
          />
        </section>
      )}

      {!isTrimming && !isCropping && (
        <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-[#242326]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
          <button type="button" onClick={() => setMusicNotice(true)} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-3 py-1 text-[#f1a17f] transition hover:bg-white/5">
            <Music2 size={24} />
            <span className="text-xs font-medium">موسيقى</span>
          </button>
          <button type="button" onClick={beginTrimming} disabled={!duration} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-3 py-1 text-white/85 transition hover:bg-white/5 disabled:opacity-50">
            <Scissors size={24} />
            <span className="text-xs font-medium">قص المدة</span>
          </button>
          <button type="button" onClick={beginCropping} disabled={!duration} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-3 py-1 text-white/85 transition hover:bg-white/5 disabled:opacity-50">
            <Crop size={24} />
            <span className="text-xs font-medium">قص الإطار</span>
          </button>
        </div>
      )}

      {musicNotice && !isTrimming && !isCropping && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
