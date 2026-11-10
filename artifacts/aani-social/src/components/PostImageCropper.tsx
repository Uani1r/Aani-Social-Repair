import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Crop, X } from 'lucide-react';

type Point = { x: number; y: number };

const MAX_ZOOM = 4;
const OUTPUT_MAX_DIMENSION = 1440;
const ASPECT_CHOICES = [
  { value: 4 / 5, label: 'طولي 4:5' },
  { value: 1, label: 'مربع 1:1' },
] as const;

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

// أداة قص الصور الإجبارية قبل النشر: تفرض مقاس إنستغرام (4:5 أو 1:1)
// وتقطع الصورة إلى الملف النهائي عبر canvas قبل الرفع.
export default function PostImageCropper({ file, onCancelAll, onConfirm }: {
  file: File;
  onCancelAll: () => void;
  onConfirm: (croppedFile: File) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState<number>(4 / 5);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const pointerPointersRef = useRef(new Map<number, Point>());
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const dragLastRef = useRef<Point | null>(null);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateStageSize = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width && bounds.height) {
        setStageSize(current => current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height });
      }
    };
    updateStageSize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateStageSize) : null;
    observer?.observe(stage);
    window.addEventListener('resize', updateStageSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateStageSize);
    };
  }, []);

  const aspectValue = imageSize.width && imageSize.height ? aspect : 1;
  const frameWidth = Math.max(1, Math.min(stageSize.width - 32, (stageSize.height - 260) * aspectValue));
  const frameHeight = Math.max(1, frameWidth / aspectValue);

  const baseScale = imageSize.width && imageSize.height
    ? Math.max(frameWidth / imageSize.width, frameHeight / imageSize.height)
    : 1;
  const displayedWidth = imageSize.width * baseScale * zoom;
  const displayedHeight = imageSize.height * baseScale * zoom;

  const clampOffset = (nextZoom: number, offsetCandidate: Point): Point => {
    const scale = baseScale * nextZoom;
    const width = imageSize.width * scale;
    const height = imageSize.height * scale;
    const minX = Math.min(0, (frameWidth - width) / 2);
    const maxX = Math.max(0, (frameWidth - width) / 2);
    const minY = Math.min(0, (frameHeight - height) / 2);
    const maxY = Math.max(0, (frameHeight - height) / 2);
    return {
      x: Math.min(maxX, Math.max(minX, offsetCandidate.x)),
      y: Math.min(maxY, Math.max(minY, offsetCandidate.y)),
    };
  };

  const changeZoom = (nextZoom: number, anchor?: Point) => {
    const clampedZoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    if (!anchor) {
      setZoom(clampedZoom);
      setOffset(current => clampOffset(clampedZoom, current));
      return;
    }
    // إبقاء النقطة تحت الإصبع ثابتة أثناء التقريب
    setZoom(current => {
      const ratio = clampedZoom / current;
      setOffset(currentOffset => clampOffset(clampedZoom, {
        x: anchor.x + (currentOffset.x - anchor.x) * ratio,
        y: anchor.y + (currentOffset.y - anchor.y) * ratio,
      }));
      return clampedZoom;
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointerPointersRef.current.size === 1) {
      dragLastRef.current = { x: event.clientX, y: event.clientY };
    } else if (pointerPointersRef.current.size === 2) {
      const pair = Array.from(pointerPointersRef.current.values()).slice(0, 2);
      pinchStartRef.current = { distance: distanceBetween(pair[0], pair[1]), zoom };
      dragLastRef.current = null;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointerPointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size >= 2) {
      const pair = Array.from(pointers.values()).slice(0, 2);
      const pinchStart = pinchStartRef.current;
      if (pinchStart) {
        changeZoom(pinchStart.zoom * distanceBetween(pair[0], pair[1]) / Math.max(pinchStart.distance, 1));
      }
      return;
    }

    const dragLast = dragLastRef.current;
    if (!dragLast) return;
    const deltaX = event.clientX - dragLast.x;
    const deltaY = event.clientY - dragLast.y;
    dragLastRef.current = { x: event.clientX, y: event.clientY };
    setOffset(current => clampOffset(zoom, { x: current.x + deltaX, y: current.y + deltaY }));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerPointersRef.current.delete(event.pointerId);
    if (pointerPointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointerPointersRef.current.size === 0) dragLastRef.current = null;
    else dragLastRef.current = Array.from(pointerPointersRef.current.values())[0] || null;
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    changeZoom(
      zoom * (event.deltaY < 0 ? 1.08 : 0.93),
      { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 },
    );
  };

  const confirmCrop = async () => {
    if (saving || !imageSize.width || !imageSize.height) return;
    setSaving(true);
    try {
      const scale = baseScale * zoom;
      const sourceWidth = frameWidth / scale;
      const sourceHeight = frameHeight / scale;
      const sourceX = (imageSize.width - sourceWidth) / 2 - offset.x / scale;
      const sourceY = (imageSize.height - sourceHeight) / 2 - offset.y / scale;

      const outputWidth = Math.min(OUTPUT_MAX_DIMENSION, Math.round(sourceWidth));
      const outputHeight = Math.max(1, Math.round(outputWidth / aspectValue));
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة المقصوصة.');

      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      });
      image.src = previewUrl;
      await imageLoaded;

      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error('تعذر تجهيز الصورة المقصوصة.')), 'image/jpeg', 0.92);
      });
      onConfirm(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-cropped.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      }));
    } catch (error) {
      console.error('[create-post] تعذر قص الصورة:', error);
      window.alert(error instanceof Error ? error.message : 'تعذر قص الصورة. حاول مجدداً.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex flex-col bg-black/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="قص الصورة" dir="rtl">
      <header className="flex items-center justify-between px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <span className="flex items-center gap-2 text-sm font-bold text-white"><Crop size={18} /> قص الصورة</span>
        <button
          type="button"
          aria-label="إلغاء النشر"
          onClick={onCancelAll}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X size={20} />
        </button>
      </header>

      <p className="px-4 pb-2 text-center text-xs text-zinc-400">اضبط الصورة داخل الإطار قبل النشر — القص إجباري بنمط إنستغرام.</p>

      <div ref={stageRef} className="flex min-h-0 flex-1 items-center justify-center">
        <div
          className="relative touch-none select-none overflow-hidden rounded-xl border border-white/25 bg-black"
          style={{ width: frameWidth, height: frameHeight, touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onWheel={onWheel}
        >
          <img
            src={previewUrl}
            alt=""
            draggable={false}
            onDragStart={event => event.preventDefault()}
            onLoad={event => {
              setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: displayedWidth || '100%',
              height: displayedHeight || '100%',
              transform: `translate(-50%, -50%) translate3d(${offset.x}px, ${offset.y}px, 0)`,
            }}
          />
          <div className="pointer-events-none absolute inset-0 grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr' }} aria-hidden="true">
            {[...Array(9)].map((_, index) => <span key={index} className="border border-white/15" />)}
          </div>
        </div>
      </div>

      <footer className="space-y-3 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="مقاس الصورة">
          {ASPECT_CHOICES.map(choice => (
            <button
              key={choice.label}
              type="button"
              aria-pressed={aspect === choice.value}
              onClick={() => {
                setAspect(choice.value);
                setOffset(current => clampOffset(zoom, current));
              }}
              className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${aspect === choice.value ? 'border-pink-400/60 bg-pink-500/15 text-white' : 'border-white/15 bg-black/30 text-white/60 hover:bg-white/[0.08]'}`}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void confirmCrop()}
          disabled={saving || !imageSize.width}
          className="w-full rounded-full bg-white px-6 py-3 text-base font-bold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'جارٍ القص...' : 'تأكيد القص'}
        </button>
      </footer>
    </div>
  );
}
