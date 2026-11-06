import React, { useEffect, useRef, useState } from 'react';
import { Check, Crop, Minus, Music2, Plus, X } from 'lucide-react';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ASPECT_RATIOS = [
  { key: 'free', label: 'حر / أصلي' },
  { key: '4:5', label: '4:5' },
  { key: '1:1', label: '1:1' },
  { key: '9:16', label: '9:16' },
];
const FIXED_ASPECT_RATIOS = { '4:5': 4 / 5, '1:1': 1, '9:16': 9 / 16 };
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const distanceBetween = (first, second) => Math.hypot(second.x - first.x, second.y - first.y);

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر تجهيز الصورة.'));
  reader.onerror = () => reject(reader.error || new Error('تعذر تجهيز الصورة.'));
  reader.readAsDataURL(blob);
});

function getImageElement(frame) {
  return frame?.querySelector('img') || null;
}

function getImageBounds(frame, image, zoom) {
  if (!frame || !image?.naturalWidth || !image?.naturalHeight) return { maxX: 0, maxY: 0 };
  const frameBounds = frame.getBoundingClientRect();
  const coverScale = Math.max(frameBounds.width / image.naturalWidth, frameBounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * coverScale * zoom;
  const renderedHeight = image.naturalHeight * coverScale * zoom;
  return {
    maxX: Math.max(0, (renderedWidth - frameBounds.width) / 2),
    maxY: Math.max(0, (renderedHeight - frameBounds.height) / 2),
  };
}

async function cropImage(image, cropView, frameBounds, aspectRatio, preserveOriginal) {
  const source = new window.Image();
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error('تعذر تحميل الصورة للقص.'));
    source.src = image.dataUrl;
  });

  const coverScale = Math.max(frameBounds.width / source.naturalWidth, frameBounds.height / source.naturalHeight);
  const renderedScale = coverScale * cropView.scale;
  const sourceWidth = Math.min(source.naturalWidth, frameBounds.width / renderedScale);
  const sourceHeight = Math.min(source.naturalHeight, frameBounds.height / renderedScale);
  const sourceX = clamp((source.naturalWidth - sourceWidth) / 2 - cropView.x / renderedScale, 0, source.naturalWidth - sourceWidth);
  const sourceY = clamp((source.naturalHeight - sourceHeight) / 2 - cropView.y / renderedScale, 0, source.naturalHeight - sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = preserveOriginal ? Math.max(1, Math.round(sourceWidth)) : 1080;
  canvas.height = preserveOriginal
    ? Math.max(1, Math.round(sourceHeight))
    : Math.round(canvas.width / aspectRatio);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر تجهيز مساحة القص.');
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

  const outputType = image.file.type === 'image/png' || image.file.type === 'image/webp'
    ? image.file.type
    : 'image/jpeg';
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('تعذر حفظ الصورة المقصوصة.')), outputType, 0.92);
  });
  const extension = outputType === 'image/png' ? 'png' : outputType === 'image/webp' ? 'webp' : 'jpg';
  const originalName = image.file.name.replace(/\.[^.]+$/, '');
  const file = new File([blob], `${originalName}-cropped.${extension}`, {
    type: outputType,
    lastModified: Date.now(),
  });

  return { file, dataUrl: await blobToDataUrl(blob) };
}

