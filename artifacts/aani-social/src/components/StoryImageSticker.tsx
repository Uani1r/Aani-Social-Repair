import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';

import type { StoryImageOverlay, StoryImageStickerUpdate, StoryStickerShape } from '@/components/stories/types';

type StoryImageStickerProps = {
  sticker: StoryImageOverlay;
  interactive?: boolean;
  sizeScale?: number;
  onChange?: (update: StoryImageStickerUpdate) => void;
  onActivate?: () => void;
  onDragMove?: (point: { x: number; y: number }) => void;
  onDragEnd?: (point: { x: number; y: number }, cancelled: boolean) => void;
};

type StickerSize = { width: number; height: number; clipPath?: string; borderRadius?: string };
type GestureMode = 'pending' | 'move' | 'crop' | 'transform';

type StickerGesture = {
  mode: GestureMode;
  touchCount: number;
  startX: number;
  startY: number;
  startDistance: number;
  startAngle: number;
  baseX: number;
  baseY: number;
  baseScale: number;
  baseRotation: number;
  baseCropX: number;
  baseCropY: number;
  baseCropScale: number;
  moved: boolean;
  longPressed: boolean;
  timer?: number;
};

const SHAPE_ORDER: StoryStickerShape[] = ['square', 'circle', 'rectangle', 'triangle', 'heart', 'star', 'diamond', 'hexagon'];

const SHAPES: Record<StoryStickerShape, StickerSize & { label: string }> = {
  square: { width: 144, height: 144, label: 'مربع' },
  circle: { width: 144, height: 144, borderRadius: '50%', label: 'دائرة' },
  rectangle: { width: 176, height: 112, borderRadius: '8px', label: 'مستطيل' },
  triangle: { width: 144, height: 144, clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)', label: 'مثلث' },
  heart: { width: 144, height: 144, clipPath: 'polygon(50% 94%, 8% 58%, 3% 43%, 7% 29%, 18% 18%, 32% 16%, 50% 31%, 68% 16%, 82% 18%, 93% 29%, 97% 43%, 92% 58%)', label: 'قلب' },
  star: { width: 148, height: 148, clipPath: 'polygon(50% 0%, 62% 35%, 98% 36%, 69% 58%, 79% 94%, 50% 72%, 21% 94%, 31% 58%, 2% 36%, 38% 35%)', label: 'نجمة' },
  diamond: { width: 140, height: 156, clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', label: 'مُعين' },
  hexagon: { width: 156, height: 136, clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)', label: 'سداسي' },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function touchCenter(touches: TouchList) {
  const first = touches[0];
  const second = touches[1];
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
    angle: (Math.atan2(second.clientY - first.clientY, second.clientX - first.clientX) * 180) / Math.PI,
  };
}

function nextShape(shape: StoryStickerShape): StoryStickerShape {
  const currentIndex = SHAPE_ORDER.indexOf(shape);
  return SHAPE_ORDER[(currentIndex + 1) % SHAPE_ORDER.length];
}

