import { useRef, type FormEvent, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Link } from 'wouter';
import { Ban, Eye, EyeOff, Flag, Heart, Loader2, MoreVertical, SendHorizontal, Trash2, UserRound, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { storyViewerDisplayName, type StoryDrawPoint, type StoryViewerEntry, type StoryViewerPreviewState } from '@/lib/appShared';
import { displayName, formatDate, type Profile } from '@/lib/types';

type StoryViewerProps = {
  currentStory: any;
  activeStories: any[];
  activeStoryIndex: number;
  progress: number;
  currentStoryFilter: { css: string };
  currentStoryFilterOverlay?: { color: string; opacity: number; blend: string } | null;
  storyVideoRef: { current: HTMLVideoElement | null };
  currentTimeSec: number;
  showUI: boolean;
  isPaused: boolean;
  isStoryOwner: boolean;
  originalStoryAuthor: Partial<Profile> | null;
  userId: string;
  showMenu: boolean;
  storyViewsOpen: boolean;
  storyViewsLoading: boolean;
  storyViewsError: boolean;
  storyViewsCount: number;
  storyViewers: StoryViewerEntry[];
  storyViewerPreview: StoryViewerPreviewState | null;
  viewerActionBusyId: string | null;
  viewerReportTarget: StoryViewerEntry | null;
  viewerReportCategory: 'spam' | 'harassment' | 'hate' | 'fake_account' | 'other';
  viewerReportDetails: string;
  viewerReportBusy: boolean;
  viewerRowMenuOpen: boolean;
  replyKeyboardInset: number;
  replyText: string;
  isSendingReply: boolean;
  isLiked: boolean;
  isLikeSaving: boolean;
  onMenuChange: (open: boolean) => void;
  onReportStory: () => void;
  onDeleteStory: () => void;
  onCloseViewer: () => void;
  onNextStory: () => void;
  onPreviousStory: () => void;
  onToggleShowUI: () => void;
  onPauseChange: (paused: boolean) => void;
  onOpenStoryViews: (wasPaused?: boolean) => void;
  onCloseStoryViews: () => void;
  onSendReply: () => void;
  onReplyTextChange: (text: string) => void;
  onReplyFocusChange: (focused: boolean) => void;
  onToggleLike: () => void;
  onViewerRowMenuOpenChange: (open: boolean) => void;
  onOpenViewerReport: (viewer: StoryViewerEntry) => void;
  onBlockStoryViewer: (viewer: StoryViewerEntry) => void;
  onHideStoryFromViewer: (viewer: StoryViewerEntry) => void;
  onToggleStoryViewerFollow: (viewer: StoryViewerEntry) => void;
  onViewerReportSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onViewerReportCancel: () => void;
  onViewerReportCategoryChange: (category: 'spam' | 'harassment' | 'hate' | 'fake_account' | 'other') => void;
  onViewerReportDetailsChange: (details: string) => void;
};

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
  onOpenStoryViews,
  onCloseStoryViews,
  onSendReply,
  onReplyTextChange,
  onReplyFocusChange,
  onToggleLike,
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
  const storyViewerTouchStartRef = useRef<StoryViewerTouchStart | null>(null);
  const storyViewerPausedBeforeTouchRef = useRef(false);
  const suppressStoryClickUntilRef = useRef(0);

  const suppressStoryClick = () => {
    const suppressUntil = Date.now() + 700;
    suppressStoryClickUntilRef.current = suppressUntil;
    window.setTimeout(() => {
      if (suppressStoryClickUntilRef.current === suppressUntil) {
        suppressStoryClickUntilRef.current = 0;
      }
    }, 700);
  };

  const handleStoryViewerTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    suppressStoryClickUntilRef.current = 0;
    storyViewerPausedBeforeTouchRef.current = isPaused;
    if (event.touches.length !== 1) {
      storyViewerTouchStartRef.current = null;
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
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
      storyViewerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - start.lastX;
    const deltaY = touch.clientY - start.lastY;
    storyViewerTouchStartRef.current = {
      ...start,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: start.pathLength + Math.hypot(deltaX, deltaY),
    };
  };

  const handleStoryViewerTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = storyViewerTouchStartRef.current;
    storyViewerTouchStartRef.current = null;
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
          <div className="absolute inset-x-2 z-30 flex gap-1 px-1" style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}>
            {activeStories.map((story, index) => (
              <div key={story.id} className="h-0.5 flex-1 bg-white/[0.18] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#d0d0d8] transition-all duration-75 ease-linear"
                  style={{ width: index < activeStoryIndex ? '100%' : index === activeStoryIndex ? `${progress}%` : '0%' }}
                />
              </div>
            ))}
          </div>
        )}

        {showUI && (
          <div className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent" style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}>
            <div className="flex min-w-0 flex-col items-start gap-1">
              <Link href={`/profile/${currentStory.user_id}`} className="flex min-w-0 items-center gap-2">
                <Avatar profile={currentStory.author} storyBorder={false} />
                <div className="user-identity-meta h-8 min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-bold text-xs">{displayName(currentStory.author)}</span>
                    {currentStory.is_close_friends && (
                      <span className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold">أصدقاء مقربون</span>
                    )}
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-zinc-300" dir="ltr">{currentStory.author?.username}</span>
                    <span className="shrink-0 text-[10px] text-zinc-300">{formatDate(currentStory.created_at)}</span>
                  </div>
                </div>
              </Link>
              {currentStory.original_story_id && originalStoryAuthor && (
                <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/85 backdrop-blur-sm">
                  {originalStoryAuthor.avatar_url ? (
                    <img src={originalStoryAuthor.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[7px] font-bold">
                      {displayName(originalStoryAuthor).replace('@', '').charAt(0)}
                    </span>
                  )}
                  <span className="max-w-[42vw] truncate text-[9px]">من قصة {displayName(originalStoryAuthor)}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-story-viewer-menu-toggle="true"
                aria-label="خيارات الستوري"
                onClick={() => onMenuChange(!showMenu)}
                className="p-1 hover:bg-white/20 rounded-full"
              >
                <MoreVertical size={18} />
              </button>
              <button onClick={onCloseViewer} className="p-1 hover:bg-white/20 rounded-full">
                <X size={20} />
              </button>
            </div>
          </div>
        )}

        {showMenu && (
          <div data-story-viewer-menu="true" className="absolute top-14 left-3 z-40 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl text-xs space-y-1">
            {currentStory.user_id === userId ? (
              <button onClick={onDeleteStory} className="flex items-center gap-2 text-red-400 p-2 w-full hover:bg-zinc-800 rounded-lg">
                <Trash2 size={14} /> حذف الستوري
              </button>
            ) : (
              <button onClick={onReportStory} className="p-2 w-full text-zinc-300 hover:bg-zinc-800 rounded-lg">
                إبلاغ عن الستوري
              </button>
            )}
          </div>
        )}

        <div className="absolute inset-0 flex h-full w-full items-center justify-center bg-zinc-950">
          {currentStory.media_url ? (
            currentStory.media_type === 'video' ? (
              <video
                ref={storyVideoRef}
                key={currentStory.id}
                src={currentStory.media_url}
                autoPlay
                playsInline
                preload="metadata"
                className="h-full w-full object-contain"
                style={{ filter: currentStoryFilter.css }}
              />
            ) : (
              <img src={currentStory.media_url} alt="" className="h-full w-full object-contain" style={{ filter: currentStoryFilter.css }} />
            )
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#1f1f27] p-6 text-center text-base font-bold text-white">
              {currentStory.caption}
            </div>
          )}

          {currentStoryFilterOverlay && (
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: currentStoryFilterOverlay.color,
                opacity: currentStoryFilterOverlay.opacity,
                mixBlendMode: currentStoryFilterOverlay.blend as never,
              }}
            />
          )}

          {(Array.isArray(currentStory.timed_texts) ? currentStory.timed_texts : []).map((timedText: any) => {
            if (!timedText || currentTimeSec < timedText.startTime || currentTimeSec > timedText.endTime) return null;

            if (timedText.type === 'drawing' && Array.isArray(timedText.strokes)) {
              return (
                <svg
                  key={timedText.id || 'story-drawing'}
                  className="pointer-events-none absolute inset-0 z-20 h-full w-full"
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {timedText.strokes.map((stroke: any, index: number) => {
                    const points = Array.isArray(stroke?.points)
                      ? stroke.points.filter((point: any) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
                      : [];
                    if (points.length === 0) return null;
                    const first = points[0];
                    const path = points.length === 1
                      ? `M ${first.x * 1000} ${first.y * 1000} L ${first.x * 1000 + 0.01} ${first.y * 1000}`
                      : points.map((point: StoryDrawPoint, pointIndex: number) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x * 1000} ${point.y * 1000}`).join(' ');
                    const width = Number.isFinite(stroke.size) ? Math.min(24, Math.max(1, stroke.size)) : 5;
                    return (
                      <path
                        key={stroke.id || index}
                        d={path}
                        fill="none"
                        stroke={typeof stroke.color === 'string' ? stroke.color : '#FFFFFF'}
                        strokeWidth={width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </svg>
              );
            }

            return (
              <div
                key={timedText.id}
                style={{ top: `${timedText.y}%`, left: `${timedText.x}%`, transform: 'translate(-50%, -50%)' }}
                className="absolute bg-black/70 text-white font-bold px-3 py-1.5 rounded-xl text-xs border border-white/20 backdrop-blur-sm z-20"
              >
                {timedText.text}
              </div>
            );
          })}

          {currentStory.caption && currentStory.media_url && (
            <div
              className="absolute inset-x-4 z-10 rounded-xl bg-black/60 p-3 text-center text-xs text-white backdrop-blur-md"
              style={{ bottom: isStoryOwner
                ? 'calc(4.5rem + env(safe-area-inset-bottom))'
                : `calc(5.5rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
            >
              {currentStory.caption}
            </div>
          )}

          <div className="absolute inset-y-0 left-0 w-1/3 z-20" onClick={onNextStory} />
          <div className="absolute inset-y-0 right-0 w-1/3 z-20" onClick={onPreviousStory} />
          <div
            className="absolute inset-y-0 left-1/3 w-1/3 z-20"
            onClick={onToggleShowUI}
            onMouseDown={() => onPauseChange(true)}
            onMouseUp={() => onPauseChange(false)}
            onTouchStart={() => onPauseChange(true)}
            onTouchEnd={() => onPauseChange(false)}
          />
        </div>

        {isStoryOwner && <div className="absolute inset-x-0 bottom-0 z-[25] h-24" aria-hidden="true" />}

        {showUI && isStoryOwner && (
          <button
            type="button"
            onClick={() => onOpenStoryViews()}
            aria-label="عرض مشاهدات الستوري"
            title="عرض المشاهدات"
            className="absolute left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center text-white drop-shadow-[0_1px_5px_rgba(0,0,0,0.9)]"
            style={{ bottom: 'calc(0.65rem + env(safe-area-inset-bottom))' }}
          >
            <Eye size={23} />
          </button>
        )}

        {showUI && !isStoryOwner && (
          <div
            className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pt-5"
            style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex min-w-0 flex-1 items-center rounded-full border border-zinc-700/70 bg-zinc-900/95 px-3 py-2 shadow-lg">
              <input
                key={currentStory.id}
                type="text"
                placeholder="رد على الستوري..."
                aria-label="اكتب رداً على الستوري"
                maxLength={3900}
                value={replyText}
                disabled={isSendingReply}
                onFocus={() => onReplyFocusChange(true)}
                onBlur={() => onReplyFocusChange(false)}
                onChange={event => onReplyTextChange(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    onSendReply();
                  }
                }}
                className="w-full min-w-0 bg-transparent text-xs text-white outline-none placeholder-zinc-400 disabled:opacity-60"
              />
              {replyText.trim() && (
                <button
                  type="button"
                  onClick={onSendReply}
                  disabled={isSendingReply}
                  aria-label="إرسال الرد"
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pink-400 transition hover:bg-white/10 disabled:opacity-50"
                >
                  {isSendingReply ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onToggleLike}
              disabled={isLikeSaving}
              aria-label={isLiked ? 'إلغاء الإعجاب بالستوري' : 'الإعجاب بالستوري'}
              aria-pressed={isLiked}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-700/70 bg-zinc-900/90 transition disabled:opacity-50 ${isLiked ? 'text-pink-500' : 'text-white'}`}
            >
              {isLikeSaving ? <Loader2 size={17} className="animate-spin" /> : <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />}
            </button>
          </div>
        )}

        {storyViewsOpen && isStoryOwner && (
          <>
            <button
              type="button"
              aria-label="إغلاق قائمة المشاهدات"
              className="absolute inset-0 z-[60] bg-black/45"
              onClick={event => {
                event.stopPropagation();
                onCloseStoryViews();
              }}
            />
            <section
              data-story-viewers-panel="true"
              className="absolute inset-x-0 bottom-0 z-[70] flex h-[88dvh] max-h-[90dvh] flex-col overflow-hidden rounded-t-3xl border-t border-white/10 bg-zinc-950/95 px-4 pt-2 shadow-2xl backdrop-blur-xl"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
              role="dialog"
              aria-modal="true"
              aria-label="مشاهدات الستوري"
              onClick={event => event.stopPropagation()}
            >
              <div data-story-viewers-panel-header="true" className="mx-auto mb-3 mt-1 h-1 w-10 rounded-full bg-white/30" />
              <div data-story-viewers-panel-header="true" className="mb-1 flex items-center justify-between">
                <h2 className="text-sm font-bold text-white">المشاهدات</h2>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400">{storyViewsCount}</span>
                  <button
                    type="button"
                    onClick={onCloseStoryViews}
                    aria-label="إغلاق"
                    className="rounded-full p-1 text-zinc-300 transition hover:bg-white/10"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {storyViewsLoading && (
                  <div className="flex items-center justify-center py-5 text-zinc-400" role="status" aria-label="جارٍ تحميل المشاهدات">
                    <Loader2 size={20} className="animate-spin" />
                  </div>
                )}
                {storyViewsError && (
                  <p className="py-5 text-center text-xs text-red-300">تعذر تحميل بيانات المشاهدين أو الإعجابات الفعلية. تحقق من قاعدة البيانات والاتصال.</p>
                )}
                {!storyViewsLoading && !storyViewsError && storyViewers.length > 0 && (
                  <ul className="space-y-2">
                    {storyViewers.map(item => (
                      <li key={`${currentStory.id}:${item.user_id}`} className="flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-white/[0.03]">
                        <Avatar profile={item.viewer} />
                        <div className="min-w-0 flex-1">
                          <div className="user-identity-meta h-8">
                            <p className="truncate text-xs font-semibold leading-tight text-white">{storyViewerDisplayName(item.viewer)}</p>
                            <p className="truncate text-[10px] leading-none text-zinc-400" dir="ltr">{item.viewer?.username || 'اسم المستخدم غير متاح'}</p>
                          </div>
                          <time className="mt-1 block text-[10px] text-zinc-500">{formatDate(item.viewed_at)}</time>
                        </div>
                        {item.is_liked && (
                          <Heart size={16} fill="currentColor" className="shrink-0 text-pink-500" aria-label="أعجب بالستوري" />
                        )}
                        <DropdownMenu onOpenChange={onViewerRowMenuOpenChange}>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`خيارات ${item.viewer?.username || 'المشاهد'}`}
                              disabled={Boolean(viewerActionBusyId)}
                              className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                            >
                              <MoreVertical size={18} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="z-[150] min-w-48 border-zinc-800 bg-zinc-900 text-white">
                            <DropdownMenuItem onSelect={() => onOpenViewerReport(item)}>
                              <Flag size={15} /> الإبلاغ عن الحساب
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-amber-300 focus:text-amber-200" onSelect={() => onBlockStoryViewer(item)}>
                              <Ban size={15} /> حظر الحساب
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onHideStoryFromViewer(item)}>
                              <EyeOff size={15} /> إخفاء الستوري عنه
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onToggleStoryViewerFollow(item)}>
                              <UserRound size={15} />
                              {item.is_following
                                ? 'إلغاء المتابعة'
                                : item.follow_request_pending
                                  ? 'إلغاء طلب المتابعة'
                                  : item.viewer?.is_private
                                    ? 'طلب متابعة'
                                    : 'متابعة'}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    ))}
                  </ul>
                )}

                {storyViewerPreview?.storyId === currentStory.id && storyViewerPreview.expiresAt > Date.now() && storyViewerPreview.rows.length > 0 && (
                  <div className="mt-1">
                    <ul className="space-y-2">
                      {storyViewerPreview.rows.map(item => (
                        <li key={`preview:${currentStory.id}:${item.user_id}`} className="flex items-center gap-2 py-2">
                          <Avatar profile={item.viewer} />
                          <div className="min-w-0 flex-1">
                            <div className="user-identity-meta h-8">
                              <p className="truncate text-xs font-semibold leading-tight text-white">{storyViewerDisplayName(item.viewer)}</p>
                              <p className="truncate text-[10px] leading-none text-zinc-400" dir="ltr">{item.viewer?.username || 'اسم المستخدم غير متاح'}</p>
                            </div>
                            <time className="mt-1 block text-[10px] text-zinc-500">{formatDate(item.viewed_at)} · معاينة</time>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>

            {viewerReportTarget && (
              <div
                className="absolute inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
                onClick={() => {
                  if (!viewerReportBusy) onViewerReportCancel();
                }}
              >
                <form
                  dir="rtl"
                  onSubmit={onViewerReportSubmit}
                  onClick={event => event.stopPropagation()}
                  className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-4 text-white shadow-2xl"
                >
                  <h3 className="text-sm font-bold">الإبلاغ عن الحساب</h3>
                  <p className="mt-1 text-[11px] text-zinc-400">{storyViewerDisplayName(viewerReportTarget.viewer)}</p>
                  <label className="mt-4 block text-[11px] text-zinc-300">
                    سبب الإبلاغ
                    <select
                      required
                      value={viewerReportCategory}
                      onChange={event => onViewerReportCategoryChange(event.target.value as typeof viewerReportCategory)}
                      className="mt-1.5 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-xs text-white outline-none focus:border-sky-400"
                    >
                      <option value="spam">رسائل أو محتوى مزعج</option>
                      <option value="harassment">مضايقة أو تنمّر</option>
                      <option value="hate">خطاب كراهية</option>
                      <option value="fake_account">حساب منتحل أو مزيف</option>
                      <option value="other">سبب آخر</option>
                    </select>
                  </label>
                  <label className="mt-3 block text-[11px] text-zinc-300">
                    تفاصيل إضافية (اختياري)
                    <textarea
                      value={viewerReportDetails}
                      onChange={event => onViewerReportDetailsChange(event.target.value)}
                      maxLength={1000}
                      rows={3}
                      className="mt-1.5 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-xs text-white outline-none focus:border-sky-400"
                    />
                  </label>
                  <div className="mt-4 flex gap-2">
                    <button type="button" disabled={viewerReportBusy} onClick={onViewerReportCancel} className="h-10 flex-1 rounded-lg border border-zinc-700 text-xs text-zinc-300 disabled:opacity-50">
                      إلغاء
                    </button>
                    <button type="submit" disabled={viewerReportBusy} className="h-10 flex-1 rounded-lg bg-sky-500 text-xs font-bold text-zinc-950 disabled:opacity-50">
                      {viewerReportBusy ? <Loader2 size={15} className="mx-auto animate-spin" /> : 'إرسال البلاغ'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
