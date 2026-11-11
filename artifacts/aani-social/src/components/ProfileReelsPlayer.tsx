import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import ReelSlide from '@/components/ReelSlide';
import { ReelsSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePostMetadata, type Post, type Profile } from '@/lib/types';

// مشغل الريلز الكامل لملف شخصي واحد: يفتح من الريل المختار مباشرة
// ويقتصر التنقل (السحب) على ريلز هذا الملف الشخصي فقط بنفس ترتيبها.
// إذا مُرّرت الريلز كـ Props تُستخدم فوراً بلا مؤشر تحميل، وإلا يُجلب
// الملف من قاعدة البيانات مع إنهاء حالة التحميل في كل الحالات.
export default function ProfileReelsPlayer({ reels, profileUserId, initialReelId = '', currentUserId = '', onOpenComments, onRefresh, onClose, trailingAccountControl }: {
  reels?: Post[];
  profileUserId?: string;
  initialReelId?: string;
  currentUserId?: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  trailingAccountControl?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedProfileScrollTopRef = useRef(0);
  const [fetchedReels, setFetchedReels] = useState<Post[] | null>(null);

  useModalBodyScrollLock();
  // زر الرجوع (الهاتف/المتصفح) يغلق المشغل ويعيدك للبروفايل مباشرة
  useOverlayBack(true, onClose);

  // تنظيف صريح وملزم عند الإغلاق (زر X / رجوع / Unmount):
  // يجب أن يعود تمرير صفحة البروفايل فوراً حتى لو بقيت أي حالة
  // قفل سابقة (overflow/position) أو كلاسات قفل على body.
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

  // الريلز الممررة جاهزة → تُستخدم فوراً وتُتخطى شاشة التحميل تماماً
  const providedReels = Array.isArray(reels) ? reels : [];
  const useProvided = providedReels.length > 0;
  const reelsList = useProvided ? providedReels : (fetchedReels || []);
  const isLoading = !useProvided && fetchedReels === null;

  useEffect(() => {
    if (useProvided || !profileUserId || !supabaseConfigured) {
      if (!useProvided) setFetchedReels([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const { data: rows, error } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, hide_likes, hide_comments, comment_privacy, audio_url, audio_title, trim_start, trim_end')
          .eq('user_id', profileUserId)
          .eq('type', 'reel')
          .order('created_at', { ascending: false })
          .limit(60);
        const safeRows = (!error && Array.isArray(rows) ? rows : []) as unknown[];
        const authorIds = Array.from(new Set(safeRows
          .map(row => (row as Record<string, unknown>).user_id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id))));

        const profiles = new Map<string, Profile>();
        if (authorIds.length > 0) {
          const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender, bio')
            .in('id', authorIds);
          (Array.isArray(profileRows) ? profileRows : []).forEach(profile => {
            const row = profile as unknown as Record<string, unknown>;
            if (typeof row?.id === 'string') profiles.set(row.id, row as unknown as Profile);
          });
        }

        if (!active) return;
        setFetchedReels(safeRows.map(row => {
          const record = row as Record<string, unknown>;
          const authorId = typeof record.user_id === 'string' ? record.user_id : '';
          return {
            ...(record as unknown as Post),
            post_metadata: normalizePostMetadata(record.post_metadata),
            author: profiles.get(authorId) || { id: authorId, username: '', full_name: '', avatar_url: null, bio: '' },
          } as Post;
        }));
      } catch {
        if (active) setFetchedReels([]);
      }
    })();
    return () => { active = false; };
  }, [useProvided, profileUserId]);

  // الانتقال التلقائي إلى الريل المختار بمجرد جاهزية القائمة
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || reelsList.length === 0) return;
    const foundIndex = reelsList.findIndex(reel => reel?.id === initialReelId);
    const index = foundIndex >= 0 ? foundIndex : 0;
    const lastIndex = Math.max(0, container.children.length - 1);
    container.scrollTop = Math.min(lastIndex, index) * container.clientHeight;
  }, [reelsList, initialReelId]);

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
      {isLoading ? (
        <ReelsSkeleton />
      ) : reelsList.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white">
          <EmptyState />
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
