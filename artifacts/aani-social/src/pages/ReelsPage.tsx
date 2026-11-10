import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Film as FilmIcon } from 'lucide-react';

import ReelSlide from '@/components/ReelSlide';
import { usePosts } from '@/hooks/usePosts';
import { getPendingPosts, removePendingPost, retryPendingPost, subscribePendingPosts, type PendingPost } from '@/lib/pendingPosts';
import { getPostDestination } from '@/lib/types';

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

  useEffect(() => subscribePendingPosts(() => setPendingPosts(getPendingPosts())), []);

  useEffect(() => {
    if (loading) return undefined;
    const container = scrollRef.current;
    if (!container) return undefined;
    let savedScrollTop = savedReelsScrollPositions.get(userId) || 0;
    try {
      savedScrollTop = Number(window.sessionStorage.getItem(`aani:reels-scroll:${userId}`)) || savedScrollTop;
    } catch {
      // Use the in-memory position if session storage is unavailable.
    }
    if (savedScrollTop <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => { container.scrollTop = savedScrollTop; });
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
  }, [loading, location, visiblePosts]);

  return (
    <div
      ref={scrollRef}
      className="reels-container"
      onScroll={event => saveReelsScrollPosition(userId, event.currentTarget.scrollTop)}
    >
      {loading && <div className="status-box flex h-full items-center justify-center text-white">جاري تحميل الريلز...</div>}
      {!loading && error && (
        <div role="alert" className="status-box flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white">
          <p className="text-sm text-zinc-300">{error}</p>
          <button type="button" onClick={() => void refresh()} className="rounded-full bg-pink-600 px-4 py-2 text-xs font-semibold text-white">
            إعادة المحاولة
          </button>
        </div>
      )}
      {!loading && !error && !visiblePosts.length && (
        <div className="empty-state flex h-full flex-col items-center justify-center text-center text-white">
          <FilmIcon size={36} className="mb-2 text-pink-500" />
          <h2 className="text-lg font-bold">لا يوجد ريلز منشور حالياً</h2>
        </div>
      )}
      {visiblePosts.map(post => {
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
            showCreatedAt
            captionSheet
          />
        );
      })}
    </div>
  );
}
