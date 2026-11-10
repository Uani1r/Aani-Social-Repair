import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import FeedPostCard from '@/components/FeedPostCard';
import ReelSlide from '@/components/ReelSlide';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { getPostDestination, type Post } from '@/lib/types';

export const isReelPost = (post: Post) => post.type === 'reel' || getPostDestination(post) === 'reels';

// نافذة العرض الكاملة داخل صفحة البروفايل: تفتح من المنشور المختار
// وتتيح التمرير العمودي بين باقي منشورات الشبكة دون مغادرة الملف الشخصي.
export default function ProfileFeedViewer({ posts, initialPostId, currentUserId, onOpenComments, onRefresh, onClose }: {
  posts: Post[];
  initialPostId: string;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const index = posts.findIndex(post => post.id === initialPostId);
    return index >= 0 ? index : 0;
  });

  useModalBodyScrollLock();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const index = posts.findIndex(post => post.id === initialPostId);
    const lastIndex = Math.max(0, container.children.length - 1);
    container.scrollTop = Math.min(lastIndex, Math.max(0, index)) * container.clientHeight;
    // تُفتح النافذة دائماً من المنشور المختار مرة واحدة فقط.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentPost = posts[currentIndex];
  const currentIsReel = currentPost ? isReelPost(currentPost) : false;

  return createPortal(
    <div className="relative" aria-label="عارض منشورات الملف الشخصي">
      <div
        ref={scrollRef}
        role="dialog"
        aria-modal="true"
        aria-label="استعراض منشورات الملف الشخصي"
        className="reels-container feed-reel-viewer profile-feed-viewer"
        onScroll={event => {
          event.stopPropagation();
          const container = event.currentTarget;
          if (!container.clientHeight) return;
          setCurrentIndex(Math.round(container.scrollTop / container.clientHeight));
        }}
        onWheel={event => event.stopPropagation()}
      >
        {posts.map(post => isReelPost(post) ? (
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
        ) : (
          <section
            key={post.id}
            aria-label="منشور صورة"
            className="flex h-[100dvh] w-full snap-start snap-always items-center justify-center overflow-y-auto bg-black p-3"
          >
            <div className="w-full max-w-[520px]">
              <FeedPostCard
                post={post}
                currentUserId={currentUserId}
                onRefresh={onRefresh}
                onOpenComments={onOpenComments}
              />
            </div>
          </section>
        ))}
      </div>
      {/* زر إغلاق ثابت لبطاقات الصور — الريلز له زر إغلاق داخل شريطه العلوي */}
      {!currentIsReel && (
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق العارض"
          className="absolute right-3 top-3 z-[3] grid h-10 w-10 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
        >
          <X size={22} aria-hidden="true" />
        </button>
      )}
    </div>,
    document.body,
  );
}
