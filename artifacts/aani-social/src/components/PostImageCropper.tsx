import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Crop, X } from 'lucide-react';

type Point = { x: number; y: number };
type CropFrame = { x: number; y: number; size: number };

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
const MIN_FRAME_SIZE = 96;
const OUTPUT_MAX_DIMENSION = 1440;
const FRAME_MARGIN = 8;
const HANDLE_SIZE = 22;

// أداة قص الصور الإجبارية قبل النشر: قالب مربع 1:1 افتراضي مع
// سحب وتكبير للصورة ومقابض في زوايا الإطار لضبط منطقة الاقتصاص.
export default function PostImageCropper({ file, onCancelAll, onConfirm }: {
  file: File;
  onCancelAll: () => void;
  onConfirm: (croppedFile: File) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [frame, setFrame] = useState<CropFrame | null>(null);
  const [saving, setSaving] = useState(false);

  const pointersRef = useRef(new Map<number, Point>());
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const panLastRef = useRef<Point | null>(null);
  const resizeRef = useRef<{ handle: string; anchor: Point } | null>(null);

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

  // الصورة تُعرض كاملة داخل المسرح (contain) وتتحرك خلف الإطار المربع
  const fitScale = imageSize.width && imageSize.height
    ? Math.min(stageSize.width / imageSize.width, stageSize.height / imageSize.height)
    : 1;

  // الإطار الافتراضي: أكبر مربع ممكن داخل الصورة المعروضة (قالب 1:1)
  useLayoutEffect(() => {
    if (!imageSize.width || !imageSize.height) return;
    const displayedWidth = imageSize.width * fitScale;
    const displayedHeight = imageSize.height * fitScale;
    const size = Math.min(displayedWidth, displayedHeight, stageSize.width - FRAME_MARGIN * 2, stageSize.height - FRAME_MARGIN * 2);
    setFrame({
      size,
      x: stageSize.width / 2 - size / 2,
      y: stageSize.height / 2 - size / 2,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSize.width, imageSize.height]);

  const clampFrame = (candidate: CropFrame): CropFrame => {
    const maxSize = Math.max(MIN_FRAME_SIZE, Math.min(stageSize.width, stageSize.height) - FRAME_MARGIN * 2);
    const size = Math.min(maxSize, Math.max(MIN_FRAME_SIZE, candidate.size));
    return {
      size,
      x: Math.min(Math.max(FRAME_MARGIN, candidate.x), Math.max(FRAME_MARGIN, stageSize.width - size - FRAME_MARGIN)),
      y: Math.min(Math.max(FRAME_MARGIN, candidate.y), Math.max(FRAME_MARGIN, stageSize.height - size - FRAME_MARGIN)),
    };
  };

  // منع ظهور فراغ داخل الإطار: الصورة يجب أن تغطيه بالكامل
  const clampOffsetForFrame = (offsetCandidate: Point, zoomValue: number, frameValue: CropFrame): Point => {
    const displayedWidth = imageSize.width * fitScale * zoomValue;
    const displayedHeight = imageSize.height * fitScale * zoomValue;
    const minX = frameValue.x + frameValue.size - stageSize.width / 2 - displayedWidth / 2;
    const maxX = frameValue.x - stageSize.width / 2 + displayedWidth / 2;
    const minY = frameValue.y + frameValue.size - stageSize.height / 2 - displayedHeight / 2;
    const maxY = frameValue.y - stageSize.height / 2 + displayedHeight / 2;
    return {
      x: Math.min(Math.max(minX, offsetCandidate.x), maxX),
      y: Math.min(Math.max(minY, offsetCandidate.y), maxY),
    };
  };

  const changeZoom = (nextZoom: number, anchor?: Point) => {
    const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    if (!anchor || !frame || !imageSize.width) {
      setZoom(clampedZoom);
      setOffset(current => clampOffsetForFrame(current, clampedZoom, frame ?? { x: 0, y: 0, size: MIN_FRAME_SIZE }));
      return;
    }
    const oldScale = fitScale * zoom;
    const newScale = fitScale * clampedZoom;
    // الحفاظ على نقطة الصورة تحت المؤشر ثابتة أثناء التقريب
    setZoom(clampedZoom);
    setOffset(current => {
      const centerX = stageSize.width / 2 + current.x;
      const centerY = stageSize.height / 2 + current.y;
      const naturalX = (anchor.x - (centerX - (imageSize.width * oldScale) / 2)) / oldScale;
      const naturalY = (anchor.y - (centerY - (imageSize.height * oldScale) / 2)) / oldScale;
      const nextCenterX = anchor.x - naturalX * newScale + (imageSize.width * newScale) / 2;
      const nextCenterY = anchor.y - naturalY * newScale + (imageSize.height * newScale) / 2;
      return clampOffsetForFrame(
        { x: nextCenterX - stageSize.width / 2, y: nextCenterY - stageSize.height / 2 },
        clampedZoom,
        frame,
      );
    });
  };

  const stagePoint = (clientX: number, clientY: number): Point => {
    const bounds = stageRef.current?.getBoundingClientRect();
    return bounds
      ? { x: clientX - bounds.left, y: clientY - bounds.top }
      : { x: clientX, y: clientY };
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // قد يكون المؤشر أفلت قبل التسجيل
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest('[data-crop-handle]')?.getAttribute('data-crop-handle');
    if (handle) {
      // التمدد من الزاوية المقابلة كمَرساة ثابتة
      const anchors: Record<string, Point> = {
        nw: { x: frame.x + frame.size, y: frame.y + frame.size },
        ne: { x: frame.x, y: frame.y + frame.size },
        sw: { x: frame.x + frame.size, y: frame.y },
        se: { x: frame.x, y: frame.y },
      };
      resizeRef.current = { handle, anchor: anchors[handle] };
      panLastRef.current = null;
      return;
    }

    if (pointersRef.current.size === 1) {
      panLastRef.current = { x: event.clientX, y: event.clientY };
    } else if (pointersRef.current.size === 2) {
      const pair = Array.from(pointersRef.current.values()).slice(0, 2);
      pinchStartRef.current = { distance: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y), zoom };
      panLastRef.current = null;
    }
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const resize = resizeRef.current;
    if (resize) {
      const point = stagePoint(event.clientX, event.clientY);
      const size = Math.max(
        MIN_FRAME_SIZE,
        Math.max(Math.abs(point.x - resize.anchor.x), Math.abs(point.y - resize.anchor.y)),
      );
      const next: CropFrame = resize.handle === 'nw'
        ? { x: resize.anchor.x - size, y: resize.anchor.y - size, size }
        : resize.handle === 'ne'
          ? { x: resize.anchor.x, y: resize.anchor.y - size, size }
          : resize.handle === 'sw'
            ? { x: resize.anchor.x - size, y: resize.anchor.y, size }
            : { x: resize.anchor.x, y: resize.anchor.y, size };
      const clamped = clampFrame(next);
      setFrame(clamped);
      setOffset(current => clampOffsetForFrame(current, zoom, clamped));
      return;
    }

    if (pointersRef.current.size >= 2) {
      const pair = Array.from(pointersRef.current.values()).slice(0, 2);
      const pinchStart = pinchStartRef.current;
      if (pinchStart) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        const anchorPoint = stagePoint((pair[0].x + pair[1].x) / 2, (pair[0].y + pair[1].y) / 2);
        changeZoom(pinchStart.zoom * distance / Math.max(pinchStart.distance, 1), anchorPoint);
      }
      return;
    }

    const panLast = panLastRef.current;
    if (!panLast) return;
    const deltaX = event.clientX - panLast.x;
    const deltaY = event.clientY - panLast.y;
    panLastRef.current = { x: event.clientX, y: event.clientY };
    setOffset(current => clampOffsetForFrame(
      { x: current.x + deltaX, y: current.y + deltaY },
      zoom,
      frame,
    ));
  };

  const onStagePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) panLastRef.current = null;
    resizeRef.current = null;
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    changeZoom(
      zoom * (event.deltaY < 0 ? 1.08 : 0.93),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    );
  };

  const confirmCrop = async () => {
    if (saving || !imageSize.width || !imageSize.height || !frame) return;
    setSaving(true);
    try {
      const scale = fitScale * zoom;
      const centerX = stageSize.width / 2 + offset.x;
      const centerY = stageSize.height / 2 + offset.y;
      const imageLeft = centerX - (imageSize.width * scale) / 2;
      const imageTop = centerY - (imageSize.height * scale) / 2;

      const sourceWidth = frame.size / scale;
      const sourceHeight = sourceWidth;
      const sourceX = Math.min(
        Math.max(0, imageSize.width - sourceWidth),
        Math.max(0, (frame.x - imageLeft) / scale),
      );
      const sourceY = Math.min(
        Math.max(0, imageSize.height - sourceHeight),
        Math.max(0, (frame.y - imageTop) / scale),
      );

      const outputSize = Math.min(OUTPUT_MAX_DIMENSION, Math.round(sourceWidth));
      const canvas = document.createElement('canvas');
      canvas.width = outputSize;
      canvas.height = outputSize;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة المقصوصة.');

      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      });
      image.src = previewUrl;
      await imageLoaded;

      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputSize, outputSize);
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

  const displayedWidth = imageSize.width * fitScale * zoom;
  const displayedHeight = imageSize.height * fitScale * zoom;

  const handleStyle = (handleId: string): CSSProperties => {
    const offsetValue = -HANDLE_SIZE / 2;
    if (handleId === 'nw') return { left: offsetValue, top: offsetValue, width: HANDLE_SIZE, height: HANDLE_SIZE };
    if (handleId === 'ne') return { right: offsetValue, top: offsetValue, width: HANDLE_SIZE, height: HANDLE_SIZE };
    if (handleId === 'sw') return { left: offsetValue, bottom: offsetValue, width: HANDLE_SIZE, height: HANDLE_SIZE };
    return { right: offsetValue, bottom: offsetValue, width: HANDLE_SIZE, height: HANDLE_SIZE };
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

      <p className="px-4 pb-2 text-center text-xs text-zinc-400">
        اسحب الصورة أو قرّبها لتحديد الجزء المطلوب، واستخدم مقابض الزوايا الأربعة لتكبير أو تصغير إطار القص المربع.
      </p>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-black"
        style={{ touchAction: 'none' }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerEnd}
        onPointerCancel={onStagePointerEnd}
        onWheel={onWheel}
      >
        {imageSize.width > 0 && (
          <img
            src={previewUrl}
            alt=""
            draggable={false}
            onDragStart={event => event.preventDefault()}
            onLoad={event => {
              // كل صورة جديدة تبدأ بإطار مربع افتراضي جديد في وسطها
              setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              setZoom(1);
              setOffset({ x: 0, y: 0 });
              setFrame(null);
            }}
            className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
            style={{
              width: displayedWidth,
              height: displayedHeight,
              transform: `translate(-50%, -50%) translate3d(${offset.x}px, ${offset.y}px, 0)`,
            }}
          />
        )}

        {frame && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.size,
              height: frame.size,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
              outline: '2px solid rgba(255,255,255,0.92)',
            }}
          >
            <div className="absolute inset-0 grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr' }} aria-hidden="true">
              {[...Array(9)].map((_, index) => <span key={index} className="border border-white/20" />)}
            </div>
            {/* مقابض التحكم في الزوايا الأربعة */}
            {(['nw', 'ne', 'sw', 'se'] as const).map(handleId => (
              <button
                key={handleId}
                type="button"
                data-crop-handle={handleId}
                aria-label={`مقبض زاوية ${handleId === 'nw' ? 'عليا يسرى' : handleId === 'ne' ? 'عليا يمنى' : handleId === 'sw' ? 'سفلى يسرى' : 'سفلى يمنى'}`}
                className="pointer-events-auto absolute grid place-items-center rounded-full bg-white/15 backdrop-blur-sm transition hover:bg-white/30"
                style={{ ...handleStyle(handleId), touchAction: 'none' }}
              >
                <span
                  className="block rounded-[3px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)]"
                  style={{ width: 8, height: 8 }}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="space-y-3 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={() => void confirmCrop()}
          disabled={saving || !imageSize.width || !frame}
          className="w-full rounded-full bg-white px-6 py-3 text-base font-bold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'جارٍ القص...' : 'تأكيد القص'}
        </button>
      </footer>
    </div>
  );
}
