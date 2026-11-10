import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import FeedPostCard from '@/components/FeedPostCard';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import type { Post } from '@/lib/types';

// شاشة تغذية منشورات الملف الشخصي: تفتح بعرض كامل بأسلوب إنستغرام
// وتبدأ التمرير من المنشور المختار مباشرة مع تمرير حر لأعلى ولأسفل.
export default function ProfileFeedViewer({ posts, initialPostId, currentUserId, onOpenComments, onRefresh, onClose }: {
  posts: Post[];
  initialPostId: string;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefsRef = useRef(new Map<string, HTMLDivElement>());
  const savedProfileScrollTopRef = useRef(0);

  useModalBodyScrollLock();
  // زر الرجوع (الهاتف/المتصفح) يغلق العارض ويعيدك للبروفايل مباشرة
  useOverlayBack(true, onClose);

  // تنظيف صريح وملزم عند الإغلاق (زر X / Escape / Unmount):
  // يعيد تفعيل تمرير صفحة البروفايل فوراً ويستعيد موضع التمرير المحفوظ.
  useEffect(() => {
    savedProfileScrollTopRef.current = window.scrollY;
    return () => {
      const remainingOpenDialog = Boolean(document.querySelector(
        '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
      ));
      if (remainingOpenDialog) return;
      document.body.style.overflow = 'unset';
      document.body.style.position = 'static';
      document.body.style.overscrollBehavior = '';
      document.body.classList.remove('overflow-hidden', 'fixed', 'inset-0');
      const savedTop = savedProfileScrollTopRef.current;
      if (Number.isFinite(savedTop) && window.scrollY !== savedTop) {
        window.scrollTo({ left: window.scrollX, top: savedTop, behavior: 'auto' });
      }
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  // الانتقال التلقائي إلى المنشور المختار عند الفتح
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const target = itemRefsRef.current.get(initialPostId);
    if (!container || !target) return;
    container.scrollTop = Math.max(0, target.offsetTop - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[1102] flex flex-col bg-black" aria-label="تغذية منشورات الملف الشخصي">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <span className="text-sm font-bold text-white">المنشورات</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق عرض المنشورات"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overscroll-contain overflow-y-auto">
        {posts.map(post => (
          <div
            key={post.id}
            data-post-id={post.id}
            ref={el => {
              if (el) itemRefsRef.current.set(post.id, el);
              else itemRefsRef.current.delete(post.id);
            }}
            className="w-full border-b border-zinc-900"
          >
            <FeedPostCard
              post={post}
              isMainFeed
              currentUserId={currentUserId}
              onRefresh={onRefresh}
              onOpenComments={onOpenComments}
            />
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
