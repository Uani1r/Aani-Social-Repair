import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Loader2, MessageCircle } from 'lucide-react';

import FeedPostCard from '../components/FeedPostCard';
import type { StoryRow as StoryDmCardStory } from '../components/StoryDmCard';
import { isHorizontalGestureArea } from '@/lib/appShared';
import { usePosts } from '@/hooks/usePosts';
import { getPendingPosts, removePendingPost, retryPendingPost, subscribePendingPosts, type PendingPost } from '@/lib/pendingPosts';
import { getPostDestination, type Profile } from '@/lib/types';

const savedFeedScrollPositions = new Map<string, number>();

const saveFeedScrollPosition = (userId: string, scrollTop: number) => {
  savedFeedScrollPositions.set(userId, scrollTop);
  try {
    window.sessionStorage.setItem(`aani:feed-scroll:${userId}`, String(scrollTop));
  } catch {
    // Keep the in-memory position when session storage is unavailable.
  }
};

const getSavedFeedScrollPosition = (userId: string) => {
  const inMemoryPosition = savedFeedScrollPositions.get(userId) || 0;
  try {
    return Number(window.sessionStorage.getItem(`aani:feed-scroll:${userId}`)) || inMemoryPosition;
  } catch {
    return inMemoryPosition;
  }
};

const getPageScrollTop = () => Math.max(
  0,
  window.scrollY || 0,
  document.documentElement.scrollTop || 0,
  document.body.scrollTop || 0,
);

const hasOpenFeedDialog = () => Boolean(document.querySelector(
  '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
));

interface StoriesBarProps {
  userId: string;
  currentProfile: Profile | null;
  pendingReshare: StoryDmCardStory | null;
  onReshareHandled: () => void;
  pendingProfileStoryOwnerId: string | null;
  pendingStoryId: string | null;
  onProfileStoryHandled: () => void;
}

interface FeedPageProps {
  userId: string;
  profile: Profile | null;
  onOpenComments: (postId: string) => void;
  pendingStoryReshare: StoryDmCardStory | null;
  onStoryReshareHandled: () => void;
  pendingProfileStoryOwnerId: string | null;
  pendingStoryId: string | null;
  onProfileStoryHandled: () => void;
  StoriesBarComponent: React.ComponentType<StoriesBarProps>;
}

