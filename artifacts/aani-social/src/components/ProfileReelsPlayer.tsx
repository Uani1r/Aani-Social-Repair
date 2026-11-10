import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

import ReelSlide from '@/components/ReelSlide';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import type { Post } from '@/lib/types';

// مشغل الريلز الكامل لملف شخصي واحد: يفتح بالشاشة الكاملة من الريل المختار
// ويقتصر التنقل (السحب) على ريلز هذا الملف الشخصي فقط بنفس ترتيبها فيه.
// حماية دفاعية: مصفوفة الريلز قد تكون غير جاهزة أثناء التحميل.
export default function ProfileReelsPlayer({ reels = [], initialPostId = '', currentUserId = '', onOpenComments, onRefresh, onClose, trailingAccountControl }: {
  reels?: Post[];
  initialPostId?: string;
  currentUserId?: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  trailingAccountControl?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reelsList = Array.isArray(reels) ? reels : [];

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
    if (!container || reelsList.length === 0) return;
    const index = reelsList.findIndex(reel => reel.id === initialPostId);
    const lastIndex = Math.max(0, container.children.length - 1);
    container.scrollTop = Math.min(lastIndex, Math.max(0, index)) * container.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelsList, initialPostId]);

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
      {reelsList.length === 0 ? (
        <div className="empty-state flex h-full flex-col items-center justify-center gap-3 text-center text-white">
          <Loader2 size={28} className="animate-spin text-pink-500" />
          <p className="text-sm text-zinc-300">جارٍ تحميل الريلز...</p>
          <p className="text-xs text-zinc-500">إذا استمرت هذه الشاشة فلا توجد مقاطع ريلز لعرضها.</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/30 px-5 py-2 text-xs font-bold text-white transition hover:bg-white/10"
          >
            إغلاق
          </button>
        </div>
      ) : (
        reelsList.map(reel => (
          <ReelSlide
            key={reel?.id || Math.random()}
            post={reel}
            currentUserId={currentUserId}
            onOpenComments={onOpenComments}
            onRefresh={onRefresh}
            onClose={onClose}
            trailingAccountControl={trailingAccountControl}
            showCreatedAt
            captionSheet
          />
        ))
      )}
    </div>,
    document.body,
  );
}
