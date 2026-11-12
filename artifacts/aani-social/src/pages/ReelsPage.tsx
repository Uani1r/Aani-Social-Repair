import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';

import ReelSlide from '@/components/ReelSlide';
import { ReelsSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { usePosts } from '@/hooks/usePosts';
import { getPendingPosts, removePendingPost, retryPendingPost, subscribePendingPosts, type PendingPost } from '@/lib/pendingPosts';
import { getPostCoverUrl, getPostDestination } from '@/lib/types';
import { preloadImage, releaseVideoPreloadCandidate, setVideoPreloadCandidate } from '@/lib/mediaPreload';

const savedReelsScrollPositions = new Map<string, number>();

function saveReelsScrollPosition(userId: string, scrollTop: number) {
  savedReelsScrollPositions.set(userId, scrollTop);
  try {
    window.sessionStorage.setItem(`aani:reels-scroll:${userId}`, String(scrollTop));
  } catch {
    // The in-memory position still covers route changes when storage is unavailable.
  }
}

export default function ReelsPage({ userId, onOpenComments }: { userId: string; onOpenComments: (postId: string) => void }) {
  const [location] = useLocation();
  const { posts, loading, refresh, error } = usePosts('reel', undefined, userId);
  const [pendingPosts, setPendingPosts] = useState<PendingPost[]>(getPendingPosts);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);

  useEffect(() => subscribePendingPosts(() => setPendingPosts(getPendingPosts())), []);

  // أي خطأ في جلب الريلز يظهر على الشاشة (error) وفي الكونسول مع تفاصيله
  useEffect(() => {
    if (error) console.error('[reels] تعذر تحميل الريلز:', error);
  }, [error]);

  useEffect(() => {
    if (loading || new URLSearchParams(location.split('?')[1] || '').has('openReel')) return undefined;
    const container = scrollRef.current;
    if (!container) return undefined;
    let savedScrollTop = savedReelsScrollPositions.get(userId) || 0;
    try {
      savedScrollTop = Number(window.sessionStorage.getItem(`aani:reels-scroll:${userId}`)) || savedScrollTop;
    } catch {
      // Use the in-memory position if session storage is unavailable.
    }
    if (savedScrollTop <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = savedScrollTop;
      const index = Math.min(container.children.length - 1, Math.max(0, Math.round(savedScrollTop / Math.max(1, container.clientHeight))));
      activeIndexRef.current = index;
      setActiveIndex(index);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, userId]);

  useEffect(() => () => {
    const container = scrollRef.current;
    if (container) saveReelsScrollPosition(userId, container.scrollTop);
  }, [userId]);

  const userPendingPosts = pendingPosts.filter(item => item.post.user_id === userId && getPostDestination(item.post) === 'reels');
  const pendingById = new Map(userPendingPosts.map(item => [item.id, item] as const));
  const visiblePosts = [
    ...userPendingPosts.map(item => item.post),
    ...posts.filter(post => !userPendingPosts.some(item => item.id === post.id)),
  ];
  const currentPost = visiblePosts[activeIndex];
  const nextPost = visiblePosts[activeIndex + 1];
  const currentPosterUrl = currentPost ? getPostCoverUrl(currentPost) : null;
  const nextPosterUrl = nextPost ? getPostCoverUrl(nextPost) : null;
  const nextMediaUrl = nextPost?.media_url || nextPost?.media_urls?.[0] || null;
  const currentPostId = currentPost?.id || 'start';
  const visiblePostsSignature = visiblePosts.map(post => post.id).join(',');

  useEffect(() => {
    if (loading) return;
    preloadImage(currentPosterUrl);
    preloadImage(nextPosterUrl);
  }, [currentPosterUrl, loading, nextPosterUrl]);

  useEffect(() => {
    const candidateId = `reels-page:${currentPostId}`;
    setVideoPreloadCandidate(candidateId, nextMediaUrl, 1, 1);
    return () => releaseVideoPreloadCandidate(candidateId);
  }, [currentPostId, nextMediaUrl]);

  // فتح ريل محدد عند الوصول من إشعار (‎/reels?openReel=<post_id>‎):
  // يمرر مشغّل الريلز مباشرة إلى الريل المستهدف.
  useEffect(() => {
    if (loading) return;
    const query = new URLSearchParams(location.split('?')[1] || '');
    const openReelId = query.get('openReel');
    if (!openReelId) return;
    const container = scrollRef.current;
    if (!container) return;
    const index = visiblePosts.findIndex(post => post.id === openReelId);
    if (index < 0) return;
    container.scrollTop = index * container.clientHeight;
    activeIndexRef.current = index;
    setActiveIndex(index);
  }, [loading, location, visiblePostsSignature]);

  return (
    <div
      ref={scrollRef}
      className="reels-container"
      onScroll={event => {
        const container = event.currentTarget;
        saveReelsScrollPosition(userId, container.scrollTop);
        const index = Math.min(visiblePosts.length - 1, Math.max(0, Math.round(container.scrollTop / Math.max(1, container.clientHeight))));
        if (index !== activeIndexRef.current) {
          activeIndexRef.current = index;
          setActiveIndex(index);
        }
      }}
    >
      {loading && <ReelsSkeleton />}
      {!loading && error && (
        <div role="alert" data-video-test-visible="true" className="status-box flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white">
          <p className="text-sm text-zinc-300">{error}</p>
          <button type="button" onClick={() => void refresh()} className="rounded-full bg-pink-600 px-4 py-2 text-xs font-semibold text-white">
            إعادة المحاولة
          </button>
        </div>
      )}
      {!loading && !error && !visiblePosts.length && (
        <EmptyState className="h-full" />
      )}
      {visiblePosts.map((post, index) => {
        if (Math.abs(index - activeIndex) > 1) {
          return <div key={`${post.id}:${post.reposter_id || 'original'}`} className="reel-slide" aria-hidden="true" />;
        }
        const pending = pendingById.get(post.id);
        return (
          <ReelSlide
            key={`${post.id}:${post.reposter_id || 'original'}`}
            post={post}
            currentUserId={userId}
            onOpenComments={onOpenComments}
            onRefresh={() => void refresh()}
            pendingState={pending}
            onRetryPending={() => retryPendingPost(post.id)}
            onDismissPending={() => removePendingPost(post.id)}
            videoPreload={index === activeIndex || index === activeIndex + 1 ? 'metadata' : 'none'}
            showCreatedAt
            captionSheet
          />
        );
      })}
    </div>
  );
}