export default function FeedPage({
  userId,
  profile,
  onOpenComments,
  pendingStoryReshare,
  onStoryReshareHandled,
  pendingProfileStoryOwnerId,
  pendingStoryId,
  onProfileStoryHandled,
  StoriesBarComponent,
}: FeedPageProps) {
  const { posts, loading, refresh, error } = usePosts('feed', undefined, userId);
  const [pendingPosts, setPendingPosts] = useState<PendingPost[]>(getPendingPosts);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullGestureRef = useRef<{ x: number; y: number; lastX: number; lastY: number; pathLength: number } | null>(null);
  const refreshingRef = useRef(false);
  const feedMountedRef = useRef(false);
  const refreshIndicatorTimerRef = useRef<number | null>(null);
  const initialScrollTopRef = useRef(getSavedFeedScrollPosition(userId));
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => subscribePendingPosts(() => setPendingPosts(getPendingPosts())), []);

  useEffect(() => {
    const saveScrollPosition = () => {
      if (!loadingRef.current && !hasOpenFeedDialog()) {
        saveFeedScrollPosition(userId, getPageScrollTop());
      }
    };
    window.addEventListener('scroll', saveScrollPosition, { passive: true });
    return () => {
      if (!loadingRef.current && !hasOpenFeedDialog()) {
        saveFeedScrollPosition(userId, getPageScrollTop());
      }
      window.removeEventListener('scroll', saveScrollPosition);
    };
  }, [userId]);

  useEffect(() => {
    if (loading) return;
    const savedScrollTop = Math.max(getSavedFeedScrollPosition(userId), initialScrollTopRef.current);
    if (savedScrollTop <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      if (hasOpenFeedDialog()) return;
      window.scrollTo({ top: savedScrollTop, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, userId]);

  const userPendingPosts = pendingPosts.filter(item => item.post.user_id === userId && getPostDestination(item.post) === 'feed');
  const visiblePosts = [
    ...userPendingPosts.map(item => item.post),
    ...posts.filter(post => !userPendingPosts.some(item => item.id === post.id)),
  ];
  const pendingById = new Map(userPendingPosts.map(item => [item.id, item] as const));

  const refreshFeed = useCallback(async () => {
    if (refreshingRef.current || loading) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    setPullDistance(52);
    const startedAt = Date.now();

    try {
      await refresh();
    } finally {
      const delay = Math.max(0, 350 - (Date.now() - startedAt));
      if (refreshIndicatorTimerRef.current) window.clearTimeout(refreshIndicatorTimerRef.current);
      refreshIndicatorTimerRef.current = window.setTimeout(() => {
        refreshingRef.current = false;
        refreshIndicatorTimerRef.current = null;
        if (!feedMountedRef.current) return;
        setIsRefreshing(false);
        setPullDistance(0);
      }, delay);
    }
  }, [loading, refresh]);

  useEffect(() => {
    feedMountedRef.current = true;
    return () => {
      feedMountedRef.current = false;
      refreshingRef.current = false;
      if (refreshIndicatorTimerRef.current) window.clearTimeout(refreshIndicatorTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onFeedRefresh = () => void refreshFeed();
    window.addEventListener('aani:feed-refresh', onFeedRefresh);
    return () => window.removeEventListener('aani:feed-refresh', onFeedRefresh);
  }, [refreshFeed]);

  const handlePullTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const touch = event.touches[0];
    if (
      !touch
      || event.touches.length !== 1
      || loading
      || refreshingRef.current
      || !target
      || target.closest('button, a, input, textarea, select, [role="dialog"], [contenteditable="true"], .story-strip')
      || isHorizontalGestureArea(target)
    ) {
      pullGestureRef.current = null;
      return;
    }

    const scrollTop = Math.max(
      0,
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    if (scrollTop > 2) {
      pullGestureRef.current = null;
      return;
    }

    pullGestureRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: 0,
    };
    setPullDistance(0);
  };

  const handlePullTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    const start = pullGestureRef.current;
    const touch = event.touches[0];
    if (!start || !touch || event.touches.length !== 1) {
      pullGestureRef.current = null;
      return;
    }

    const segmentX = touch.clientX - start.lastX;
    const segmentY = touch.clientY - start.lastY;
    pullGestureRef.current = {
      ...start,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: start.pathLength + Math.hypot(segmentX, segmentY),
    };

    const deltaY = touch.clientY - start.y;
    const deltaX = touch.clientX - start.x;
    setPullDistance(deltaY > 0 && deltaY >= Math.abs(deltaX) * 0.55 ? Math.min(72, deltaY) : 0);
  };

  const handlePullTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = pullGestureRef.current;
    pullGestureRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) {
      setPullDistance(0);
      return;
    }

    const deltaY = touch.clientY - start.y;
    const deltaX = touch.clientX - start.x;
    const finalSegment = Math.hypot(touch.clientX - start.lastX, touch.clientY - start.lastY);
    const totalTravel = start.pathLength + finalSegment;
    const shouldRefresh = deltaY >= 72
      && deltaY >= Math.abs(deltaX) * 0.55
      && totalTravel >= 80;

    if (shouldRefresh) {
      void refreshFeed();
    } else {
      setPullDistance(0);
    }
  };

  const handlePullTouchCancel = () => {
    pullGestureRef.current = null;
    setPullDistance(0);
  };

  return (
    <section
      className="new-view relative w-full max-w-lg mx-auto"
      style={{ overscrollBehaviorY: 'contain', touchAction: 'pan-y' }}
      onTouchStart={handlePullTouchStart}
      onTouchMove={handlePullTouchMove}
      onTouchEnd={handlePullTouchEnd}
      onTouchCancel={handlePullTouchCancel}
    >
      {(pullDistance > 0 || isRefreshing) && (
        <div
          className="pointer-events-none flex items-center justify-center overflow-hidden transition-[height] duration-150"
          style={{ height: isRefreshing ? 48 : Math.min(48, pullDistance) }}
          role={isRefreshing ? 'status' : undefined}
          aria-label={isRefreshing ? 'جارٍ تحديث المنشورات' : 'اسحب لأسفل للتحديث'}
        >
          <Loader2
            size={20}
            className={`text-pink-400 ${isRefreshing ? 'animate-spin' : 'transition-transform'}`}
            style={isRefreshing ? undefined : { transform: `rotate(${Math.min(300, pullDistance * 4)}deg)` }}
          />
        </div>
      )}

      <StoriesBarComponent
        key={userId}
        userId={userId}
        currentProfile={profile}
        pendingReshare={pendingStoryReshare}
        onReshareHandled={onStoryReshareHandled}
        pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
        pendingStoryId={pendingStoryId}
        onProfileStoryHandled={onProfileStoryHandled}
      />

      {loading && <div className="loading-grid">{[1, 2].map(n => <div className="post-skeleton card" key={n}><i className="skeleton skeleton-avatar" /><div className="skeleton-copy"><i className="skeleton skeleton-line short" /></div></div>)}</div>}

      {!loading && error && (
        <div role="alert" className="empty-state card border border-rose-500/30 rounded-2xl bg-zinc-900/70 p-6 text-center">
          <h2 className="text-white font-bold text-base mb-2">تعذر تحميل المنشورات</h2>
          <p className="text-zinc-400 text-xs mb-4">{error}</p>
          <button type="button" onClick={() => void refresh()} className="rounded-full bg-pink-600 px-4 py-2 text-xs font-semibold text-white">
            إعادة المحاولة
          </button>
        </div>
      )}

      {!loading && !error && visiblePosts.length === 0 && (
        <div className="empty-state card text-center p-8 border border-zinc-800 rounded-2xl bg-zinc-900/50">
          <div className="w-12 h-12 bg-pink-500/10 text-pink-500 rounded-full flex items-center justify-center mx-auto mb-3">
            <MessageCircle size={22} />
          </div>
          <h2 className="text-white font-bold text-base mb-1">لا يوجد محتوى منشور حالياً</h2>
          <p className="text-zinc-400 text-xs">انقر على علامة (+) في الأعلى لنشر أول منشور لك!</p>
        </div>
      )}

      {visiblePosts.length > 0 && (
        <div className="posts-list space-y-3">
          {visiblePosts.map(post => {
            const pending = pendingById.get(post.id);
            return (
              <FeedPostCard
                key={post.id}
                post={post}
                currentUserId={userId}
                isMainFeed
                onRefresh={() => void refresh()}
                onOpenComments={onOpenComments}
                pendingState={pending}
                onRetryPending={() => retryPendingPost(post.id)}
                onDismissPending={() => removePendingPost(post.id)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