export default function ImagePreviewModal({ open, images, onImagesChange, onClose, onNext }) {
  const trackRef = useRef(null);
  const cropFrameRef = useRef(null);
  const cropPointersRef = useRef(new Map());
  const cropGestureRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isCropping, setIsCropping] = useState(false);
  const [isSavingCrop, setIsSavingCrop] = useState(false);
  const [aspectMode, setAspectMode] = useState('free');
  const [originalAspectRatio, setOriginalAspectRatio] = useState(4 / 5);
  const [cropView, setCropView] = useState({ scale: MIN_ZOOM, x: 0, y: 0 });
  const [cropError, setCropError] = useState('');
  const [musicNotice, setMusicNotice] = useState(false);
  const activeImage = images[activeIndex];
  const aspectRatio = aspectMode === 'free' ? originalAspectRatio : FIXED_ASPECT_RATIOS[aspectMode];

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      if (isCropping) setIsCropping(false);
      else onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      cropPointersRef.current.clear();
      cropGestureRef.current = null;
    };
  }, [open, isCropping]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setAspectMode('free');
      setIsCropping(true);
      setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
      setCropError('');
    }
  }, [open, images.length]);

  useEffect(() => {
    if (!activeImage?.dataUrl) return undefined;
    let cancelled = false;
    const source = new window.Image();
    source.onload = () => {
      if (!cancelled && source.naturalWidth > 0 && source.naturalHeight > 0) {
        setOriginalAspectRatio(source.naturalWidth / source.naturalHeight);
      }
    };
    source.src = activeImage.dataUrl;
    return () => { cancelled = true; };
  }, [activeImage?.dataUrl]);

  useEffect(() => {
    setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
    setCropError('');
  }, [activeIndex]);

  useEffect(() => {
    if (!musicNotice) return undefined;
    const timer = window.setTimeout(() => setMusicNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [musicNotice]);

  if (!open || images.length === 0 || !activeImage) return null;

  const handleScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const nextIndex = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    setActiveIndex(clamp(nextIndex, 0, images.length - 1));
  };

  const goToImage = index => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    setActiveIndex(index);
  };

  const beginCropping = () => {
    setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
    setCropError('');
    setIsCropping(true);
  };

  const selectAspectRatio = mode => {
    setAspectMode(mode);
    setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
  };

  const handleCropPointerDown = (event, corner = null) => {
    const frame = cropFrameRef.current;
    if (!frame) return;
    event.preventDefault();
    if (corner) event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    if (corner) {
      cropGestureRef.current = { type: 'resize', pointerId: event.pointerId, corner, startPoint: point, startView: cropView };
    } else {
      cropPointersRef.current.set(event.pointerId, point);
      const pointers = Array.from(cropPointersRef.current.values());
      if (pointers.length >= 2) {
        cropGestureRef.current = {
          type: 'pinch',
          startDistance: distanceBetween(pointers[0], pointers[1]),
          startView: cropView,
        };
      } else {
        cropGestureRef.current = { type: 'pan', pointerId: event.pointerId, startPoint: point, startView: cropView };
      }
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
  };

  const handleCropPointerMove = event => {
    const gesture = cropGestureRef.current;
    const frame = cropFrameRef.current;
    const imageElement = getImageElement(frame);
    if (!gesture || !frame) return;
    if (gesture.type !== 'resize') {
      if (!cropPointersRef.current.has(event.pointerId)) return;
      cropPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const frameBounds = frame.getBoundingClientRect();
    if (gesture.type === 'pinch') {
      const pointers = Array.from(cropPointersRef.current.values());
      if (pointers.length < 2) return;
      const scale = clamp(gesture.startView.scale * distanceBetween(pointers[0], pointers[1]) / Math.max(gesture.startDistance, 1), MIN_ZOOM, MAX_ZOOM);
      const bounds = getImageBounds(frame, imageElement, scale);
      setCropView({
        ...gesture.startView,
        scale,
        x: clamp(gesture.startView.x, -bounds.maxX, bounds.maxX),
        y: clamp(gesture.startView.y, -bounds.maxY, bounds.maxY),
      });
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startPoint.x;
    const deltaY = event.clientY - gesture.startPoint.y;
    if (gesture.type === 'resize') {
      const directionX = gesture.corner.includes('right') ? 1 : -1;
      const directionY = gesture.corner.includes('bottom') ? 1 : -1;
      const outwardDelta = (deltaX * directionX + deltaY * directionY) / 2;
      const scale = clamp(gesture.startView.scale - outwardDelta / Math.max(1, Math.min(frameBounds.width, frameBounds.height)) * 2, MIN_ZOOM, MAX_ZOOM);
      const bounds = getImageBounds(frame, imageElement, scale);
      setCropView({
        ...gesture.startView,
        scale,
        x: clamp(gesture.startView.x, -bounds.maxX, bounds.maxX),
        y: clamp(gesture.startView.y, -bounds.maxY, bounds.maxY),
      });
      return;
    }

    const bounds = getImageBounds(frame, imageElement, gesture.startView.scale);
    setCropView({
      ...gesture.startView,
      x: clamp(gesture.startView.x + deltaX, -bounds.maxX, bounds.maxX),
      y: clamp(gesture.startView.y + deltaY, -bounds.maxY, bounds.maxY),
    });
  };

  const endCropPointer = event => {
    const gesture = cropGestureRef.current;
    cropPointersRef.current.delete(event.pointerId);
    if (gesture?.type === 'pinch' && cropPointersRef.current.size === 1) {
      const [pointerId, point] = Array.from(cropPointersRef.current.entries())[0];
      cropGestureRef.current = { type: 'pan', pointerId, startPoint: point, startView: cropView };
    } else if (gesture?.pointerId === event.pointerId || cropPointersRef.current.size === 0) {
      cropGestureRef.current = null;
    }
  };

  const updateZoom = value => {
    const frame = cropFrameRef.current;
    const imageElement = getImageElement(frame);
    const scale = clamp(Number(value), MIN_ZOOM, MAX_ZOOM);
    const bounds = getImageBounds(frame, imageElement, scale);
    setCropView(current => ({
      scale,
      x: clamp(current.x, -bounds.maxX, bounds.maxX),
      y: clamp(current.y, -bounds.maxY, bounds.maxY),
    }));
  };

  const applyCrop = async () => {
    const frame = cropFrameRef.current;
    if (!activeImage || !frame || isSavingCrop) return;
    setIsSavingCrop(true);
    setCropError('');
    try {
      const croppedImage = await cropImage(activeImage, cropView, frame.getBoundingClientRect(), aspectRatio, aspectMode === 'free');
      onImagesChange(images.map((image, index) => index === activeIndex ? croppedImage : image));
      setIsCropping(false);
    } catch (error) {
      setCropError(error instanceof Error ? error.message : 'تعذر قص الصورة. حاول مرة أخرى.');
    } finally {
      setIsSavingCrop(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="معاينة الصور المختارة">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        {isCropping ? (
          <>
            <button type="button" onClick={() => { setIsCropping(false); setCropError(''); }} className="rounded-full px-4 py-2 text-sm text-white/75">إلغاء</button>
            <span className="text-sm font-semibold">قص الصورة</span>
            <button type="button" onClick={() => void applyCrop()} disabled={isSavingCrop} className="flex min-w-20 items-center justify-center gap-1 rounded-full bg-[#f1a17f] px-4 py-2 text-sm font-bold text-black disabled:opacity-60">
              <Check size={17} /> {isSavingCrop ? 'جارٍ الحفظ' : 'تم'}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} aria-label="إغلاق معاينة الصور" className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10">
              <X size={23} />
            </button>
            <span className="text-sm font-semibold text-white/70">{images.length > 1 ? `${activeIndex + 1} من ${images.length}` : 'معاينة الصور'}</span>
            <button type="button" onClick={onNext} className="rounded-full bg-[#f1a17f] px-6 py-2.5 text-base font-bold text-black transition active:scale-95">التالي</button>
          </>
        )}
      </header>

      <div className={`relative flex min-h-0 flex-1 flex-col items-center justify-center ${isCropping ? 'pb-44' : 'pb-28'}`}>
        <div
          ref={trackRef}
          onScroll={handleScroll}
          dir="ltr"
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden no-scrollbar"
          style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}
        >
          {images.map((image, index) => (
            <div key={`${image.file.name}-${image.file.lastModified}-${index}`} className="flex h-full w-full shrink-0 snap-center items-center justify-center px-4">
              <div
                ref={index === activeIndex ? cropFrameRef : null}
                className="relative h-full max-h-full w-auto max-w-full shrink-0 overflow-hidden rounded-xl bg-black"
                onPointerDown={isCropping && index === activeIndex ? handleCropPointerDown : undefined}
                onPointerMove={isCropping && index === activeIndex ? handleCropPointerMove : undefined}
                onPointerUp={isCropping && index === activeIndex ? endCropPointer : undefined}
                onPointerCancel={isCropping && index === activeIndex ? endCropPointer : undefined}
                aria-label={isCropping && index === activeIndex ? 'حرّك الصورة داخل إطار المنشور' : undefined}
                style={{
                  aspectRatio: String(aspectRatio),
                  touchAction: isCropping && index === activeIndex ? 'none' : 'pan-x',
                }}
              >
                <img
                  src={image.dataUrl}
                  alt={`الصورة ${index + 1}`}
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                  style={isCropping && index === activeIndex
                    ? { transform: `translate3d(${cropView.x}px, ${cropView.y}px, 0) scale(${cropView.scale})`, transformOrigin: 'center' }
                    : undefined}
                />
                {isCropping && index === activeIndex && (
                  <div className="pointer-events-none absolute inset-0 border border-white/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]">
                    <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
                      {[0, 1, 2].map(line => <span key={`v-${line}`} className="border-l border-white/25 first:border-l-0" />)}
                      {[1, 2].map(line => <span key={`h-${line}`} className="absolute inset-x-0 border-t border-white/25" style={{ top: `${(line * 100) / 3}%` }} />)}
                    </div>
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
                        onPointerDown={event => handleCropPointerDown(event, corner)}
                        onPointerMove={handleCropPointerMove}
                        onPointerUp={endCropPointer}
                        onPointerCancel={endCropPointer}
                        className={`pointer-events-auto absolute z-10 h-5 w-5 rounded-full border-2 border-black bg-white shadow ${position}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {cropError && <p role="alert" className="absolute bottom-3 left-4 right-4 text-center text-sm text-rose-300">{cropError}</p>}

        {!isCropping && images.length > 1 && (
          <div className="absolute bottom-20 flex items-center justify-center gap-2" dir="ltr" aria-label="التنقل بين الصور">
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`عرض الصورة ${index + 1}`}
                aria-current={index === activeIndex ? 'true' : undefined}
                onClick={() => goToImage(index)}
                className={`h-2 rounded-full transition-all ${index === activeIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}`}
              />
            ))}
          </div>
        )}
      </div>

      {!isCropping ? (
        <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-[#242326]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
          <button type="button" onClick={() => setMusicNotice(true)} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-[#f1a17f] transition hover:bg-white/5">
            <Music2 size={24} />
            <span className="text-xs font-medium">موسيقى</span>
          </button>
          <button type="button" onClick={beginCropping} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-white/85 transition hover:bg-white/5">
            <Crop size={24} />
            <span className="text-xs font-medium">قص</span>
          </button>
        </div>
      ) : (
        <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex w-[min(94vw,390px)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-[#242326]/95 px-3 py-3 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-1" role="group" aria-label="نسبة أبعاد الصورة" dir="rtl">
            {ASPECT_RATIOS.map(preset => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={aspectMode === preset.key}
                onClick={() => selectAspectRatio(preset.key)}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${aspectMode === preset.key ? 'bg-[#f1a17f] text-black' : 'bg-white/10 text-white/75 hover:bg-white/15'}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3" dir="ltr">
            <button type="button" onClick={() => updateZoom(cropView.scale - 0.2)} aria-label="تصغير الصورة" disabled={cropView.scale <= MIN_ZOOM} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white disabled:opacity-40">
              <Minus size={18} />
            </button>
            <input
              type="range"
              aria-label="تكبير الصورة داخل إطار المنشور"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step="0.01"
              value={cropView.scale}
              onChange={event => updateZoom(event.currentTarget.value)}
              className="min-w-0 flex-1 accent-[#f1a17f]"
            />
            <button type="button" onClick={() => updateZoom(cropView.scale + 0.2)} aria-label="تكبير الصورة" disabled={cropView.scale >= MAX_ZOOM} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white disabled:opacity-40">
              <Plus size={18} />
            </button>
          </div>
        </div>
      )}

      {musicNotice && !isCropping && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
