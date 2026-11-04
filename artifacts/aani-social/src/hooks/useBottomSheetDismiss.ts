import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';

const SWIPE_DISMISS_DISTANCE = 36;

type BottomSheetDismissHandlers = {
  dragOffset: number;
  dragging: boolean;
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onTouchEnd: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onTouchCancel: () => void;
};

export function useBottomSheetDismiss(open: boolean, onDismiss: () => void): BottomSheetDismissHandlers {
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartYRef = useRef<number | null>(null);
  const touchIdRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const dismissRef = useRef(onDismiss);
  const suppressClickRef = useRef(false);
  const [activePointerId, setActivePointerId] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const finishSwipe = useCallback((distance: number) => {
    pointerIdRef.current = null;
    pointerStartYRef.current = null;
    touchIdRef.current = null;
    touchStartYRef.current = null;
    setActivePointerId(null);
    setDragOffset(0);
    setDragging(false);

    if (distance > SWIPE_DISMISS_DISTANCE) {
      suppressClickRef.current = true;
      dismissRef.current();
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }, []);

  useEffect(() => {
    if (activePointerId === null) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId || pointerStartYRef.current === null) return;
      setDragOffset(Math.max(0, event.clientY - pointerStartYRef.current));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId || pointerStartYRef.current === null) return;
      finishSwipe(Math.max(0, event.clientY - pointerStartYRef.current));
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      finishSwipe(0);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [activePointerId, finishSwipe]);

  useEffect(() => {
    if (open) return;
    pointerIdRef.current = null;
    pointerStartYRef.current = null;
    touchIdRef.current = null;
    touchStartYRef.current = null;
    setActivePointerId(null);
    setDragOffset(0);
    setDragging(false);
  }, [open]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    pointerIdRef.current = event.pointerId;
    pointerStartYRef.current = event.clientY;
    setActivePointerId(event.pointerId);
    setDragging(true);
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      touchIdRef.current = null;
      touchStartYRef.current = null;
      setDragging(false);
      setDragOffset(0);
      return;
    }
    const touch = event.touches[0];
    touchIdRef.current = touch.identifier;
    touchStartYRef.current = touch.clientY;
    setDragging(true);
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (touchIdRef.current === null || touchStartYRef.current === null) return;
    const touch = Array.from(event.touches).find(item => item.identifier === touchIdRef.current);
    if (touch) setDragOffset(Math.max(0, touch.clientY - touchStartYRef.current));
  };

  const onTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (touchIdRef.current === null || touchStartYRef.current === null) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === touchIdRef.current);
    if (!touch) return;
    finishSwipe(Math.max(0, touch.clientY - touchStartYRef.current));
  };

  const onTouchCancel = () => finishSwipe(0);

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };

  return {
    dragOffset,
    dragging,
    onClickCapture,
    onPointerDown,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  };
}
