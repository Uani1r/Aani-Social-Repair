import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Point = { x: number; y: number };
type PinchStart = { distance: number; scale: number };

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export default function PostImagePreview({ src, alt, className }: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const holdTimerRef = useRef<number | null>(null);
  const holdPointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchStartRef = useRef<PinchStart | null>(null);

  const clearHold = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdPointerRef.current = null;
  };

  useEffect(() => {
    if (!isOpen) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      pointersRef.current.clear();
      pinchStartRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
  }, []);

  const handleImagePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!event.isPrimary) {
      clearHold();
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    clearHold();
    holdPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      setScale(1);
      setIsOpen(true);
    }, 500);
  };

  const handleImagePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const pointer = holdPointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) clearHold();
  };

  const handlePreviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }

    if (pointers.size >= 2) {
      const pair = Array.from(pointers.values()).slice(0, 2);
      pinchStartRef.current = { distance: distanceBetween(pair[0], pair[1]), scale };
    }
  };

  const handlePreviewPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size < 2) return;

    const pair = Array.from(pointers.values()).slice(0, 2);
    const pinchStart = pinchStartRef.current;
    if (!pinchStart) {
      pinchStartRef.current = { distance: distanceBetween(pair[0], pair[1]), scale };
      return;
    }

    const nextScale = pinchStart.scale * distanceBetween(pair[0], pair[1]) / Math.max(pinchStart.distance, 1);
    setScale(Math.min(5, Math.max(1, nextScale)));
  };

  const handlePreviewPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
  };

  return (
    <>
      <img
        src={src}
        alt={alt}
        draggable={false}
        onDragStart={event => event.preventDefault()}
        onContextMenu={event => event.preventDefault()}
        onPointerDown={handleImagePointerDown}
        onPointerMove={handleImagePointerMove}
        onPointerUp={clearHold}
        onPointerCancel={clearHold}
        className={className}
      />

      {isOpen && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-3"
          role="dialog"
          aria-modal="true"
          aria-label="معاينة الصورة"
          onClick={event => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setIsOpen(false);
          }}
          style={{ touchAction: 'none' }}
        >
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="إغلاق معاينة الصورة"
            className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
            style={{ top: 'max(1rem, env(safe-area-inset-top))' }}
          >
            <X size={22} />
          </button>
          <div
            className="flex h-full w-full items-center justify-center overflow-hidden"
            onPointerDown={handlePreviewPointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerUp={handlePreviewPointerEnd}
            onPointerCancel={handlePreviewPointerEnd}
            onClick={event => {
              event.stopPropagation();
              if (event.target === event.currentTarget) setIsOpen(false);
            }}
            style={{ touchAction: 'none' }}
          >
            <img
              src={src}
              alt={alt}
              draggable={false}
              onDragStart={event => event.preventDefault()}
              className="max-h-[90dvh] max-w-[96vw] select-none object-contain"
              style={{ transform: `scale(${scale})`, transformOrigin: 'center', touchAction: 'none' }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