export default function StoryImageSticker({
  sticker,
  interactive = true,
  sizeScale = 1,
  onChange,
  onActivate,
  onDragMove,
  onDragEnd,
}: StoryImageStickerProps) {
  const gestureRef = useRef<StickerGesture | null>(null);
  const stickerRef = useRef<HTMLDivElement | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const shape = SHAPES[sticker.shape] || SHAPES.square;
  const width = shape.width * sizeScale;
  const height = shape.height * sizeScale;
  const imageAspect = imageNaturalSize.width > 0 && imageNaturalSize.height > 0
    ? imageNaturalSize.width / imageNaturalSize.height
    : width / height;
  const imageWidth = Math.max(width, height * imageAspect);
  const imageHeight = Math.max(height, width / imageAspect);
  const maxCropX = Math.max(0, ((imageWidth * sticker.cropScale - width) / (2 * imageWidth)) * 100);
  const maxCropY = Math.max(0, ((imageHeight * sticker.cropScale - height) / (2 * imageHeight)) * 100);
  const cropX = clamp(sticker.cropX, -maxCropX, maxCropX);
  const cropY = clamp(sticker.cropY, -maxCropY, maxCropY);

  useEffect(() => () => {
    if (gestureRef.current?.timer) window.clearTimeout(gestureRef.current.timer);
  }, []);

  const getCanvasSize = () => {
    const parent = stickerRef.current?.offsetParent as HTMLElement | null;
    const bounds = parent?.getBoundingClientRect();
    return {
      width: Math.max(1, bounds?.width || window.innerWidth),
      height: Math.max(1, bounds?.height || window.innerHeight),
      scaleX: parent && bounds && parent.clientWidth > 0 ? bounds.width / parent.clientWidth : 1,
      scaleY: parent && bounds && parent.clientHeight > 0 ? bounds.height / parent.clientHeight : 1,
    };
  };

  const clearGestureTimer = (gesture: StickerGesture | null) => {
    if (gesture?.timer) window.clearTimeout(gesture.timer);
    if (gesture) gesture.timer = undefined;
  };

  const beginSingleTouch = (touch: Touch, mode: GestureMode = 'pending') => {
    const gesture: StickerGesture = {
      mode,
      touchCount: 1,
      startX: touch.clientX,
      startY: touch.clientY,
      startDistance: 0,
      startAngle: 0,
      baseX: sticker.x,
      baseY: sticker.y,
      baseScale: sticker.scale,
      baseRotation: sticker.rotation,
      baseCropX: cropX,
      baseCropY: cropY,
      baseCropScale: sticker.cropScale,
      moved: false,
      longPressed: mode === 'crop',
    };
    if (mode === 'pending') {
      gesture.timer = window.setTimeout(() => {
        if (gestureRef.current === gesture) {
          gesture.mode = 'crop';
          gesture.longPressed = true;
        }
      }, 380);
    }
    gestureRef.current = gesture;
  };

  const beginTransform = (touches: TouchList) => {
    const center = touchCenter(touches);
    gestureRef.current = {
      mode: 'transform',
      touchCount: 2,
      startX: center.x,
      startY: center.y,
      startDistance: center.distance,
      startAngle: center.angle,
      baseX: sticker.x,
      baseY: sticker.y,
      baseScale: sticker.scale,
      baseRotation: sticker.rotation,
      baseCropX: cropX,
      baseCropY: cropY,
      baseCropScale: sticker.cropScale,
      moved: false,
      longPressed: false,
    };
  };

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!interactive) return;
    event.stopPropagation();
    onActivate?.();
    clearGestureTimer(gestureRef.current);
    if (event.touches.length >= 2) {
      beginTransform(event.touches);
    } else if (event.touches.length === 1) {
      beginSingleTouch(event.touches[0]);
    }
  };

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!interactive) return;
    event.stopPropagation();
    const gesture = gestureRef.current;
    if (!gesture || event.touches.length === 0) return;

    if (event.touches.length >= 2) {
      if (gesture.mode !== 'transform' || gesture.touchCount < 2) {
        clearGestureTimer(gesture);
        beginTransform(event.touches);
        return;
      }

      const center = touchCenter(event.touches);
      const ratio = gesture.startDistance > 0 ? center.distance / gesture.startDistance : 1;
      let angleDelta = center.angle - gesture.startAngle;
      if (angleDelta > 180) angleDelta -= 360;
      if (angleDelta < -180) angleDelta += 360;
      const deltaX = center.x - gesture.startX;
      const deltaY = center.y - gesture.startY;
      const canvas = getCanvasSize();
      gesture.moved ||= Math.hypot(deltaX, deltaY) > 2 || Math.abs(ratio - 1) > 0.02 || Math.abs(angleDelta) > 2;
      onChange?.({
        x: clamp(gesture.baseX + (deltaX / canvas.width) * 100, 0, 100),
        y: clamp(gesture.baseY + (deltaY / canvas.height) * 100, 0, 100),
        scale: clamp(gesture.baseScale * ratio, 0.3, 5),
        rotation: gesture.baseRotation + angleDelta,
      });
      return;
    }

    if (gesture.touchCount !== 1) {
      beginSingleTouch(event.touches[0]);
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    if (gesture.mode === 'pending' && Math.hypot(deltaX, deltaY) > 8) {
      clearGestureTimer(gesture);
      gesture.mode = 'move';
    }
    if (gesture.mode === 'pending') return;
    gesture.moved ||= Math.hypot(deltaX, deltaY) > 2;

    if (gesture.mode === 'crop') {
      const canvas = getCanvasSize();
      const renderedWidth = Math.max(1, imageWidth * sticker.scale * canvas.scaleX);
      const renderedHeight = Math.max(1, imageHeight * sticker.scale * canvas.scaleY);
      onChange?.({
        cropX: clamp(gesture.baseCropX + (deltaX / renderedWidth) * 100, -maxCropX, maxCropX),
        cropY: clamp(gesture.baseCropY + (deltaY / renderedHeight) * 100, -maxCropY, maxCropY),
      });
    } else if (gesture.mode === 'move') {
      const canvas = getCanvasSize();
      onChange?.({
        x: clamp(gesture.baseX + (deltaX / canvas.width) * 100, 0, 100),
        y: clamp(gesture.baseY + (deltaY / canvas.height) * 100, 0, 100),
      });
      onDragMove?.({ x: touch.clientX, y: touch.clientY });
    }
  };

  const finishTouch = (event: ReactTouchEvent<HTMLDivElement>, cancelled = false) => {
    if (!interactive) return;
    event.stopPropagation();
    const gesture = gestureRef.current;
    if (!gesture) return;
    clearGestureTimer(gesture);

    if (event.touches.length === 1 && gesture.touchCount >= 2) {
      beginSingleTouch(event.touches[0]);
      return;
    }
    if (event.touches.length > 0) return;

    const touch = event.changedTouches[0];
    const point = touch
      ? { x: touch.clientX, y: touch.clientY }
      : { x: gesture.startX, y: gesture.startY };
    if (gesture.mode === 'move' && gesture.moved) {
      onDragEnd?.(point, cancelled);
    }
    if (!cancelled && (gesture.mode !== 'pending' || gesture.moved || gesture.longPressed)) {
      suppressClickUntilRef.current = Date.now() + 450;
    }
    gestureRef.current = null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || event.pointerType !== 'mouse') return;
    event.stopPropagation();
    onActivate?.();
    gestureRef.current = {
      mode: 'move',
      touchCount: 0,
      startX: event.clientX,
      startY: event.clientY,
      startDistance: 0,
      startAngle: 0,
      baseX: sticker.x,
      baseY: sticker.y,
      baseScale: sticker.scale,
      baseRotation: sticker.rotation,
      baseCropX: cropX,
      baseCropY: cropY,
      baseCropScale: sticker.cropScale,
      moved: false,
      longPressed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || event.pointerType !== 'mouse') return;
    const gesture = gestureRef.current;
    if (!gesture || gesture.touchCount !== 0) return;
    event.stopPropagation();

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.hypot(deltaX, deltaY) > 2) gesture.moved = true;
    if (!gesture.moved) return;

    const canvas = getCanvasSize();
    onChange?.({
      x: clamp(gesture.baseX + (deltaX / canvas.width) * 100, 0, 100),
      y: clamp(gesture.baseY + (deltaY / canvas.height) * 100, 0, 100),
    });
    onDragMove?.({ x: event.clientX, y: event.clientY });
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!interactive || event.pointerType !== 'mouse') return;
    const gesture = gestureRef.current;
    if (!gesture || gesture.touchCount !== 0) return;
    event.stopPropagation();
    if (gesture.moved) {
      onDragEnd?.({ x: event.clientX, y: event.clientY }, cancelled);
      if (!cancelled) suppressClickUntilRef.current = Date.now() + 450;
    }
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cycleShape = () => {
    if (!interactive || !onChange) return;
    onChange({ shape: nextShape(sticker.shape) });
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    event.stopPropagation();
    onActivate?.();
    if (Date.now() < suppressClickUntilRef.current) return;
    cycleShape();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
    cycleShape();
  };

  return (
    <div
      ref={stickerRef}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `ملصق صورة بشكل ${shape.label}؛ اضغط لتغيير الشكل` : undefined}
      aria-hidden={interactive ? undefined : true}
      className={`absolute z-[15] overflow-hidden ${interactive ? 'pointer-events-auto cursor-grab active:cursor-grabbing focus:outline-none' : 'pointer-events-none'}`}
      style={{
        left: `${sticker.x}%`,
        top: `${sticker.y}%`,
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(-50%, -50%) scale(${sticker.scale}) rotate(${sticker.rotation}deg)`,
        clipPath: shape.clipPath,
        borderRadius: shape.borderRadius,
        touchAction: interactive ? 'none' : undefined,
        userSelect: 'none',
      }}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onTouchStart={interactive ? handleTouchStart : undefined}
      onTouchMove={interactive ? handleTouchMove : undefined}
      onTouchEnd={interactive ? event => finishTouch(event) : undefined}
      onTouchCancel={interactive ? event => finishTouch(event, true) : undefined}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onPointerMove={interactive ? handlePointerMove : undefined}
      onPointerUp={interactive ? finishPointer : undefined}
      onPointerCancel={interactive ? event => finishPointer(event, true) : undefined}
      onContextMenu={interactive ? event => event.preventDefault() : undefined}
    >
      <img
        src={sticker.src}
        alt=""
        draggable={false}
        onLoad={event => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setImageNaturalSize({ width: naturalWidth, height: naturalHeight });
          }
        }}
        className="absolute left-1/2 top-1/2 max-w-none"
        style={{
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(-50%, -50%) translate(${cropX}%, ${cropY}%) scale(${sticker.cropScale})`,
          transformOrigin: 'center',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
