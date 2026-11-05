import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  wasPlaying: boolean;
  activated: boolean;
  moved: boolean;
};

const HOLD_DELAY_MS = 220;
const TAP_MOVE_THRESHOLD = 18;
const VERTICAL_SCROLL_CANCEL_THRESHOLD = 5;
const CONTROLS_VISIBLE_MS = 2400;

type FeedVideoGestureOptions = {
  allowVerticalScroll?: boolean;
  capturePointer?: boolean;
};

export function useFeedVideoGestures(
  videoRef: { current: HTMLVideoElement | null },
  enabled: boolean,
  onSingleTap: () => void,
  options: FeedVideoGestureOptions = {},
) {
  const allowVerticalScroll = options.allowVerticalScroll ?? false;
  const capturePointer = options.capturePointer ?? true;
  const [controlsVisible, setControlsVisible] = useState(false);
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

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current === null) return;
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const resumeAfterCancelledHold = (gesture: GestureState) => {
    const video = videoRef.current;
    if (video && gesture.activated && gesture.wasPlaying && video.paused) {
      void video.play().catch(() => undefined);
    }
  };

  const cancelGesture = (pointerId: number) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    clearHoldTimer();
    gestureRef.current = null;
    resumeAfterCancelledHold(gesture);
  };

  const finishGesture = (pointerId: number, allowTap: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    clearHoldTimer();
    gestureRef.current = null;

    resumeAfterCancelledHold(gesture);
    if (allowTap && !gesture.activated && !gesture.moved) onSingleTapRef.current();
    revealControlsBriefly();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.pointerType === 'mouse' && event.button !== 0) || gestureRef.current) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, select, a, [role="slider"]')) return;

    const video = videoRef.current;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      wasPlaying: Boolean(video && !video.paused),
      activated: false,
      moved: false,
    };
    if (!allowVerticalScroll) {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = null;
      }
      setControlsVisible(true);
    }
    if (capturePointer) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is not available in every embedded browser.
      }
    }

    holdTimerRef.current = window.setTimeout(() => {
      const activeGesture = gestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== event.pointerId || activeGesture.moved) return;
      activeGesture.activated = true;
      const activeVideo = videoRef.current;
      if (activeVideo && !activeVideo.paused) activeVideo.pause();
    }, HOLD_DELAY_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (allowVerticalScroll && Math.abs(event.clientY - gesture.startY) > VERTICAL_SCROLL_CANCEL_THRESHOLD) {
      cancelGesture(event.pointerId);
      return;
    }
    if (gesture.activated) return;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) <= TAP_MOVE_THRESHOLD) return;
    gesture.moved = true;
    clearHoldTimer();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => finishGesture(event.pointerId, true);
  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    if (allowVerticalScroll) cancelGesture(event.pointerId);
    else finishGesture(event.pointerId, false);
  };

  useEffect(() => () => {
    clearHoldTimer();
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current);
  }, []);

  return {
    controlsVisible,
    revealControlsBriefly,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
