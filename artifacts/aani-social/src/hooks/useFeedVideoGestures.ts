import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type HoldZone = 'center' | 'left' | 'right';
type GestureState = {
  pointerId: number;
  zone: HoldZone;
  startX: number;
  startY: number;
  wasPlaying: boolean;
  activated: boolean;
  moved: boolean;
};

const HOLD_DELAY_MS = 220;
const TAP_MOVE_THRESHOLD = 18;
const CONTROLS_VISIBLE_MS = 2400;

export function useFeedVideoGestures(
  videoRef: { current: HTMLVideoElement | null },
  enabled: boolean,
  onSingleTap: () => void,
) {
  const [controlsVisible, setControlsVisible] = useState(false);
  const [acceleratedSide, setAcceleratedSide] = useState<'left' | 'right' | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const onSingleTapRef = useRef(onSingleTap);

  useEffect(() => {
    onSingleTapRef.current = onSingleTap;
  }, [onSingleTap]);

  const revealControlsBriefly = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      controlsTimerRef.current = null;
      setControlsVisible(false);
    }, CONTROLS_VISIBLE_MS);
  }, []);

  const clearHoldTimer = () => {
    if (holdTimerRef.current === null) return;
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  const finishGesture = (pointerId: number, allowTap: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    clearHoldTimer();
    gestureRef.current = null;

    const video = videoRef.current;
    if (video && gesture.activated) {
      if (gesture.zone === 'center') {
        if (gesture.wasPlaying && video.paused) void video.play().catch(() => undefined);
      } else {
        video.playbackRate = 1;
        if (!gesture.wasPlaying && !video.paused) video.pause();
      }
    }
    setAcceleratedSide(null);
    if (allowTap && !gesture.activated && !gesture.moved) onSingleTapRef.current();
    revealControlsBriefly();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.pointerType === 'mouse' && event.button !== 0) || gestureRef.current) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, select, a, [role="slider"]')) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - bounds.left;
    const zone: HoldZone = position < bounds.width / 3
      ? 'left'
      : position > bounds.width * (2 / 3)
        ? 'right'
        : 'center';
    const video = videoRef.current;
    gestureRef.current = {
      pointerId: event.pointerId,
      zone,
      startX: event.clientX,
      startY: event.clientY,
      wasPlaying: Boolean(video && !video.paused),
      activated: false,
      moved: false,
    };
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
    setControlsVisible(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in every embedded browser.
    }

    holdTimerRef.current = window.setTimeout(() => {
      const activeGesture = gestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== event.pointerId || activeGesture.moved) return;
      activeGesture.activated = true;
      const activeVideo = videoRef.current;
      if (!activeVideo) return;
      if (activeGesture.zone === 'center') {
        if (!activeVideo.paused) activeVideo.pause();
      } else {
        activeVideo.playbackRate = 2;
        setAcceleratedSide(activeGesture.zone);
        if (activeVideo.paused) void activeVideo.play().catch(() => undefined);
      }
    }, HOLD_DELAY_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.activated) return;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) <= TAP_MOVE_THRESHOLD) return;
    gesture.moved = true;
    clearHoldTimer();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => finishGesture(event.pointerId, true);
  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => finishGesture(event.pointerId, false);

  useEffect(() => () => {
    clearHoldTimer();
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current);
    if (videoRef.current) videoRef.current.playbackRate = 1;
  }, [videoRef]);

  return {
    controlsVisible,
    acceleratedSide,
    revealControlsBriefly,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
