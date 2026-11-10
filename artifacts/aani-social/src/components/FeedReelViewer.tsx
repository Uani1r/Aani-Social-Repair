import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import ReelSlide from '@/components/ReelSlide';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import type { Post } from '@/lib/types';

type FeedReelViewerProps = {
  posts: Post[];
  initialIndex: number;
  initialPostId: string;
  initialPlaybackTime: number;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: (currentTime: number) => void;
};

type HorizontalDismissGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const HORIZONTAL_START_THRESHOLD = 8;
const HORIZONTAL_LOCK_RATIO = 0.45;
const EXIT_DISTANCE_RATIO = 0.22;
const DISMISS_TRANSITION_MS = 230;
const DISMISS_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export default function FeedReelViewer({ posts, initialIndex, initialPostId, initialPlaybackTime, currentUserId, onOpenComments, onRefresh, onClose }: FeedReelViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const matchingInitialIndex = posts.findIndex(post => post.id === initialPostId);
  const initialIndexRef = useRef(matchingInitialIndex >= 0 ? matchingInitialIndex : initialIndex);
  const playbackTimeRef = useRef(initialPlaybackTime);
  const gestureRef = useRef<HorizontalDismissGesture | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const closeViewer = () => {
    const video = scrollRef.current?.children[initialIndexRef.current]?.querySelector('video');
    if (video && video.readyState >= 1 && Number.isFinite(video.currentTime)) {
      playbackTimeRef.current = video.currentTime;
    }
    onClose(playbackTimeRef.current);
  };

  // زر الرجوع (الهاتف/المتصفح) يغلق عارض الريلز ويعيدك للتغذية بنفس اللحظة
  useOverlayBack(true, closeViewer);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const lastIndex = Math.max(0, container.children.length - 1);
    const index = Math.min(lastIndex, Math.max(0, Math.trunc(initialIndexRef.current)));
    container.scrollTop = index * container.clientHeight;
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.pointerType === 'mouse' && event.button !== 0) || gestureRef.current) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, input, textarea, select, a, [role="slider"], [data-feed-reel-swipe-ignore]')) return;
    const nearestDialog = target.closest('[role="dialog"]');
    if (nearestDialog && nearestDialog !== scrollRef.current) return;

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    const container = scrollRef.current;
    if (container) {
      container.style.transition = 'none';
      container.style.transform = 'translate3d(0, 0, 0)';
      container.style.opacity = '1';
    }
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(deltaX) < HORIZONTAL_START_THRESHOLD || Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_LOCK_RATIO) return;
      gesture.dragging = true;
    }

    const container = scrollRef.current;
    if (!container) return;
    const width = container.clientWidth || window.innerWidth;
    container.style.transform = `translate3d(${deltaX}px, 0, 0)`;
    container.style.opacity = String(Math.max(0.78, 1 - (Math.abs(deltaX) / width) * 0.18));
  };

  const settleSwipe = (event: ReactPointerEvent<HTMLDivElement>, shouldClose: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;

    const container = scrollRef.current;
    if (!container) return;
    const deltaX = event.clientX - gesture.startX;
    const width = container.clientWidth || window.innerWidth;
    const exitDistance = Math.max(76, width * EXIT_DISTANCE_RATIO);
    const closeDirection = Math.sign(deltaX);

    if (shouldClose && gesture.dragging && Math.abs(deltaX) >= exitDistance && closeDirection !== 0) {
      container.style.transition = `transform ${DISMISS_TRANSITION_MS}ms ${DISMISS_EASING}, opacity ${DISMISS_TRANSITION_MS}ms ease-out`;
      container.style.transform = `translate3d(${closeDirection * (width + 32)}px, 0, 0)`;
      container.style.opacity = '0.92';
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        closeViewer();
      }, DISMISS_TRANSITION_MS);
      return;
    }

    container.style.transition = `transform ${DISMISS_TRANSITION_MS}ms ${DISMISS_EASING}, opacity ${DISMISS_TRANSITION_MS}ms ease-out`;
    container.style.transform = 'translate3d(0, 0, 0)';
    container.style.opacity = '1';
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      const currentContainer = scrollRef.current;
      if (!currentContainer) return;
      currentContainer.style.transition = '';
      currentContainer.style.transform = '';
      currentContainer.style.opacity = '';
    }, DISMISS_TRANSITION_MS + 30);
  };

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  return (
    <div
      ref={scrollRef}
      className="reels-container feed-reel-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="استعراض فيديوهات التغذية"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={event => settleSwipe(event, true)}
      onPointerCancel={event => settleSwipe(event, false)}
      onTouchStart={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
      onTouchEnd={event => event.stopPropagation()}
      onTouchCancel={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
      onScroll={event => event.stopPropagation()}
    >
      {posts.map(post => (
        <ReelSlide
          key={post.id}
          post={post}
          currentUserId={currentUserId}
          onOpenComments={onOpenComments}
          onRefresh={onRefresh}
          onClose={closeViewer}
          initialPlaybackTime={post.id === initialPostId ? initialPlaybackTime : undefined}
          onPlaybackTimeChange={post.id === initialPostId ? time => {
            playbackTimeRef.current = time;
          } : undefined}
          showCreatedAt
          captionSheet
        />
      ))}
    </div>
  );
}
