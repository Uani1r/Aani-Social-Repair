import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Reply } from 'lucide-react';

const REPLY_THRESHOLD = 56;
const MAX_SWIPE_DISTANCE = 96;

type SwipeAxis = 'undecided' | 'horizontal' | 'vertical' | 'rejected';

type PointerStart = {
  pointerId: number;
  x: number;
  y: number;
  axis: SwipeAxis;
};

export default function MessageSwipeReply({
  isMine,
  onReply,
  children,
}: {
  isMine: boolean;
  onReply: () => void;
  children: ReactNode;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isArmed, setIsArmed] = useState(false);
  const pointerStartRef = useRef<PointerStart | null>(null);
  const offsetRef = useRef(0);
  const hapticPlayedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    pointerStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      axis: 'undecided',
    };
    offsetRef.current = 0;
    hapticPlayedRef.current = false;
    setOffsetX(0);
    setIsArmed(false);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (start.axis === 'undecided') {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8) return;
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.15) {
        start.axis = 'vertical';
        return;
      }
      const isExpectedDirection = isMine ? deltaX < 0 : deltaX > 0;
      if (!isExpectedDirection) {
        start.axis = 'rejected';
        return;
      }
      start.axis = 'horizontal';
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* قد لا يدعم المتصفح التقاط المؤشر */
      }
      setIsDragging(true);
    }

    if (start.axis !== 'horizontal') return;
    event.preventDefault();
    suppressClickRef.current = true;
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 500);

    const distance = Math.min(MAX_SWIPE_DISTANCE, Math.abs(deltaX));
    const nextOffset = isMine ? -distance : distance;
    offsetRef.current = nextOffset;
    setOffsetX(nextOffset);
    const nextArmed = distance >= REPLY_THRESHOLD;
    setIsArmed(nextArmed);
    if (nextArmed && !hapticPlayedRef.current) {
      hapticPlayedRef.current = true;
      if (typeof navigator.vibrate === 'function') navigator.vibrate(12);
    }
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, canceled = false) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const shouldReply = !canceled && start.axis === 'horizontal' && Math.abs(offsetRef.current) >= REPLY_THRESHOLD;
    pointerStartRef.current = null;
    offsetRef.current = 0;
    setOffsetX(0);
    setIsDragging(false);
    setIsArmed(false);
    if (shouldReply) onReply();
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const progress = Math.min(1, Math.abs(offsetX) / REPLY_THRESHOLD);
  const gestureStyle = {
    '--messages-reply-progress': progress,
    '--messages-reply-scale': 0.62 + progress * 0.38,
    transform: `translate3d(${offsetX}px, 0, 0)`,
  } as CSSProperties;

  return (
    <div
      className={`messages-swipe-reply ${isMine ? 'is-mine' : 'is-theirs'}${isDragging ? ' is-dragging' : ''}${isArmed ? ' is-armed' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={event => finishGesture(event)}
      onPointerCancel={event => finishGesture(event, true)}
      onClickCapture={handleClickCapture}
      style={{ '--messages-reply-progress': progress, '--messages-reply-scale': 0.62 + progress * 0.38 } as CSSProperties}
    >
      <span className="messages-swipe-reply-icon" aria-hidden="true"><Reply size={18} strokeWidth={2.2} /></span>
      <div className={`messages-swipe-reply-content${isDragging ? ' is-dragging' : ''}`} style={gestureStyle}>
        <div className="messages-swipe-reply-body">{children}</div>
      </div>
    </div>
  );
}
