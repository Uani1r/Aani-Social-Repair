import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';

type Point = { x: number; y: number };
type CropTransform = { scale: number; x: number; y: number };
type CropGesture = {
  mode: 'pan' | 'pinch';
  pointerIds: number[];
  startPoint: Point;
  startDistance: number;
  startCenter: Point;
  startTransform: CropTransform;
};

type HighlightCoverCropperProps = {
  file: File;
  onCancel: () => void;
  onSave: (file: File) => void;
  title?: string;
  outputSuffix?: string;
};

const CROP_DIAMETER = 208;
const CROP_RADIUS = CROP_DIAMETER / 2;
const MIN_SCALE = 1;
const MAX_SCALE = 3.5;
const OUTPUT_SIZE = 640;

function getDistance(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getCenter(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function HighlightCoverCropper({ file, onCancel, onSave, title = 'تعديل غلاف أبرز القصص', outputSuffix = '-cover' }: HighlightCoverCropperProps) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<CropGesture | null>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<CropTransform>({ scale: MIN_SCALE, x: 0, y: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const baseScale = imageSize.width && imageSize.height
    ? Math.max(CROP_DIAMETER / imageSize.width, CROP_DIAMETER / imageSize.height)
    : 1;
  const renderedWidth = imageSize.width * baseScale * transform.scale;
  const renderedHeight = imageSize.height * baseScale * transform.scale;
  const maxOffsetX = Math.max(0, (renderedWidth - CROP_DIAMETER) / 2);
  const maxOffsetY = Math.max(0, (renderedHeight - CROP_DIAMETER) / 2);
  const boundedTransform = {
    ...transform,
    x: clamp(transform.x, -maxOffsetX, maxOffsetX),
    y: clamp(transform.y, -maxOffsetY, maxOffsetY),
  };
  const imageStyle = {
    width: imageSize.width ? `${imageSize.width * baseScale}px` : 'auto',
    height: imageSize.height ? `${imageSize.height * baseScale}px` : 'auto',
    transform: `translate(calc(-50% + ${boundedTransform.x}px), calc(-50% + ${boundedTransform.y}px)) scale(${boundedTransform.scale})`,
  };

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageSize.width || !imageSize.height) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointerIds = [...pointersRef.current.keys()];
    if (pointerIds.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        pointerIds,
        startPoint: { x: event.clientX, y: event.clientY },
        startDistance: 0,
        startCenter: { x: event.clientX, y: event.clientY },
        startTransform: boundedTransform,
      };
      return;
    }

    const first = pointersRef.current.get(pointerIds[0]);
    const second = pointersRef.current.get(pointerIds[1]);
    if (!first || !second) return;
    gestureRef.current = {
      mode: 'pinch',
      pointerIds: pointerIds.slice(0, 2),
      startPoint: { x: event.clientX, y: event.clientY },
      startDistance: Math.max(1, getDistance(first, second)),
      startCenter: getCenter(first, second),
      startTransform: boundedTransform,
    };
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === 'pan') {
      const nextX = gesture.startTransform.x + event.clientX - gesture.startPoint.x;
      const nextY = gesture.startTransform.y + event.clientY - gesture.startPoint.y;
      setTransform({
        ...gesture.startTransform,
        x: clamp(nextX, -maxOffsetX, maxOffsetX),
        y: clamp(nextY, -maxOffsetY, maxOffsetY),
      });
      return;
    }

    const first = pointersRef.current.get(gesture.pointerIds[0]);
    const second = pointersRef.current.get(gesture.pointerIds[1]);
    if (!first || !second) return;
    const nextScale = clamp(
      gesture.startTransform.scale * getDistance(first, second) / gesture.startDistance,
      MIN_SCALE,
      MAX_SCALE,
    );
    const nextCenter = getCenter(first, second);
    const scaleRatio = nextScale / gesture.startTransform.scale;
    const nextX = nextCenter.x - viewport.width / 2
      + scaleRatio * (viewport.width / 2 + gesture.startTransform.x - gesture.startCenter.x);
    const nextY = nextCenter.y - viewport.height / 2
      + scaleRatio * (viewport.height / 2 + gesture.startTransform.y - gesture.startCenter.y);
    const scaledWidth = imageSize.width * baseScale * nextScale;
    const scaledHeight = imageSize.height * baseScale * nextScale;
    setTransform({
      scale: nextScale,
      x: clamp(nextX, -Math.max(0, (scaledWidth - CROP_DIAMETER) / 2), Math.max(0, (scaledWidth - CROP_DIAMETER) / 2)),
      y: clamp(nextY, -Math.max(0, (scaledHeight - CROP_DIAMETER) / 2), Math.max(0, (scaledHeight - CROP_DIAMETER) / 2)),
    });
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const remaining = [...pointersRef.current.entries()];
    if (remaining.length === 0) {
      gestureRef.current = null;
      return;
    }
    const [pointerId, point] = remaining[0];
    gestureRef.current = {
      mode: 'pan',
      pointerIds: [pointerId],
      startPoint: point,
      startDistance: 0,
      startCenter: point,
      startTransform: boundedTransform,
    };
  };

  const saveCrop = async () => {
    const image = imageRef.current;
    if (saving || !image || !imageSize.width || !imageSize.height) return;
    setSaving(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة.');

      const imageScale = baseScale * boundedTransform.scale;
      const sourceSize = CROP_DIAMETER / imageScale;
      const sourceX = clamp(imageSize.width / 2 - (CROP_RADIUS + boundedTransform.x) / imageScale, 0, imageSize.width - sourceSize);
      const sourceY = clamp(imageSize.height / 2 - (CROP_RADIUS + boundedTransform.y) / imageScale, 0, imageSize.height - sourceSize);
      context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

      const blob = await new Promise<Blob>((resolve, reject) => {
        // JPEG بدل PNG: الناتج أصغر بكثير (يُعاد ضغطه لاحقاً عبر إعداد avatar)
        canvas.toBlob(value => value ? resolve(value) : reject(new Error('تعذر تصدير الصورة.')), 'image/jpeg', 0.9);
      });
      const baseName = file.name.replace(/\.[^.]+$/, '') || (outputSuffix === '-avatar' ? 'profile-avatar' : 'highlight-cover');
      onSave(new File([blob], `${baseName}${outputSuffix}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
    } catch (error) {
      console.error('[image cropper] تعذر اقتصاص الصورة:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ الصورة.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2140] flex h-[100dvh] w-screen flex-col overflow-hidden bg-black/80 text-white backdrop-blur-md" dir="rtl" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="absolute inset-0 touch-none"
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        style={{ touchAction: 'none' }}
      >
        <img
          ref={imageRef}
          src={previewUrl}
          alt=""
          draggable={false}
          onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none will-change-transform"
          style={imageStyle}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(circle ${CROP_RADIUS}px at 50% 50%, transparent ${CROP_RADIUS - 1}px, rgba(0,0,0,0.68) ${CROP_RADIUS}px, rgba(0,0,0,0.68) 100%)` }}
        />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-52 w-52 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/60 shadow-2xl" />
      </div>

      <header className="pointer-events-none relative z-10 flex items-center justify-between px-4" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <button type="button" onClick={onCancel} disabled={saving} aria-label="إلغاء الاقتصاص" className="pointer-events-auto grid h-10 w-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md disabled:opacity-50"><X size={21} /></button>
        <h2 className="rounded-full bg-black/40 px-4 py-2 text-sm font-bold backdrop-blur-md">{title}</h2>
        <span className="h-10 w-10" aria-hidden="true" />
      </header>

      <div className="pointer-events-none relative z-10 mt-auto flex flex-col items-center gap-4 px-5" style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}>
        <p className="rounded-full bg-black/45 px-3 py-1.5 text-center text-xs text-white/80 backdrop-blur-md">اسحب بإصبعك للتحريك، واستخدم إصبعين للتكبير والتصغير</p>
        <div className="pointer-events-auto flex w-full max-w-sm gap-3">
          <button type="button" onClick={onCancel} disabled={saving} className="min-h-12 flex-1 rounded-full border border-white/25 bg-black/50 text-sm font-bold text-white backdrop-blur-md disabled:opacity-50">إلغاء</button>
          <button type="button" onClick={() => void saveCrop()} disabled={saving || !imageSize.width} className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[#1D9BF0] text-sm font-black text-white transition hover:bg-[#1686d4] disabled:opacity-50">
            <Check size={18} />{saving ? 'جارٍ تجهيز الصورة...' : 'تم'}
          </button>
        </div>
      </div>
    </div>
  );
}
