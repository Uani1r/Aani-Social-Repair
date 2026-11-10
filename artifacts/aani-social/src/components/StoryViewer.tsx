import { useEffect, useRef, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';

import StoryHeader from './story/StoryHeader';
import StoryMediaStage from './story/StoryMediaStage';
import StoryProgressBar from './story/StoryProgressBar';
import StoryReplyControls from './story/StoryReplyControls';
import StoryViewersPanel from './story/StoryViewersPanel';
import { preloadMedia } from '@/lib/mediaPreload';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import type { StoryViewerProps } from './story/types';

type StoryViewerTouchStart = {
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  pathLength: number;
  startedInViewersPanel: boolean;
};

export default function StoryViewer({
  currentStory,
  activeStories,
  activeStoryIndex,
  progress,
  currentStoryFilter,
  currentStoryFilterOverlay,
  storyVideoRef,
  currentTimeSec,
  showUI,
  isPaused,
  isStoryOwner,
  isArchivedStory,
  originalStoryAuthor,
  userId,
  showMenu,
  storyViewsOpen,
  storyViewsLoading,
  storyViewsError,
  storyViewsCount,
  storyViewers,
  storyViewerPreview,
  viewerActionBusyId,
  viewerReportTarget,
  viewerReportCategory,
  viewerReportDetails,
  viewerReportBusy,
  viewerRowMenuOpen,
  replyKeyboardInset,
  replyText,
  isSendingReply,
  isLiked,
  isLikeSaving,
  onMenuChange,
  onReportStory,
  onDeleteStory,
  onCloseViewer,
  onNextStory,
  onPreviousStory,
  onToggleShowUI,
  onPauseChange,
  onVideoMetadata,
  onVideoTimeUpdate,
  onVideoEnded,
  onOpenStoryViews,
  onCloseStoryViews,
  onSendReply,
  onReplyTextChange,
  onReplyFocusChange,
  onToggleLike,
  onReshareArchivedStory,
  onViewerRowMenuOpenChange,
  onOpenViewerReport,
  onBlockStoryViewer,
  onHideStoryFromViewer,
  onToggleStoryViewerFollow,
  onViewerReportSubmit,
  onViewerReportCancel,
  onViewerReportCategoryChange,
  onViewerReportDetailsChange,
}: StoryViewerProps) {
  // زر الرجوع (الهاتف/المتصفح) يغلق عارض الستوري ويعيدك لنفس المكان
  useOverlayBack(Boolean(currentStory), onCloseViewer);
  const storyViewerTouchStartRef = useRef<StoryViewerTouchStart | null>(null);
  const storyViewerPausedBeforeTouchRef = useRef(false);
  const suppressStoryClickUntilRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressActiveRef = useRef(false);
  const longPressPausedBeforeRef = useRef(false);
  const longPressShowUIBeforeRef = useRef(true);
  const longPressMouseStartRef = useRef<{ x: number; y: number } | null>(null);
  const ignoreMouseUntilRef = useRef(0);

  const suppressStoryClick = () => {
    const suppressUntil = Date.now() + 700;
    suppressStoryClickUntilRef.current = suppressUntil;
    window.setTimeout(() => {
      if (suppressStoryClickUntilRef.current === suppressUntil) {
        suppressStoryClickUntilRef.current = 0;
      }
    }, 700);
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const startLongPress = (target: Element | null) => {
    if (
      showMenu
      || storyViewsOpen
      || viewerReportTarget
      || viewerRowMenuOpen
      || target?.closest('button, a, input, textarea, select, [contenteditable="true"], [data-story-viewers-panel], [data-story-viewer-menu]')
    ) return;

    clearLongPressTimer();
    longPressActiveRef.current = false;
    longPressPausedBeforeRef.current = isPaused;
    longPressShowUIBeforeRef.current = showUI;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressActiveRef.current = true;
      if (showUI) onToggleShowUI();
      onPauseChange(true);
      storyVideoRef.current?.pause();
    }, 350);
  };

  const finishLongPress = () => {
    clearLongPressTimer();
    if (!longPressActiveRef.current) return;

    longPressActiveRef.current = false;
    suppressStoryClick();
    onPauseChange(longPressPausedBeforeRef.current);
    if (showUI !== longPressShowUIBeforeRef.current) onToggleShowUI();
    if (!longPressPausedBeforeRef.current) {
      void storyVideoRef.current?.play().catch(() => {});
    }
  };

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  // تهيئة الستوري التالي مسبقاً (صورة/بيانات وصفية للفيديو) أثناء
  // عرض الستوري الحالي، فلا انتظار شبكة عند الانتقال للقصة الموالية.
  useEffect(() => {
    const nextStory = activeStories[activeStoryIndex + 1];
    if (nextStory?.media_url) preloadMedia(nextStory.media_url);
  }, [activeStories, activeStoryIndex]);

  const handleStoryViewerTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    suppressStoryClickUntilRef.current = 0;
    ignoreMouseUntilRef.current = Date.now() + 800;
    storyViewerPausedBeforeTouchRef.current = isPaused;
    if (event.touches.length !== 1) {
      finishLongPress();
      storyViewerTouchStartRef.current = null;
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    startLongPress(target);
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
      storyViewerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    storyViewerTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: 0,
      startedInViewersPanel: Boolean(target?.closest('[data-story-viewers-panel]')),
    };
  };

  const handleStoryViewerTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = storyViewerTouchStartRef.current;
    if (!start) return;
    if (event.touches.length !== 1) {
      finishLongPress();
      storyViewerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - start.lastX;
    const deltaY = touch.clientY - start.lastY;
    const updatedStart = {
      ...start,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: start.pathLength + Math.hypot(deltaX, deltaY),
    };
    storyViewerTouchStartRef.current = updatedStart;
    if (updatedStart.pathLength > 12) clearLongPressTimer();
  };

  const handleStoryViewerTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const wasLongPress = longPressActiveRef.current;
    finishLongPress();
    const start = storyViewerTouchStartRef.current;
    storyViewerTouchStartRef.current = null;
    if (wasLongPress) return;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;

    const deltaY = touch.clientY - start.y;
    const finalSegment = Math.hypot(touch.clientX - start.lastX, touch.clientY - start.lastY);
    const totalTravel = start.pathLength + finalSegment;
    const isClearSwipe = Math.abs(deltaY) >= 64 && totalTravel >= 72;

    if (storyViewsOpen) {
      if (viewerReportTarget || viewerRowMenuOpen) {
        if (isClearSwipe) suppressStoryClick();
        return;
      }
      if (isClearSwipe && isStoryOwner && deltaY > 0 && start.startedInViewersPanel) {
        suppressStoryClick();
        onCloseStoryViews();
        return;
      }
      if (isClearSwipe) suppressStoryClick();
      return;
    }

    if (showMenu) {
      if (isClearSwipe) suppressStoryClick();
      return;
    }
    if (!isClearSwipe) return;

    suppressStoryClick();

    if (deltaY < 0 && isStoryOwner) {
      onOpenStoryViews(storyViewerPausedBeforeTouchRef.current);
      return;
    }

    if (deltaY > 0) onCloseViewer();
  };

  const handleStoryViewerTouchCancel = () => {
    finishLongPress();
    storyViewerTouchStartRef.current = null;
  };

  return (
    <div
      className="fixed inset-0 z-[110] h-[100dvh] w-screen overflow-hidden bg-[#0d0d0d] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="عارض القصص"
      onTouchStartCapture={handleStoryViewerTouchStart}
      onTouchMoveCapture={handleStoryViewerTouchMove}
      onTouchEnd={handleStoryViewerTouchEnd}
      onTouchCancel={handleStoryViewerTouchCancel}
      onMouseDown={event => {
        if (Date.now() < ignoreMouseUntilRef.current || event.button !== 0) return;
        longPressMouseStartRef.current = { x: event.clientX, y: event.clientY };
        const target = event.target instanceof Element ? event.target : null;
        startLongPress(target);
      }}
      onMouseMove={event => {
        const start = longPressMouseStartRef.current;
        if (start && longPressTimerRef.current !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
          clearLongPressTimer();
          longPressMouseStartRef.current = null;
        }
      }}
      onMouseUp={() => {
        longPressMouseStartRef.current = null;
        finishLongPress();
      }}
      onMouseLeave={() => {
        longPressMouseStartRef.current = null;
        finishLongPress();
      }}
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        const isMenuInteraction = target?.closest('[data-story-viewer-menu], [data-story-viewer-menu-toggle]');
        if (showMenu && !isMenuInteraction) {
          onMenuChange(false);
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        if (Date.now() < suppressStoryClickUntilRef.current) {
          suppressStoryClickUntilRef.current = 0;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="relative h-full w-full overflow-hidden bg-black select-none">
        {showUI && (
          <StoryProgressBar
            activeStories={activeStories}
            activeStoryIndex={activeStoryIndex}
            progress={progress}
          />
        )}

        <StoryHeader
          currentStory={currentStory}
          originalStoryAuthor={originalStoryAuthor}
          userId={userId}
          showUI={showUI}
          showMenu={showMenu}
          onMenuChange={onMenuChange}
          onReportStory={onReportStory}
          onDeleteStory={onDeleteStory}
          onCloseViewer={onCloseViewer}
        />

        <StoryMediaStage
          currentStory={currentStory}
          currentStoryFilter={currentStoryFilter}
          currentStoryFilterOverlay={currentStoryFilterOverlay}
          storyVideoRef={storyVideoRef}
          currentTimeSec={currentTimeSec}
          isStoryOwner={isStoryOwner}
          replyKeyboardInset={replyKeyboardInset}
          onNextStory={onNextStory}
          onPreviousStory={onPreviousStory}
          onToggleShowUI={onToggleShowUI}
          onPauseChange={onPauseChange}
          isPaused={isPaused}
          showUI={showUI}
          onVideoMetadata={onVideoMetadata}
          onVideoTimeUpdate={onVideoTimeUpdate}
          onVideoEnded={onVideoEnded}
        />

        <StoryReplyControls
          currentStory={currentStory}
          showUI={showUI}
          isStoryOwner={isStoryOwner}
          isArchivedStory={isArchivedStory}
          replyKeyboardInset={replyKeyboardInset}
          replyText={replyText}
          isSendingReply={isSendingReply}
          isLiked={isLiked}
          isLikeSaving={isLikeSaving}
          onOpenStoryViews={onOpenStoryViews}
          onSendReply={onSendReply}
          onReplyTextChange={onReplyTextChange}
          onReplyFocusChange={onReplyFocusChange}
          onToggleLike={onToggleLike}
          onReshareArchivedStory={onReshareArchivedStory}
        />

        <StoryViewersPanel
          currentStory={currentStory}
          storyViewsOpen={storyViewsOpen}
          isStoryOwner={isStoryOwner}
          storyViewsLoading={storyViewsLoading}
          storyViewsError={storyViewsError}
          storyViewsCount={storyViewsCount}
          storyViewers={storyViewers}
          storyViewerPreview={storyViewerPreview}
          viewerActionBusyId={viewerActionBusyId}
          viewerReportTarget={viewerReportTarget}
          viewerReportCategory={viewerReportCategory}
          viewerReportDetails={viewerReportDetails}
          viewerReportBusy={viewerReportBusy}
          onCloseStoryViews={onCloseStoryViews}
          onViewerRowMenuOpenChange={onViewerRowMenuOpenChange}
          onOpenViewerReport={onOpenViewerReport}
          onBlockStoryViewer={onBlockStoryViewer}
          onHideStoryFromViewer={onHideStoryFromViewer}
          onToggleStoryViewerFollow={onToggleStoryViewerFollow}
          onViewerReportSubmit={onViewerReportSubmit}
          onViewerReportCancel={onViewerReportCancel}
          onViewerReportCategoryChange={onViewerReportCategoryChange}
          onViewerReportDetailsChange={onViewerReportDetailsChange}
        />
      </div>
    </div>
  );
}
