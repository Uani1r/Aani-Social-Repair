import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import ReelSlide from '@/components/ReelSlide';
import { ReelsSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { releaseVideoPreloadCandidate, setVideoPreloadCandidate } from '@/lib/mediaPreload';
import { normalizePostMetadata, type Post, type Profile } from '@/lib/types';
import { resolvePostMediaUrls } from '@/lib/postMedia';

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
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);

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
  const nextPost = reelsList[activeIndex + 1];
  const nextMediaUrl = nextPost?.media_url || nextPost?.media_urls?.[0] || null;
  const currentPostId = reelsList[activeIndex]?.id || 'start';

  useEffect(() => {
    const candidateId = `profile-reels:${currentPostId}`;
    setVideoPreloadCandidate(candidateId, nextMediaUrl, 1, 1);
    return () => releaseVideoPreloadCandidate(candidateId);
  }, [currentPostId, nextMediaUrl]);

  useEffect(() => {
    if (useProvided || !profileUserId || !supabaseConfigured) {
      if (!useProvided) setFetchedReels([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const buildProfileReelQuery = (includeSoundTrim: boolean, includeMediaAssetId: boolean, useDestinationFilter: boolean) => {
          const mediaAssetColumn = includeMediaAssetId ? 'media_asset_id, ' : '';
          const soundTrimColumns = includeSoundTrim ? 'sound_trim_start, sound_trim_end, ' : '';
          const columns = `id, user_id, content, post_metadata, media_url, media_urls, ${mediaAssetColumn}type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, hide_likes, hide_comments, comment_privacy, audio_url, audio_title, sound_id, ${soundTrimColumns}trim_start, trim_end`;
          const request = supabase
            .from('posts')
            .select(columns)
            .eq('user_id', profileUserId);
          // بلا مرشح الوجهة إن لم يُطبَّق عمود destination بعد؛ الفلترة تُعاد محلياً
          const filtered = useDestinationFilter
            ? request.or('type.eq.reel,and(type.eq.photo,destination.eq.reels)')
            : request;
          return filtered
            .order('created_at', { ascending: false })
            .limit(60);
        };
        let includeSoundTrim = true;
        let includeMediaAssetId = true;
        let useDestinationFilter = true;
        let result = await buildProfileReelQuery(includeSoundTrim, includeMediaAssetId, useDestinationFilter);
        for (let attempt = 0; attempt < 3 && result.error; attempt += 1) {
          if (includeSoundTrim && (result.error.code === '42703' || result.error.code === 'PGRST204') && /sound_trim/i.test(result.error.message || '')) {
            includeSoundTrim = false;
          } else if (includeMediaAssetId && (result.error.code === '42703' || result.error.code === 'PGRST204') && /media_asset_id/i.test(result.error.message || '')) {
            includeMediaAssetId = false;
          } else if (useDestinationFilter && /destination/i.test(result.error.message || '')) {
            useDestinationFilter = false;
          } else {
            break;
          }
          result = await buildProfileReelQuery(includeSoundTrim, includeMediaAssetId, useDestinationFilter);
        }
        const { data: rows, error } = result;
        if (error) {
          console.error('[reels] فشل جلب ريلز الملف الشخصي', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
        }
        const safeRows = (!error && Array.isArray(rows) ? rows : []) as unknown[];
        const reelRows = safeRows.filter(row => {
          const record = row as Record<string, unknown>;
          // أي فيديو (type = reel) أو أي منشور وُجّه إلى الريلز
          return record.type === 'reel' || record.destination === 'reels';
        });
        const authorIds = Array.from(new Set(reelRows
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
        const fetchedPosts = reelRows.map(row => {
          const record = row as Record<string, unknown>;
          const authorId = typeof record.user_id === 'string' ? record.user_id : '';
          return {
            ...(record as unknown as Post),
            post_metadata: normalizePostMetadata(record.post_metadata),
            author: profiles.get(authorId) || { id: authorId, username: '', full_name: '', avatar_url: null, bio: '' },
          } as Post;
        });
        const resolvedReels = await resolvePostMediaUrls(fetchedPosts);
        if (active) setFetchedReels(resolvedReels);
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
    const nextIndex = Math.min(lastIndex, index);
    container.scrollTop = nextIndex * container.clientHeight;
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
  }, [reelsList, initialReelId]);

  return createPortal(
    <div
      ref={scrollRef}
      role="dialog"
      aria-modal="true"
      aria-label="مشغل ريلز الملف الشخصي"
      className="reels-container feed-reel-viewer profile-reels-player"
      onWheel={event => event.stopPropagation()}
      onScroll={event => {
        const container = event.currentTarget;
        const index = Math.min(reelsList.length - 1, Math.max(0, Math.round(container.scrollTop / Math.max(1, container.clientHeight))));
        if (index !== activeIndexRef.current) {
          activeIndexRef.current = index;
          setActiveIndex(index);
        }
        event.stopPropagation();
      }}
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
        reelsList.map((reel, index) => {
          const key = reel?.id || `profile-reel-${index}`;
          return Math.abs(index - activeIndex) <= 1 ? (
            <ReelSlide
              key={key}
              post={reel}
              currentUserId={currentUserId}
              onOpenComments={onOpenComments}
              onRefresh={onRefresh}
              onClose={onClose}
              trailingAccountControl={trailingAccountControl}
              showCreatedAt
              captionSheet
            />
          ) : (
            <div key={key} className="reel-slide" aria-hidden="true" />
          );
        })
      )}
    </div>,
    document.body,
  );
}
