import React, { useEffect, useRef, useState } from 'react';
import { Check, Crop, Music2, X } from 'lucide-react';

const INITIAL_CROP = { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
const MIN_CROP_EDGE = 0.18;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر تجهيز الصورة.'));
  reader.onerror = () => reject(reader.error || new Error('تعذر تجهيز الصورة.'));
  reader.readAsDataURL(blob);
});

async function cropImage(image, crop) {
  const source = new window.Image();
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error('تعذر تحميل الصورة للقص.'));
    source.src = image.dataUrl;
  });

  const sx = clamp(Math.floor(crop.x * source.naturalWidth), 0, source.naturalWidth - 1);
  const sy = clamp(Math.floor(crop.y * source.naturalHeight), 0, source.naturalHeight - 1);
  const sw = Math.max(1, Math.min(source.naturalWidth - sx, Math.round(crop.width * source.naturalWidth)));
  const sh = Math.max(1, Math.min(source.naturalHeight - sy, Math.round(crop.height * source.naturalHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر تجهيز مساحة القص.');
  context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);

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
  const cropDragRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isCropping, setIsCropping] = useState(false);
  const [isSavingCrop, setIsSavingCrop] = useState(false);
  const [cropRect, setCropRect] = useState(INITIAL_CROP);
  const [cropError, setCropError] = useState('');
  const [musicNotice, setMusicNotice] = useState(false);
  const activeImage = images[activeIndex];

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      if (isCropping) setIsCropping(false);
      else onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      cropDragRef.current = null;
    };
  }, [open, isCropping]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setIsCropping(false);
      setCropRect(INITIAL_CROP);
      setCropError('');
    }
  }, [open, images.length]);

  useEffect(() => {
    setCropRect(INITIAL_CROP);
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
    setCropRect(INITIAL_CROP);
    setCropError('');
    setIsCropping(true);
  };

  const handleCropPointerDown = event => {
    const frame = cropFrameRef.current;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    const handle = event.target instanceof HTMLElement
      ? event.target.closest('[data-crop-handle]')?.getAttribute('data-crop-handle')
      : null;
    cropDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bounds,
      startRect: cropRect,
      mode: handle || 'move',
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleCropPointerMove = event => {
    const drag = cropDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = (event.clientX - drag.startClientX) / Math.max(drag.bounds.width, 1);
    const dy = (event.clientY - drag.startClientY) / Math.max(drag.bounds.height, 1);
    const start = drag.startRect;
    const right = start.x + start.width;
    const bottom = start.y + start.height;
    let next = start;

    if (drag.mode === 'move') {
      next = {
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height),
      };
    } else if (drag.mode === 'nw') {
      const x = clamp(start.x + dx, 0, right - MIN_CROP_EDGE);
      const y = clamp(start.y + dy, 0, bottom - MIN_CROP_EDGE);
      next = { x, y, width: right - x, height: bottom - y };
    } else if (drag.mode === 'ne') {
      const y = clamp(start.y + dy, 0, bottom - MIN_CROP_EDGE);
      const nextRight = clamp(right + dx, start.x + MIN_CROP_EDGE, 1);
      next = { x: start.x, y, width: nextRight - start.x, height: bottom - y };
    } else if (drag.mode === 'sw') {
      const x = clamp(start.x + dx, 0, right - MIN_CROP_EDGE);
      const nextBottom = clamp(bottom + dy, start.y + MIN_CROP_EDGE, 1);
      next = { x, y: start.y, width: right - x, height: nextBottom - start.y };
    } else if (drag.mode === 'se') {
      const nextRight = clamp(right + dx, start.x + MIN_CROP_EDGE, 1);
      const nextBottom = clamp(bottom + dy, start.y + MIN_CROP_EDGE, 1);
      next = { x: start.x, y: start.y, width: nextRight - start.x, height: nextBottom - start.y };
    }

    setCropRect(next);
  };

  const endCropPointer = event => {
    if (cropDragRef.current?.pointerId === event.pointerId) cropDragRef.current = null;
  };

  const applyCrop = async () => {
    if (!activeImage || isSavingCrop) return;
    setIsSavingCrop(true);
    setCropError('');
    try {
      const croppedImage = await cropImage(activeImage, cropRect);
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

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center pb-28">
        <div
          ref={trackRef}
          onScroll={handleScroll}
          dir="ltr"
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden no-scrollbar"
          style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}
        >
          {images.map((image, index) => (
            <div key={`${image.file.name}-${image.file.lastModified}-${index}`} className="flex h-full w-full shrink-0 snap-center items-center justify-center px-4">
              <div ref={index === activeIndex ? cropFrameRef : null} className="relative flex max-h-full max-w-full items-center justify-center">
                <img
                  src={image.dataUrl}
                  alt={`الصورة ${index + 1}`}
                  draggable={false}
                  className="max-h-[calc(100dvh_-_230px)] max-w-[calc(100vw_-_32px)] select-none object-contain"
                  style={{ touchAction: isCropping && index === activeIndex ? 'none' : 'pan-x' }}
                />
                {isCropping && index === activeIndex && (
                  <div
                    className="absolute inset-0 z-10"
                    onPointerDown={handleCropPointerDown}
                    onPointerMove={handleCropPointerMove}
                    onPointerUp={endCropPointer}
                    onPointerCancel={endCropPointer}
                    style={{ touchAction: 'none' }}
                  >
                    <div
                      className="absolute border border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]"
                      style={{ left: `${cropRect.x * 100}%`, top: `${cropRect.y * 100}%`, width: `${cropRect.width * 100}%`, height: `${cropRect.height * 100}%`, touchAction: 'none' }}
                    >
                      <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                        {[0, 1, 2].map(index => <span key={`v-${index}`} className="border-l border-white/30 first:border-l-0" />)}
                        {[1, 2].map(index => <span key={`h-${index}`} className="absolute inset-x-0 border-t border-white/30" style={{ top: `${(index * 100) / 3}%` }} />)}
                      </div>
                      <span data-crop-handle="nw" className="absolute -left-2 -top-2 h-4 w-4 rounded-full border-2 border-white bg-[#f1a17f]" />
                      <span data-crop-handle="ne" className="absolute -right-2 -top-2 h-4 w-4 rounded-full border-2 border-white bg-[#f1a17f]" />
                      <span data-crop-handle="sw" className="absolute -bottom-2 -left-2 h-4 w-4 rounded-full border-2 border-white bg-[#f1a17f]" />
                      <span data-crop-handle="se" className="absolute -bottom-2 -right-2 h-4 w-4 rounded-full border-2 border-white bg-[#f1a17f]" />
                    </div>
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

      {!isCropping && (
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
      )}

      {musicNotice && !isCropping && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
