import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import ReelSlide from '@/components/ReelSlide';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import type { Post } from '@/lib/types';

// مشغل الريلز الكامل لملف شخصي واحد: يفتح بالشاشة الكاملة من الريل المختار
// ويقتصر التنقل (السحب) على ريلز هذا الملف الشخصي فقط بنفس ترتيبها فيه.
export default function ProfileReelsPlayer({ reels, initialPostId, currentUserId, onOpenComments, onRefresh, onClose, trailingAccountControl }: {
  reels: Post[];
  initialPostId: string;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  trailingAccountControl?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

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
    const index = reels.findIndex(reel => reel.id === initialPostId);
    const lastIndex = Math.max(0, container.children.length - 1);
    container.scrollTop = Math.min(lastIndex, Math.max(0, index)) * container.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={scrollRef}
      role="dialog"
      aria-modal="true"
      aria-label="مشغل ريلز الملف الشخصي"
      className="reels-container feed-reel-viewer profile-reels-player"
      onWheel={event => event.stopPropagation()}
      onScroll={event => event.stopPropagation()}
    >
      {reels.map(reel => (
        <ReelSlide
          key={reel.id}
          post={reel}
          currentUserId={currentUserId}
          onOpenComments={onOpenComments}
          onRefresh={onRefresh}
          onClose={onClose}
          trailingAccountControl={trailingAccountControl}
          showCreatedAt
          captionSheet
        />
      ))}
    </div>,
    document.body,
  );
}
