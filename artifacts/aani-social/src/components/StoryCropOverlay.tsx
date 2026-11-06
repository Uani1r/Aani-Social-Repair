import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, X } from 'lucide-react';

type Point = { x: number; y: number };
type CropFrame = { x: number; y: number; width: number; height: number };
type CropRatioKey = '9:16' | '1:1' | '4:5' | 'original';
type CropGesture = {
  mode: 'pan' | 'move-frame' | 'resize';
  handle?: string;
  pointerId: number;
  startX: number;
  startY: number;
  startFrame: CropFrame;
  startOffset: Point;
};
type CropTransform = { zoom: number; offset: Point };

type StoryCropOverlayProps = {
  mediaUrl: string;
  isVideo: boolean;
  initialZoom: number;
  initialOffset: Point;
  initialRotation: number;
  onCancel: () => void;
  onApply: (transform: CropTransform) => void;
};

const RATIO_VALUES: Record<Exclude<CropRatioKey, 'original'>, number> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

function makeFrame(width: number, height: number, aspect: number): CropFrame {
  const frameWidth = Math.max(80, Math.min(width * 0.88, height * 0.82 * aspect));
  const frameHeight = frameWidth / aspect;
  return {
    x: (width - frameWidth) / 2,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export default function StoryCropOverlay({
  mediaUrl,
  isVideo,
  initialZoom,
  initialOffset,
  initialRotation,
  onCancel,
  onApply,
}: StoryCropOverlayProps) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [ratioKey, setRatioKey] = useState<CropRatioKey>('9:16');
  const [originalAspect, setOriginalAspect] = useState(9 / 16);
  const [frame, setFrame] = useState(() => makeFrame(window.innerWidth, window.innerHeight, RATIO_VALUES['9:16']));
  const [zoom, setZoom] = useState(initialZoom);
  const [offset, setOffset] = useState(initialOffset);
  const gestureRef = useRef<CropGesture | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<{ distance: number; zoom: number; midpoint: Point; offset: Point } | null>(null);
  const aspect = ratioKey === 'original' ? originalAspect : RATIO_VALUES[ratioKey];

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    setFrame(makeFrame(viewport.width, viewport.height, aspect));
  }, [aspect, viewport.height, viewport.width]);

  const setOriginalRatio = (width: number, height: number) => {
    if (width > 0 && height > 0) setOriginalAspect(width / height);
  };

  const beginPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-crop-control]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size >= 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      pinchRef.current = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        zoom,
        midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        offset,
      };
      gestureRef.current = null;
      return;
    }

    const handle = target.closest('[data-crop-handle]')?.getAttribute('data-crop-handle') || undefined;
    const moveFrame = Boolean(target.closest('[data-crop-frame-edge]'));
    gestureRef.current = {
      mode: handle ? 'resize' : moveFrame ? 'move-frame' : 'pan',
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame,
      startOffset: offset,
    };
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointersRef.current.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    event.stopPropagation();
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [first, second] = Array.from(pointersRef.current.values());
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      setZoom(clamp(pinchRef.current.zoom * distance / pinchRef.current.distance, 1, 5));
      setOffset({
        x: clamp(pinchRef.current.offset.x + midpoint.x - pinchRef.current.midpoint.x, -viewport.width * 2, viewport.width * 2),
        y: clamp(pinchRef.current.offset.y + midpoint.y - pinchRef.current.midpoint.y, -viewport.height * 2, viewport.height * 2),
      });
      return;
    }

    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;

    if (gesture.mode === 'pan') {
      setOffset({
        x: clamp(gesture.startOffset.x + deltaX, -viewport.width * 2, viewport.width * 2),
        y: clamp(gesture.startOffset.y + deltaY, -viewport.height * 2, viewport.height * 2),
      });
      return;
    }

    if (gesture.mode === 'move-frame') {
      setFrame(previous => ({
        ...previous,
        x: clamp(gesture.startFrame.x + deltaX, 8, viewport.width - gesture.startFrame.width - 8),
        y: clamp(gesture.startFrame.y + deltaY, 8, viewport.height - gesture.startFrame.height - 8),
      }));
      return;
    }

    const handle = gesture.handle || '';
    const start = gesture.startFrame;
    const horizontalDirection = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
    const verticalDirection = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
    const widthDelta = horizontalDirection ? deltaX * horizontalDirection : deltaY * verticalDirection * aspect;
    const heightDelta = verticalDirection ? deltaY * verticalDirection : deltaX * horizontalDirection / aspect;
    const width = clamp(
      start.width + (Math.abs(widthDelta) >= Math.abs(heightDelta * aspect) ? widthDelta : heightDelta * aspect),
      100,
      Math.min(viewport.width - 16, (viewport.height - 16) * aspect),
    );
    const height = width / aspect;
    const x = horizontalDirection < 0 ? start.x + start.width - width : horizontalDirection > 0 ? start.x : start.x + (start.width - width) / 2;
    const y = verticalDirection < 0 ? start.y + start.height - height : verticalDirection > 0 ? start.y : start.y + (start.height - height) / 2;
    setFrame({
      x: clamp(x, 8, viewport.width - width - 8),
      y: clamp(y, 8, viewport.height - height - 8),
      width,
      height,
    });
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const applyCrop = () => {
    const fillScale = Math.max(viewport.width / frame.width, viewport.height / frame.height);
    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    onApply({
      zoom: clamp(zoom * fillScale, 0.4, 4),
      offset: {
        x: clamp(fillScale * (viewport.width / 2 + offset.x - centerX), -viewport.width, viewport.width),
        y: clamp(fillScale * (viewport.height / 2 + offset.y - centerY), -viewport.height, viewport.height),
      },
    });
  };

  const resizeHandles = [
    { key: 'nw', className: '-left-2 -top-2' },
    { key: 'n', className: 'left-1/2 -top-2 -translate-x-1/2' },
    { key: 'ne', className: '-right-2 -top-2' },
    { key: 'e', className: '-right-2 top-1/2 -translate-y-1/2' },
    { key: 'se', className: '-bottom-2 -right-2' },
    { key: 's', className: '-bottom-2 left-1/2 -translate-x-1/2' },
    { key: 'sw', className: '-bottom-2 -left-2' },
    { key: 'w', className: '-left-2 top-1/2 -translate-y-1/2' },
  ];
  const framePath = `M0 0H${viewport.width}V${viewport.height}H0Z M${frame.x} ${frame.y}H${frame.x + frame.width}V${frame.y + frame.height}H${frame.x}Z`;

  return (
    <div
      className="fixed inset-0 z-[170] overflow-hidden bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="قص الوسيط"
      onPointerDown={beginPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      style={{ touchAction: 'none' }}
    >
      {isVideo ? (
        <video
          src={mediaUrl}
          autoPlay
          loop
          muted
          playsInline
          onLoadedMetadata={event => setOriginalRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom}) rotate(${initialRotation}deg)`, transformOrigin: 'center' }}
        />
      ) : (
        <img
          src={mediaUrl}
          alt=""
          draggable={false}
          onLoad={event => setOriginalRatio(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom}) rotate(${initialRotation}deg)`, transformOrigin: 'center' }}
        />
      )}

      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${viewport.width} ${viewport.height}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={framePath} fill="rgba(0,0,0,0.62)" fillRule="evenodd" />
      </svg>

      <div
        data-crop-frame-edge="true"
        className="pointer-events-auto absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, touchAction: 'none' }}
      >
        <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} className={`${index % 3 < 2 ? 'border-r border-white/35' : ''} ${index < 6 ? 'border-b border-white/35' : ''}`} />
          ))}
        </div>
      </div>
      {resizeHandles.map(handle => (
        <button
          key={handle.key}
          type="button"
          data-crop-handle={handle.key}
          aria-label="تغيير حجم إطار القص"
          className={`absolute z-10 h-5 w-5 rounded-full border-2 border-white bg-black/40 ${handle.className}`}
          style={{ left: frame.x + (handle.key.includes('e') ? frame.width : handle.key.includes('w') ? 0 : frame.width / 2) - 10, top: frame.y + (handle.key.includes('s') ? frame.height : handle.key.includes('n') ? 0 : frame.height / 2) - 10 }}
        />
      ))}

      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <button
          type="button"
          data-crop-control="true"
          onClick={onCancel}
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md"
          aria-label="إلغاء القص"
        >
          <X size={21} />
        </button>
        <span className="rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold backdrop-blur-md">قص الوسيط</span>
        <button
          type="button"
          data-crop-control="true"
          onClick={applyCrop}
          className="pointer-events-auto flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-xs font-bold text-black"
        >
          <Check size={16} />
          تطبيق القص
        </button>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="rounded-full bg-black/50 px-3 py-1 text-[10px] text-white/75 backdrop-blur-md">اسحب الصورة للتحريك، واسحب مقابض الإطار لتغيير حجمه</p>
        <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-full border border-white/10 bg-black/65 p-1.5 backdrop-blur-xl" dir="ltr" data-crop-control="true">
          {(['9:16', '1:1', '4:5', 'original'] as CropRatioKey[]).map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setRatioKey(option)}
              aria-pressed={ratioKey === option}
              className={`shrink-0 rounded-full px-3 py-2 text-[11px] font-semibold transition ${ratioKey === option ? 'bg-white text-black' : 'text-white/75 hover:bg-white/10'}`}
            >
              {option === 'original' ? 'الأصلية' : option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
