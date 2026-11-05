import { useLayoutEffect, useRef } from 'react';

import ReelSlide from '@/components/ReelSlide';
import type { Post } from '@/lib/types';

type FeedReelViewerProps = {
  posts: Post[];
  initialIndex: number;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
};

export default function FeedReelViewer({ posts, initialIndex, currentUserId, onOpenComments, onRefresh, onClose }: FeedReelViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialIndexRef = useRef(initialIndex);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const lastIndex = Math.max(0, container.children.length - 1);
    const index = Math.min(lastIndex, Math.max(0, Math.trunc(initialIndexRef.current)));
    container.scrollTop = index * container.clientHeight;
  }, []);

  return (
    <div
      ref={scrollRef}
      className="reels-container feed-reel-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="استعراض فيديوهات التغذية"
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
          onClose={onClose}
          showCreatedAt
          captionSheet
        />
      ))}
    </div>
  );
}
