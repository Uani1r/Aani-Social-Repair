import { useEffect, useRef, useState } from 'react';
import { Minus, Music2, Plus, X } from 'lucide-react';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
// القياس الطولي القياسي لإنستغرام: 4:5 (الناتج 1080x1350)
const ASPECT_RATIO = 4 / 5;
const OUTPUT_WIDTH = 1080;
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

// القص إلى 4:5 (1080x1350) وفق موضع الصورة وتكبيرها داخل الإطار
async function cropImage(image, view, frameBounds) {
  const source = new window.Image();
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error('تعذر تحميل الصورة للقص.'));
    source.src = image.dataUrl;
  });

  const coverScale = Math.max(frameBounds.width / source.naturalWidth, frameBounds.height / source.naturalHeight);
  const renderedScale = coverScale * view.scale;
  const sourceWidth = Math.min(source.naturalWidth, frameBounds.width / renderedScale);
  const sourceHeight = Math.min(source.naturalHeight, frameBounds.height / renderedScale);
  const sourceX = clamp((source.naturalWidth - sourceWidth) / 2 - view.x / renderedScale, 0, source.naturalWidth - sourceWidth);
  const sourceY = clamp((source.naturalHeight - sourceHeight) / 2 - view.y / renderedScale, 0, source.naturalHeight - sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = Math.round(OUTPUT_WIDTH / ASPECT_RATIO);

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

// شاشة المعاينة الأولى: القص والتكبير والسحب مدموجان داخلها بإطار 4:5،
// وعند الضغط على «التالي» تُقص جميع الصور جاهزة دون أي شاشة قص إضافية.
export default function ImagePreviewModal({ open, images, onImagesChange, onClose, onNext }) {
  const trackRef = useRef(null);
  const cropFrameRef = useRef(null);
  const cropPointersRef = useRef(new Map());
  const cropGestureRef = useRef(null);
  const cropViewsRef = useRef(new Map());
  const onCloseRef = useRef(onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cropView, setCropView] = useState({ scale: MIN_ZOOM, x: 0, y: 0 });
  const [cropError, setCropError] = useState('');
  const [isFinishing, setIsFinishing] = useState(false);
  const [musicNotice, setMusicNotice] = useState(false);
  const activeImage = images[activeIndex];

  const updateCropView = (index, view) => {
    cropViewsRef.current.set(index, view);
    if (index === activeIndex) setCropView(view);
  };

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      cropPointersRef.current.clear();
      cropGestureRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      cropViewsRef.current.clear();
      setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
      setCropError('');
    }
  }, [open, images.length]);

  // استرجاع ضبط الصورة عند التنقل بين الصور، أو البدء من الوسط
  useEffect(() => {
    setCropView(cropViewsRef.current.get(activeIndex) || { scale: MIN_ZOOM, x: 0, y: 0 });
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
      updateCropView(activeIndex, {
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
      // مقابض الزوايا: تقريب/إبعاد الصورة داخل الإطار الثابت 4:5
      const directionX = gesture.corner.includes('right') ? 1 : -1;
      const directionY = gesture.corner.includes('bottom') ? 1 : -1;
      const outwardDelta = (deltaX * directionX + deltaY * directionY) / 2;
      const scale = clamp(gesture.startView.scale - outwardDelta / Math.max(1, Math.min(frameBounds.width, frameBounds.height)) * 2, MIN_ZOOM, MAX_ZOOM);
      const bounds = getImageBounds(frame, imageElement, scale);
      updateCropView(activeIndex, {
        ...gesture.startView,
        scale,
        x: clamp(gesture.startView.x, -bounds.maxX, bounds.maxX),
        y: clamp(gesture.startView.y, -bounds.maxY, bounds.maxY),
      });
      return;
    }

    const bounds = getImageBounds(frame, imageElement, gesture.startView.scale);
    updateCropView(activeIndex, {
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
    updateCropView(activeIndex, {
      ...cropView,
      scale,
      x: clamp(cropView.x, -bounds.maxX, bounds.maxX),
      y: clamp(cropView.y, -bounds.maxY, bounds.maxY),
    });
  };

  // «التالي»: قص جميع الصور على 4:5 (1080x1350) وفق الضبط الحالي لكل صورة
  const finishAndNext = async () => {
    const frame = cropFrameRef.current;
    if (!activeImage || !frame || isFinishing) return;
    setIsFinishing(true);
    setCropError('');
    try {
      const frameBounds = frame.getBoundingClientRect();
      const croppedImages = [];
      for (let index = 0; index < images.length; index++) {
        const view = cropViewsRef.current.get(index) || { scale: MIN_ZOOM, x: 0, y: 0 };
        croppedImages.push(await cropImage(images[index], view, frameBounds));
      }
      onImagesChange(croppedImages);
      onNext();
    } catch (error) {
      setCropError(error instanceof Error ? error.message : 'تعذر تجهيز الصور. حاول مرة أخرى.');
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="معاينة الصور المختارة">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onClose} aria-label="إغلاق معاينة الصور" className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10">
          <X size={23} />
        </button>
        <span className="text-sm font-semibold text-white/70">{images.length > 1 ? `${activeIndex + 1} من ${images.length}` : 'معاينة الصور'}</span>
        <button type="button" onClick={() => void finishAndNext()} disabled={isFinishing} className="flex min-w-24 items-center justify-center rounded-full bg-[#f1a17f] px-6 py-2.5 text-base font-bold text-black transition active:scale-95 disabled:opacity-60">
          {isFinishing ? 'جارٍ التجهيز...' : 'التالي'}
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center pb-44">
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
                onPointerDown={index === activeIndex ? handleCropPointerDown : undefined}
                onPointerMove={index === activeIndex ? handleCropPointerMove : undefined}
                onPointerUp={index === activeIndex ? endCropPointer : undefined}
                onPointerCancel={index === activeIndex ? endCropPointer : undefined}
                aria-label="حرّك الصورة داخل إطار 4:5 واضبط القص"
                style={{ aspectRatio: String(ASPECT_RATIO), touchAction: 'none' }}
              >
                <img
                  src={image.dataUrl}
                  alt={`الصورة ${index + 1}`}
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                  style={index === activeIndex
                    ? { transform: `translate3d(${cropView.x}px, ${cropView.y}px, 0) scale(${cropView.scale})`, transformOrigin: 'center' }
                    : undefined}
                />
                {index === activeIndex && (
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
                        aria-label={`ضبط الصورة من الزاوية ${corner}`}
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

        {images.length > 1 && (
          <div className="absolute bottom-36 flex items-center justify-center gap-2" dir="ltr" aria-label="التنقل بين الصور">
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

      <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex w-[min(94vw,390px)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-[#242326]/95 px-3 py-3 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3" dir="rtl">
          <button type="button" onClick={() => setMusicNotice(true)} className="flex min-w-20 flex-col items-center gap-1 rounded-full px-3 py-1 text-[#f1a17f] transition hover:bg-white/5">
            <Music2 size={22} />
            <span className="text-[11px] font-medium">موسيقى</span>
          </button>
          <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80">
            <span className="grid h-6 w-5 place-items-center rounded border border-white/40 text-[9px] font-bold">4:5</span>
            القياس القياسي
          </span>
        </div>
        <div className="flex items-center gap-3" dir="ltr">
          <button type="button" onClick={() => updateZoom(cropView.scale - 0.2)} aria-label="تصغير الصورة" disabled={cropView.scale <= MIN_ZOOM} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white disabled:opacity-40">
            <Minus size={18} />
          </button>
          <input
            type="range"
            aria-label="تكبير الصورة داخل إطار 4:5"
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

      {musicNotice && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(9rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
