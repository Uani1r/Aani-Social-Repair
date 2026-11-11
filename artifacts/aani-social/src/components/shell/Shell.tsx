import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { useLocation } from 'wouter';

import ShellBottomNav from './ShellBottomNav';
import ShellOverlayControls from './ShellOverlayControls';
import UnifiedTopBar from './UnifiedTopBar';
import CallManager, { CALL_LOG_EVENT, OPEN_INCOMING_CALL_EVENT, type CallLogEventDetail } from '@/components/CallManager';
import FollowListView, { type FollowListKind } from '@/components/FollowListView';
import type { VideoMentionPerson } from '@/components/VideoPreviewModal';
import { playMessageChime, unlockNotificationAudio } from '@/lib/notificationSounds';
import { isHorizontalGestureArea } from '@/lib/appShared';
import { handleAppError, markAppErrorReported, wasAppErrorReported } from '@/lib/appErrors';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { addPendingPost, removePendingPost, updatePendingPost } from '@/lib/pendingPosts';
import { uploadMedia } from '@/lib/storyUpload';
import { appendImageMediaAspect, buildVideoMediaUrl } from '@/lib/videoMedia';
import { displayName, type Post, type PostDestination, type PostMetadataTag, type VideoCropTransform, type VideoTrimRange } from '@/lib/types';
import type { ShellProps } from './types';
import { requestContentRefresh } from '@/lib/contentRefresh';
import { useRouteScrollMemory } from '@/hooks/useRouteScrollMemory';
import { goBackOrPush } from '@/lib/overlayBack';

const fileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر تجهيز معاينة الصورة.'));
  reader.onerror = () => reject(reader.error || new Error('تعذر قراءة الصورة المختارة.'));
  reader.readAsDataURL(file);
});

const createPostId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
};

const createCallLogMessageId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCallLogEventDetail = (value: unknown): value is CallLogEventDetail => isRecord(value)
  && typeof value.callId === 'string'
  && Boolean(value.callId.trim())
  && value.callId.length <= 160
  && typeof value.recipientId === 'string'
  && Boolean(value.recipientId.trim())
  && value.recipientId.length <= 160
  && (value.mode === 'audio' || value.mode === 'video')
  && (value.outcome === 'completed' || value.outcome === 'declined' || value.outcome === 'missed' || value.outcome === 'busy')
  && typeof value.durationSeconds === 'number'
  && Number.isSafeInteger(value.durationSeconds)
  && value.durationSeconds >= 0;

const isPostsPermissionError = (error: { code?: string; message?: string }) =>
  error.code === '42501' || /permission denied|row-level security/i.test(error.message || '');

const hasOpenDialog = () =>
  typeof document !== 'undefined' && Boolean(document.querySelector(
    '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
  ));

const hasBlockingFeedDialog = () =>
  typeof document !== 'undefined' && Array.from(document.querySelectorAll(
    '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
  )).some(dialog => !dialog.closest('.feed-reel-viewer'));

const hasOpenModal = () =>
  typeof document !== 'undefined' && (hasOpenDialog() || Boolean(document.querySelector(
    '[role="menu"]:not([aria-hidden="true"]):not([data-state="closed"]), [role="listbox"]:not([aria-hidden="true"]):not([data-state="closed"])',
  )));

const releasePageInteraction = () => {
  if (typeof document === 'undefined') return;
  window.requestAnimationFrame(() => {
    if (hasOpenModal()) return;
    document.body.style.overflow = 'unset';
    document.body.style.pointerEvents = 'auto';
  });
};

export default function Shell({
  children,
  profile,
  onProfileUpdate,
  userId,
  onSignOut,
  onOpenComments,
  onOpenStory,
  NotificationsModalComponent,
  headerStories,
}: ShellProps) {
  const [path, setLocation] = useLocation();
  // ذاكرة موضع التمرير لكل مسار: العودة لمسار سبق زيارته تستعيد موضع التمرير
  useRouteScrollMemory(path);
  const isProfilePath = path === '/profile' || path.startsWith('/profile/');
  // ملف شخصي فرعي (ليس تبويب البروفايل الرئيسي): تُعطَّل سحبة التبويبات وتُستبدل بإيماءة رجوع
  const isProfileSubView = path !== '/profile' && path.startsWith('/profile/');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPublishOptionsSheet, setShowPublishOptionsSheet] = useState(false);
  const [pendingStoryComposerRequest, setPendingStoryComposerRequest] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showNotifsModal, setShowNotifsModal] = useState(false);
  const [openFollowRequestsOnOpen, setOpenFollowRequestsOnOpen] = useState(false);
  const [showAssistantModal, setShowAssistantModal] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const seenNotificationIdsRef = useRef(new Set<string>());
  const handledCallLogsRef = useRef(new Set<string>());
  const [unifiedTopBarHidden, setUnifiedTopBarHidden] = useState(() => Math.max(
    window.scrollY || 0,
    document.documentElement.scrollTop || 0,
    document.body.scrollTop || 0,
  ) > 10);
  const unifiedTopBarHiddenRef = useRef(unifiedTopBarHidden);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  const requestStoryComposer = useCallback(() => {
    setPendingStoryComposerRequest(true);
    if (currentPathRef.current !== '/' && currentPathRef.current !== '/feed') setLocation('/feed');
  }, [setLocation]);
  const acknowledgeOpenFollowRequests = useCallback(() => setOpenFollowRequestsOnOpen(false), []);
  const requestOpenFollowRequests = useCallback(() => {
    setShowNotifsModal(true);
    setOpenFollowRequestsOnOpen(true);
  }, []);
  const handlePushNavigation = useCallback((rawUrl: string) => {
    try {
      const target = new URL(rawUrl, window.location.origin);
      if (target.origin !== window.location.origin) return;

      const query = target.searchParams;
      const pushedNotificationId = query.get('pushNotificationId');
      if (pushedNotificationId) {
        void supabase.from('notifications')
          .update({ is_read: true })
          .eq('id', pushedNotificationId)
          .eq('user_id', userId);
      }
      const storyId = query.get('openStoryId');
      const storyOwnerId = query.get('openStoryOwner');
      if (storyId && storyOwnerId) {
        onOpenStory(storyId, storyOwnerId);
        setLocation('/feed');
        return;
      }

      setLocation(`${target.pathname}${target.search}${target.hash}`);
      const pathSegments = target.pathname.split('/').filter(Boolean);
      if (query.get('showComments') === '1') {
        const encodedPostId = pathSegments[0] === 'post' ? pathSegments[1] : '';
        if (encodedPostId) {
          onOpenComments(decodeURIComponent(encodedPostId), query.get('commentId') || undefined);
        }
      }
      if (query.get('openFollowRequests') === '1') requestOpenFollowRequests();
      if (query.get('openCall') === '1') {
        const encodedCallerId = pathSegments[0] === 'messages' ? pathSegments[1] : '';
        const callerId = query.get('callerId') || (encodedCallerId ? decodeURIComponent(encodedCallerId) : '');
        const callId = query.get('callId');
        if (callerId) {
          window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_INCOMING_CALL_EVENT, {
            detail: { callerId, callId },
          })), 0);
        }
      }
    } catch (error) {
      console.warn('[push] تعذر فتح وجهة الإشعار:', error);
    }
  }, [onOpenComments, onOpenStory, requestOpenFollowRequests, setLocation, userId]);

  const handleSignOut = async () => {
    // Remove this browser's push destination before the session is cleared.
    if (supabaseConfigured) {
      try {
        const { error } = await supabase.from('profiles').update({ fcm_token: null }).eq('id', userId);
        if (error) console.warn('[push] تعذر إلغاء تسجيل هذا الجهاز قبل تسجيل الخروج:', error);
      } catch (error) {
        console.warn('[push] تعذر إلغاء تسجيل هذا الجهاز قبل تسجيل الخروج:', error);
      }
    }
    // Root is valid in both session states: feed before logout, login after it.
    setLocation('/');
    onSignOut();
  };

  const homeTapAtRef = useRef(0);
  const reelsTapAtRef = useRef(0);
  const homeTapResetTimerRef = useRef<number | null>(null);
  const reelsTapResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
    if (reelsTapResetTimerRef.current) window.clearTimeout(reelsTapResetTimerRef.current);
  }, []);

  useEffect(() => {
    const openStoryComposer = () => requestStoryComposer();
    window.addEventListener('aani:request-story-composer', openStoryComposer);
    return () => {
      window.removeEventListener('aani:request-story-composer', openStoryComposer);
    };
  }, [requestStoryComposer]);

  useEffect(() => {
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; url?: unknown } | null;
      if (message?.type === 'AANI_PUSH_CLICK' && typeof message.url === 'string') {
        handlePushNavigation(message.url);
      }
    };
    if (!('serviceWorker' in navigator)) return undefined;
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
  }, [handlePushNavigation]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (['openFollowRequests', 'openCall', 'openStoryId', 'pushNotificationId', 'showComments'].some(key => query.has(key))) {
      handlePushNavigation(window.location.href);
    }
  }, [handlePushNavigation]);

  useEffect(() => {
    let modalOpen = hasBlockingFeedDialog();
    const pauseFeedVideos = () => window.dispatchEvent(new Event('aani:pause-feed-videos'));
    const resumeFeedVideos = () => window.dispatchEvent(new Event('aani:resume-feed-videos'));

    if (modalOpen) pauseFeedVideos();

    const observer = new MutationObserver(() => {
      const nextModalOpen = hasBlockingFeedDialog();
      if (nextModalOpen === modalOpen) return;
      modalOpen = nextModalOpen;
      if (nextModalOpen) pauseFeedVideos();
      else resumeFeedVideos();
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'data-state'],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const isFeedPath = path === '/' || path === '/feed';
    const scrollTop = Math.max(
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    const hidden = isFeedPath && scrollTop > 10;
    unifiedTopBarHiddenRef.current = hidden;
    setUnifiedTopBarHidden(hidden);
  }, [path]);

  useEffect(() => {
    if (!pendingStoryComposerRequest || (path !== '/' && path !== '/feed')) return;

    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('aani:open-story-composer'));
      setPendingStoryComposerRequest(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [path, pendingStoryComposerRequest]);

  const handleHomeNavigationTap = (event: MouseEvent<HTMLAnchorElement>, navId: string) => {
    if (navId !== 'feed' && navId !== 'reels') {
      homeTapAtRef.current = 0;
      reelsTapAtRef.current = 0;
      if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
      if (reelsTapResetTimerRef.current) window.clearTimeout(reelsTapResetTimerRef.current);
      homeTapResetTimerRef.current = null;
      reelsTapResetTimerRef.current = null;
      return;
    }

    const isFeed = navId === 'feed';
    const tapAtRef = isFeed ? homeTapAtRef : reelsTapAtRef;
    const resetTimerRef = isFeed ? homeTapResetTimerRef : reelsTapResetTimerRef;
    const otherTapAtRef = isFeed ? reelsTapAtRef : homeTapAtRef;
    const otherResetTimerRef = isFeed ? reelsTapResetTimerRef : homeTapResetTimerRef;
    otherTapAtRef.current = 0;
    if (otherResetTimerRef.current) window.clearTimeout(otherResetTimerRef.current);
    otherResetTimerRef.current = null;

    const now = Date.now();
    if (tapAtRef.current > 0 && now - tapAtRef.current <= 450) {
      event.preventDefault();
      tapAtRef.current = 0;
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
      if (isFeed) {
        setLocation('/feed');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setLocation('/reels');
      }
      void requestContentRefresh();
      return;
    }

    tapAtRef.current = now;
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      tapAtRef.current = 0;
      resetTimerRef.current = null;
    }, 450);

    if ((isFeed && path === '/feed') || (!isFeed && path === '/reels')) event.preventDefault();
  };

  // إخفاء/إظهار شريط التنقل السفلي حسب اتجاه حركة الإصبع
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeHiddenRef = useRef(false);

  useEffect(() => {
    if (!isProfilePath) return;
    chromeHiddenRef.current = false;
    setChromeHidden(false);
    document.body.classList.remove('aani-chrome-hidden');
  }, [isProfilePath]);

  useEffect(() => {
    const setHidden = (hidden: boolean) => {
      if (chromeHiddenRef.current === hidden) return;
      chromeHiddenRef.current = hidden;
      document.body.classList.toggle('aani-chrome-hidden', hidden);
      setChromeHidden(hidden);
    };

    let lastTouchY = 0;
    let lastDirection: 0 | 1 | -1 = 0;
    let touching = false;
    let lastTouchMoveAt = 0;
    let lastScrollY = window.scrollY || document.documentElement.scrollTop || 0;

    // 1 = إظهار (إصبع نازل / تمرير للأعلى)، -1 = إخفاء — استجابة فورية بلا عتبة
    const applyDirection = (direction: 1 | -1) => {
      if (direction === lastDirection) return;

      lastDirection = direction;
      setHidden(direction === -1);
    };

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;

      touching = true;
      lastTouchMoveAt = performance.now();
      lastTouchY = touch.clientY;
      lastDirection = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      // أبقِ شريط الملف الشخصي ثابتًا ومرئيًا أثناء التمرير.
      if (currentPathRef.current === '/profile' || currentPathRef.current.startsWith('/profile/')) return;
      // لا تعمل حركة إخفاء/إظهار الأشرطة داخل شاشات القصص والواجهات المغطاة
      if (document.body.classList.contains('aani-immersive')) return;

      const touch = event.touches[0];
      if (!touch) return;

      lastTouchMoveAt = performance.now();

      // لا نتدخل أثناء النوافذ والقوائم المفتوحة
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="listbox"]')) return;

      const step = touch.clientY - lastTouchY;
      if (Math.abs(step) < 2) return;
      lastTouchY = touch.clientY;

      // عتبة صغيرة تمنع الاهتزاز وتستجيب للسحبات القصيرة من أي موضع.
      if (step > 0) applyDirection(1);
      else applyDirection(-1);
    };

    const onTouchEnd = () => {
      touching = false;
      lastScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    };

    // احتياط: بعض المتصفحات لا تُطلق أحداث اللمس أثناء التمرير، فنستخدم اتجاه التمرير
    let lastScrollToggleAt = 0;
    const onScroll = () => {
      const now = performance.now();
      const y = Math.max(
        0,
        window.scrollY || 0,
        document.documentElement.scrollTop || 0,
        document.body.scrollTop || 0,
      );
      const isFeedPath = currentPathRef.current === '/' || currentPathRef.current === '/feed';
      const shouldHideUnifiedTopBar = isFeedPath && y > 10;
      if (unifiedTopBarHiddenRef.current !== shouldHideUnifiedTopBar) {
        unifiedTopBarHiddenRef.current = shouldHideUnifiedTopBar;
        setUnifiedTopBarHidden(shouldHideUnifiedTopBar);
      }

      if (currentPathRef.current === '/profile' || currentPathRef.current.startsWith('/profile/')) {
        lastScrollY = y;
        applyDirection(1);
        return;
      }
      if (document.body.classList.contains('aani-immersive') || hasOpenModal()) return;
      if (touching && now - lastTouchMoveAt < 120) return;

      const delta = y - lastScrollY;
      lastScrollY = y;

      // أبقِ الوحدة ظاهرة عند أعلى الصفحة وخلال ارتداد السحب للتحديث.
      if (y <= 2) {
        applyDirection(1);
        return;
      }

      // عتبة قصيرة تمنع الارتجاف وتُظهر الوحدة قبل الوصول إلى أعلى الصفحة.
      if (Math.abs(delta) < 2) return;
      if (now - lastScrollToggleAt < 90) return;

      lastScrollToggleAt = now;

      if (delta > 0) applyDirection(-1);
      else applyDirection(1);
    };

    // بديل لسطح المكتب: عجلة الفأرة
    const onWheel = (event: WheelEvent) => {
      if (currentPathRef.current === '/profile' || currentPathRef.current.startsWith('/profile/')) {
        applyDirection(1);
        return;
      }
      if (document.body.classList.contains('aani-immersive') || hasOpenModal()) return;
      if (!event.deltaY) return;
      applyDirection(event.deltaY > 0 ? -1 : 1);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      document.body.classList.remove('aani-chrome-hidden');
    };
  }, []);

  // السحب الأفقي للتنقل بين الصفحات الرئيسية (حركة بصرية فقط)
  const [swipeDirection, setSwipeDirection] = useState<'forward' | 'backward' | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y'; dx: number; dy: number; pullCandidate: boolean; backEdge?: boolean } | null>(null);
  const swipeTimerRef = useRef<number | null>(null);
  const swipeAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
    if (swipeAnimationFrameRef.current !== null) window.cancelAnimationFrame(swipeAnimationFrameRef.current);
  }, []);

  // ترتيب صفحات التنقل بالسحب (نفس مسارات أزرار الشريط السفلي)
  const swipeRoutes = useMemo(() => ['/feed', '/reels', '/search', '/messages', '/profile'], []);

  const getRouteIndex = useCallback(
    (target: string) => {
      const normalized = target === '/' ? '/feed' : target;

      return swipeRoutes.findIndex(route => {
        if (normalized === route) return true;

        // المسارات الفرعية تُحسب ضمن تبويبها (مثل /messages/:id و /profile/:id)
        if (route !== '/feed' && normalized.startsWith(`${route}/`)) return true;

        return false;
      });
    },
    [swipeRoutes],
  );

  const setMainOffset = (offset: number, animated: boolean) => {
    const node = mainRef.current;
    if (!node) return;

    node.style.transition = animated
      ? 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)'
      : 'none';
    node.style.transform = offset === 0 ? '' : `translate3d(${offset}px, 0, 0)`;
  };

  const handleSwipeStart = (event: ReactTouchEvent) => {
    // التنقل بالسحب مخصص لتبويبات الشريط السفلي فقط، ولا يعمل داخل الشاشات المغطاة أو النوافذ المنبثقة
    if (document.body.classList.contains('aani-immersive') || hasOpenModal()) {
      swipeStartRef.current = null;
      setMainOffset(0, true);
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;

    // في الملفات الشخصية الفرعية: لا سحبة تبويبات إطلاقاً، ولا يُسلح إلا
    // إيماءة الرجوع من الحافة اليمنى (تُقرر عند الإفلات وتستهدف سجل الصفحات)
    if (isProfileSubView) {
      if (touch.clientX >= window.innerWidth - 56) {
        swipeStartRef.current = { x: touch.clientX, y: touch.clientY, axis: 'none', dx: 0, dy: 0, pullCandidate: false, backEdge: true };
      } else {
        swipeStartRef.current = null;
      }
      return;
    }

    const target = event.target as HTMLElement | null;
    const reelVideo = target?.closest('.reel-slide video:not([controls])');
    const isSearchPage = path === '/search';

    // اسمح بالسحب من أي موضع في البحث، مع الحفاظ على المناطق التفاعلية في بقية الصفحات
    if (!isSearchPage && isHorizontalGestureArea(target) && !reelVideo) {
      swipeStartRef.current = null;
      return;
    }

    const scrollTop = Math.max(
      0,
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    const pullCandidate = (path === '/' || path === '/feed')
      && scrollTop <= 2
      && !target?.closest('button, a, input, textarea, select, [role="dialog"], [contenteditable="true"], .story-strip');

    setMainOffset(0, false);
    swipeStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      axis: 'none',
      dx: 0,
      dy: 0,
      pullCandidate,
    };
  };

  const handleSwipeMove = (event: ReactTouchEvent) => {
    if (document.body.classList.contains('aani-immersive') || hasOpenModal()) {
      swipeStartRef.current = null;
      setMainOffset(0, true);
      return;
    }

    const start = swipeStartRef.current;
    if (!start) return;

    const touch = event.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const threshold = 50;
    const horizontalDominant = Math.abs(deltaX) > Math.abs(deltaY);

    start.dx = deltaX;
    start.dy = deltaY;

    if (start.pullCandidate && deltaY >= threshold && Math.abs(deltaY) > Math.abs(deltaX)) {
      start.axis = 'y';
      setMainOffset(0, false);
      return;
    }

    if (Math.abs(deltaX) >= threshold && horizontalDominant) {
      start.axis = 'x';
    } else if (Math.abs(deltaY) >= threshold && !horizontalDominant) {
      start.axis = 'y';
    } else {
      start.axis = 'none';
    }

    if (start.axis !== 'x') {
      setMainOffset(0, false);
      return;
    }

    // إيماءة الرجوع في الشاشات الفرعية: تُتتبع بلا سحب بصري وتُقرر عند الإفلات
    if (start.backEdge) {
      setMainOffset(0, false);
      return;
    }

    // مقاومة عند الحدود: السحب من اليسار إلى اليمين يقدّم، ومن اليمين إلى اليسار يرجع
    const index = getRouteIndex(path);
    const atForwardLimit = index >= swipeRoutes.length - 1 && deltaX > 0;
    const atBackwardLimit = index <= 0 && deltaX < 0;

    setMainOffset(atForwardLimit || atBackwardLimit ? deltaX * 0.25 : deltaX, false);
  };

  const handleSwipeEnd = () => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    if (document.body.classList.contains('aani-immersive') || hasOpenModal()) {
      setMainOffset(0, true);
      return;
    }

    // إيماءة السحب للرجوع في الشاشات الفرعية: تستهدف سجل الصفحات حصراً
    // (يغلق أية شاشة كاملة مفتوحة عبر الرصة، أو يعود للمسار السابق) دون تغيير تبويب
    if (start?.backEdge) {
      if (start.dx <= -70 && Math.abs(start.dx) > Math.abs(start.dy)) goBackOrPush('/profile');
      return;
    }

    const threshold = 50;
    const horizontalSwipe = Boolean(start && start.axis === 'x');
    const shouldNavigate = Boolean(
      start && Math.abs(start.dx) >= threshold && Math.abs(start.dx) > Math.abs(start.dy),
    );
    let navigated = false;

    if (shouldNavigate && start) {
      const index = getRouteIndex(path);

      if (index >= 0) {
        // السحب من اليسار إلى اليمين (deltaX > 0) يقدّم، ومن اليمين إلى اليسار يرجع
        const goingForward = start.dx > 0;
        const nextIndex = goingForward ? index + 1 : index - 1;

        if (nextIndex >= 0 && nextIndex < swipeRoutes.length) {
          navigated = true;
          const nextDirection = goingForward ? 'forward' : 'backward';
          setSwipeDirection(null);
          setLocation(swipeRoutes[nextIndex]);

          // أعد تشغيل حركة الدخول حتى عند تكرار الاتجاه بسرعة بين عدة تبويبات
          if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
          if (swipeAnimationFrameRef.current !== null) window.cancelAnimationFrame(swipeAnimationFrameRef.current);
          swipeAnimationFrameRef.current = window.requestAnimationFrame(() => {
            swipeAnimationFrameRef.current = null;
            setSwipeDirection(nextDirection);
            swipeTimerRef.current = window.setTimeout(() => {
              setSwipeDirection(null);
              swipeTimerRef.current = null;
            }, 420);
          });

          // بداية الصفحة الجديدة من الأعلى لتبدو الحركة انتقالًا حقيقيًا
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
      }
    }

    if (navigated) {
      // إزالة التحريك اللحظي فورًا حتى لا يتعارض مع حركة دخول الصفحة الجديدة
      const node = mainRef.current;
      if (node) {
        node.style.transition = 'none';
        node.style.transform = '';
      }
    } else if (horizontalSwipe) {
      // ارتداد ناعم إلى الموضع الأصلي عند عدم بلوغ العتبة
      setMainOffset(0, true);
    }
  };

  const [postText, setPostText] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [imagePreviewImages, setImagePreviewImages] = useState<{ file: File; dataUrl: string }[]>([]);
  const [showImagePreviewModal, setShowImagePreviewModal] = useState(false);
  const [showVideoPreviewModal, setShowVideoPreviewModal] = useState(false);
  const [videoTrim, setVideoTrim] = useState<VideoTrimRange | null>(null);
  const [videoCrop, setVideoCrop] = useState<VideoCropTransform | null>(null);
  // غلاف الفيديو المختار من شاشة المعاينة (يُرفع ويُحفظ كوسام cover في post_metadata)
  const [videoCoverFile, setVideoCoverFile] = useState<File | null>(null);
  const [videoCoverPreview, setVideoCoverPreview] = useState<string | null>(null);
  // حسابات الإشارة المختارة من شاشة معاينة الفيديو (إشارة متعددة)
  const [videoMentions, setVideoMentions] = useState<VideoMentionPerson[]>([]);
  // شاشة المتابعين/المتابَعين كاملة الشاشة — مستضافة في Shell حتى تبقى حية
  // عبر التنقل بين الملفات الشخصية، وتُعاد فتحها من سياقها المحفوظ عند الرجوع
  const [followListView, setFollowListView] = useState<{ kind: FollowListKind; targetUserId: string; restoreSession?: boolean } | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: FollowListKind; targetUserId: string }>).detail;
      if (!detail?.kind || !detail?.targetUserId) return;
      setFollowListView({ kind: detail.kind, targetUserId: detail.targetUserId });
    };
    window.addEventListener('aani:open-follow-list', handler);
    return () => window.removeEventListener('aani:open-follow-list', handler);
  }, []);

  // الرجوع من ملف شخصي مزار إلى مدخل قائمة المتابعين المحفوظ → أعِد فتحها بنفس الحالة
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; kind?: FollowListKind; targetUserId?: string }>).detail;
      if (detail?.type !== 'follow-list' || !detail.kind || !detail.targetUserId) return;
      setFollowListView({ kind: detail.kind, targetUserId: detail.targetUserId, restoreSession: true });
    };
    window.addEventListener('aani:restore-overlay', handler);
    return () => window.removeEventListener('aani:restore-overlay', handler);
  }, []);

  // وجهة احتياطية لرجوع آمن (goBackOrPush) عندما لا يوجد سجل سابق
  useEffect(() => {
    const handler = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      if (typeof target === 'string' && target) setLocation(target);
    };
    window.addEventListener('aani:navigate', handler);
    return () => window.removeEventListener('aani:navigate', handler);
  }, [setLocation]);

  // تنظيف عند مغادرة أي شاشة فرعية: أزل أي قفل تمرير أو طبقة تغطية متبقية
  // وصفّر حالة السحب حتى لا تبقى تحريكات أو حواجز تحجب الواجهة
  useEffect(() => {
    return () => {
      if (!isProfileSubView) return;
      window.requestAnimationFrame(() => {
        const remainingDialog = Boolean(document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
        ));
        if (remainingDialog) return;
        document.body.style.overflow = 'unset';
        document.body.style.position = 'static';
        document.body.style.overscrollBehavior = '';
        document.body.classList.remove('overflow-hidden', 'fixed', 'inset-0');
        swipeStartRef.current = null;
        setMainOffset(0, true);
        if (mainRef.current) {
          mainRef.current.style.transition = 'none';
          mainRef.current.style.transform = '';
        }
      });
    };
  }, [isProfileSubView]);

  // صفّر حالة السحب عند كل تغيير مسار حتى لا تُركَ تحريكة معلقة
  useEffect(() => {
    swipeStartRef.current = null;
    setMainOffset(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const [fileType, setFileType] = useState<'image' | 'video' | null>(null);
  const [destination, setDestination] = useState<PostDestination>('feed');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');
  const isPublishFlowOpen = showPublishOptionsSheet || showImagePreviewModal || showVideoPreviewModal || showCreateModal;
  const publishFlowWasOpenRef = useRef(false);

  useLayoutEffect(() => {
    const wasOpen = publishFlowWasOpenRef.current;
    publishFlowWasOpenRef.current = isPublishFlowOpen;
    if (wasOpen === isPublishFlowOpen) return;

    if (isPublishFlowOpen) {
      window.dispatchEvent(new Event('aani:pause-feed-videos'));
    } else {
      if (!hasOpenDialog()) window.dispatchEvent(new Event('aani:resume-feed-videos'));
      releasePageInteraction();
    }
  }, [isPublishFlowOpen]);

  // وسوم مُهيّأة لشاشة إنشاء المنشور (إشارات اختيرت أثناء معاينة الفيديو)
  const initialCreateTags = useMemo<PostMetadataTag[]>(() => videoMentions.map(person => {
    // استخدم الاسم الظاهر الحقيقي مع تجاهل الأسماء الافتراضية (مثل "New member")
    const taggedName = displayName({
      display_name: person.display_name,
      full_name: person.full_name,
      username: person.username,
    });
    return {
      kind: 'mention' as const,
      label: person.username,
      href: `/profile/${person.id}`,
      profileId: person.id,
      ...(taggedName ? { displayName: taggedName } : {}),
    };
  }), [videoMentions]);

  // معاينات الملفات: إنشاء الروابط مرة واحدة لكل ملف مع تنظيفها بعد الاستخدام
  const filePreviews = useMemo(
    () => selectedFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [selectedFiles]
  );

  useEffect(() => {
    if (filePreviews.length === 0) return;
    return () => filePreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [filePreviews]);

  useEffect(() => {
    const unlockAudio = () => {
      void unlockNotificationAudio();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !userId) return undefined;
    const handleCallLog = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isCallLogEventDetail(detail) || handledCallLogsRef.current.has(detail.callId)) return;
      handledCallLogsRef.current.add(detail.callId);
      if (handledCallLogsRef.current.size > 250) {
        const oldestCallId = handledCallLogsRef.current.values().next().value;
        if (oldestCallId) handledCallLogsRef.current.delete(oldestCallId);
      }
      const content = `[aani-call:v1]${JSON.stringify({
        callId: detail.callId,
        mode: detail.mode,
        outcome: detail.outcome,
        durationSeconds: detail.durationSeconds,
      })}`;
      void (async () => {
        try {
          const { error } = await supabase.from('messages').insert({
            id: createCallLogMessageId(),
            sender_id: userId,
            recipient_id: detail.recipientId,
            content,
          });
          if (error) throw error;
        } catch (error) {
          handledCallLogsRef.current.delete(detail.callId);
          console.error('[calls] تعذر حفظ سجل المكالمة في المحادثة:', error);
        }
      })();
    };
    window.addEventListener(CALL_LOG_EVENT, handleCallLog);
    return () => window.removeEventListener(CALL_LOG_EVENT, handleCallLog);
  }, [userId]);

  useEffect(() => {
    if (!supabaseConfigured || !userId) {
      setUnreadCount(0);
      return;
    }
    let active = true;
    void supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', userId).eq('is_read', false).then(({ count, error }) => {
      if (active && !error) setUnreadCount(count || 0);
    });
    return () => { active = false; };
  }, [userId, showNotifsModal]);

  useEffect(() => {
    if (!supabaseConfigured || !userId) return undefined;
    let countRefreshTimer: number | null = null;
    const refreshUnreadCount = () => {
      if (countRefreshTimer !== null) window.clearTimeout(countRefreshTimer);
      countRefreshTimer = window.setTimeout(() => {
        countRefreshTimer = null;
        void supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', userId).eq('is_read', false).then(({ count, error }) => {
          if (!error) setUnreadCount(count || 0);
        });
      }, 80);
    };
    const channel = supabase.channel(`aani-notifications-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, payload => {
        const notification = payload.new as { id?: unknown; type?: unknown; is_read?: unknown };
        const notificationId = typeof notification.id === 'string' ? notification.id : '';
        if (notificationId && !seenNotificationIdsRef.current.has(notificationId)) {
          seenNotificationIdsRef.current.add(notificationId);
          if (seenNotificationIdsRef.current.size > 250) {
            const oldestId = seenNotificationIdsRef.current.values().next().value;
            if (oldestId) seenNotificationIdsRef.current.delete(oldestId);
          }
          if (['message', 'new_message'].includes(String(notification.type))
            && profile?.notification_settings?.messages !== false) playMessageChime();
        }
        refreshUnreadCount();
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, refreshUnreadCount)
      .subscribe();
    return () => {
      if (countRefreshTimer !== null) window.clearTimeout(countRefreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [profile?.notification_settings?.messages, userId]);

  const handleSelectPublishImages = async (files: File[]) => {
    if (!files.length) return;
    setShowVideoPreviewModal(false);
    setVideoTrim(null);
    setVideoCrop(null);
    setDestination('feed');
    setCreateError('');
    try {
      const previews = await Promise.all(files.map(async file => ({ file, dataUrl: await fileAsDataUrl(file) })));
      setSelectedFiles(previews.map(preview => preview.file));
      setFileType('image');
      setImagePreviewImages(previews);
      setShowPublishOptionsSheet(false);
      setShowImagePreviewModal(true);
    } catch {
      setShowPublishOptionsSheet(false);
      setCreateError('تعذر تجهيز الصور المختارة. حاول اختيارها مرة أخرى.');
    }
  };

  const handleImagePreviewChange = (images: { file: File; dataUrl: string }[]) => {
    setImagePreviewImages(images);
    setSelectedFiles(images.map(image => image.file));
  };

  const closeImagePreview = () => {
    setShowImagePreviewModal(false);
    setImagePreviewImages([]);
    setSelectedFiles([]);
    setFileType(null);
  };

  const continueToPostCaption = () => {
    setShowImagePreviewModal(false);
    setImagePreviewImages([]);
    setShowCreateModal(true);
  };

  const handleSelectPublishVideo = (file: File) => {
    if (!file.type.startsWith('video/')) return;
    setShowPublishOptionsSheet(false);
    setShowImagePreviewModal(false);
    setImagePreviewImages([]);
    setShowCreateModal(false);
    setSelectedFiles([file]);
    setPostText('');
    setFileType('video');
    setDestination(path === '/reels' ? 'reels' : 'feed');
    setVideoTrim(null);
    setVideoCrop(null);
    setCreateError('');
    clearVideoCover();
    setVideoMentions([]);
    setShowVideoPreviewModal(true);
  };

  const clearVideoCover = () => {
    if (videoCoverPreview) URL.revokeObjectURL(videoCoverPreview);
    setVideoCoverFile(null);
    setVideoCoverPreview(null);
  };

  const handleVideoCoverChange = (cover: File | null, previewUrl: string | null) => {
    if (videoCoverPreview && videoCoverPreview !== previewUrl) URL.revokeObjectURL(videoCoverPreview);
    setVideoCoverFile(cover);
    setVideoCoverPreview(previewUrl);
  };

  const handleVideoMentionSelect = (person: VideoMentionPerson) => {
    setVideoMentions(current => current.some(item => item.id === person.id) ? current : [...current, person]);
  };

  const handleVideoMentionDeselect = (personId: string) => {
    setVideoMentions(current => current.filter(item => item.id !== personId));
  };

  const closeVideoPreview = () => {
    setShowVideoPreviewModal(false);
    setSelectedFiles([]);
    setVideoTrim(null);
    setVideoCrop(null);
    setFileType(null);
    setDestination('feed');
    clearVideoCover();
    setVideoMentions([]);
  };

  const continueToVideoCaption = (range: VideoTrimRange, crop: VideoCropTransform) => {
    setVideoTrim(range);
    setVideoCrop(crop);
    setShowVideoPreviewModal(false);
    setShowCreateModal(true);
  };

  const handlePublish = (postMetadata: PostMetadataTag[] = [], postDestination: PostDestination = destination) => {
    if (!supabaseConfigured) {
      setCreateError('إعدادات الاتصال بقاعدة البيانات غير مكتملة في Secrets.');
      return;
    }

    const content = postText.trim();
    const files = [...selectedFiles];
    const mediaType = fileType;
    const trim = videoTrim;
    const crop = videoCrop;
    const metadata = [...postMetadata];
    // مصفوفة معرفات المشار إليهم الصريحة (UUIDs) تُخزَّن مع المنشور للسؤال السريع في تبويب «المشار فيها»
    const taggedUserIds = Array.from(new Set(
      metadata
        .filter(tag => tag.kind === 'mention' && tag.profileId)
        .map(tag => tag.profileId as string),
    ));
    const taggedUsersTag: PostMetadataTag | null = taggedUserIds.length > 0
      ? { kind: 'tagged_users', label: 'إشارات', href: '', profileIds: taggedUserIds }
      : null;
    // غلاف الفيديو المختار في المعاينة (يُرفع فقط عند نشر فيديو)
    const coverFile = mediaType === 'video' ? videoCoverFile : null;
    if (postDestination === 'reels' && mediaType !== 'video') {
      setCreateError('يجب اختيار مقطع فيديو للنشر في الريلز.');
      return;
    }
    if (!content && files.length === 0 && metadata.length === 0) return;
    if (Array.from(content).length > 2000) {
      setCreateError('نص المنشور يتجاوز الحد الأقصى البالغ 2000 حرف. اختصر النص قبل النشر.');
      return;
    }

    const postId = createPostId();
    const createdAt = new Date().toISOString();
    const objectUrls = files.map(file => URL.createObjectURL(file));
    const localMediaUrls = objectUrls.map((url, index) => mediaType === 'video' ? buildVideoMediaUrl(url, trim, crop) : appendImageMediaAspect(url, files[index].name));
    const type: Post['type'] = files.length === 0 ? 'text' : mediaType === 'image' ? 'photo' : 'reel';
    const author = profile || {
      id: userId,
      username: '',
      full_name: '',
      avatar_url: null,
      bio: '',
    };
    const optimisticPost: Post = {
      id: postId,
      user_id: userId,
      content,
      post_metadata: [...metadata, ...(taggedUsersTag ? [taggedUsersTag] : [])],
      tagged_user_ids: taggedUserIds,
      media_url: localMediaUrls[0] || null,
      media_urls: localMediaUrls.length > 0 ? localMediaUrls : null,
      type,
      destination: postDestination,
      created_at: createdAt,
      author,
      likes_count: 0,
      comments_count: 0,
      reposts_count: 0,
      likes: [],
      comments: [],
    };

    let attemptInProgress = false;
    const attemptPublish = async () => {
      if (attemptInProgress) return;
      attemptInProgress = true;
      updatePendingPost(postId, { stage: 'uploading', progress: 0, error: null });
      try {
        const { data: authData, error: authError } = await supabase.auth.getUser();
        if (authError) throw new Error('تعذر التحقق من جلسة الحساب. أعد تسجيل الدخول ثم حاول مجدداً.');
        const authenticatedUserId = authData.user?.id;
        if (!authenticatedUserId) throw new Error('يجب تسجيل الدخول قبل نشر المحتوى.');
        if (authenticatedUserId !== userId) throw new Error('تغيّر الحساب النشط. حدّث الصفحة ثم أعد المحاولة.');

        const uploadedUrls = new Array<string>(files.length);
        const fileProgress = files.map(() => 0);
        const totalBytes = files.reduce((sum, file) => sum + Math.max(1, file.size), 0);

        await Promise.all(files.map(async (file, index) => {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-') || `media-${index}`;
          const uploadedPath = `${authenticatedUserId}/${postId}/${index}-${safeName}`;
          await uploadMedia({
            file,
            path: uploadedPath,
            onProgress: percent => {
              fileProgress[index] = percent;
              const uploadedBytes = files.reduce((sum, currentFile, currentIndex) => (
                sum + Math.max(1, currentFile.size) * (fileProgress[currentIndex] / 100)
              ), 0);
              updatePendingPost(postId, {
                progress: Math.min(94, Math.floor((uploadedBytes / totalBytes) * 94)),
              });
            },
          });
          const publicUrl = supabase.storage.from(storageBucket).getPublicUrl(uploadedPath).data.publicUrl;
          uploadedUrls[index] = mediaType === 'video' ? buildVideoMediaUrl(publicUrl, trim, crop) : appendImageMediaAspect(publicUrl, file.name);
        }));

        // رفع صورة الغلاف إن اختيرت — فشلها لا يعطل نشر المنشور
        let coverTag: PostMetadataTag | null = null;
        if (coverFile) {
          try {
            const coverPath = `${authenticatedUserId}/${postId}/cover-${Date.now()}.jpg`;
            await uploadMedia({ file: coverFile, path: coverPath });
            const coverPublicUrl = supabase.storage.from(storageBucket).getPublicUrl(coverPath).data.publicUrl;
            coverTag = { kind: 'cover', label: 'غلاف', href: coverPublicUrl };
          } catch {
            coverTag = null;
          }
        }

        // الوسوم المخزنة: وسوم المحرر + وسام tagged_users + وسام الغلاف إن وُجد
        const storedMetadata = [
          ...metadata,
          ...(taggedUsersTag ? [taggedUsersTag] : []),
          ...(coverTag ? [coverTag] : []),
        ];

        const publishedPost: Post = {
          ...optimisticPost,
          media_url: uploadedUrls[0] || null,
          media_urls: uploadedUrls.length > 0 ? uploadedUrls : null,
          post_metadata: storedMetadata,
        };
        updatePendingPost(postId, { post: publishedPost, stage: 'publishing', progress: 96, error: null });

        const postPayload = {
          id: postId,
          user_id: authenticatedUserId,
          content,
          post_metadata: storedMetadata,
          media_url: uploadedUrls[0] || null,
          media_urls: uploadedUrls.length > 0 ? uploadedUrls : null,
          type,
          created_at: createdAt,
          // العمود الصريح لمصفوفة معرفات المشار إليهم (ترحيل 20270102000000)
          ...(taggedUserIds.length > 0 ? { tagged_user_ids: taggedUserIds } : {}),
        };
        let postError = (await supabase.from('posts').upsert({
          ...postPayload,
          destination: postDestination,
        }, { onConflict: 'id' })).error;

        if (
          postError
          && postDestination === 'feed'
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('destination')
        ) {
          postError = (await supabase.from('posts').upsert(postPayload, { onConflict: 'id' })).error;
        }

        // قاعدة بيانات لم يُطبَّق عليها عمود tagged_user_ids بعد → أعد المحاولة بدونه حتى لا يتعطل النشر
        if (
          postError
          && 'tagged_user_ids' in postPayload
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('tagged_user_ids')
        ) {
          const payloadWithoutColumn = { ...postPayload } as Record<string, unknown>;
          delete payloadWithoutColumn.tagged_user_ids;
          postError = (await supabase.from('posts').upsert(payloadWithoutColumn, { onConflict: 'id' })).error;
        }

        // قاعدة بيانات لا تقبل وسام الغلاف بعد → أعد المحاولة بدونه حتى لا يتعطل النشر
        if (
          postError
          && coverTag
          && (
            postError.code === '23514'
            || postError.code === '22P02'
            || ((postError.code === '42703' || postError.code === 'PGRST204') && postError.message.includes('post_metadata'))
          )
        ) {
          postError = (await supabase.from('posts').upsert({
            ...postPayload,
            // أعد المحاولة بلا وسام الغلاف مع الإبقاء على وسوم الإشارة وtagged_users
            post_metadata: [...metadata, ...(taggedUsersTag ? [taggedUsersTag] : [])],
          }, { onConflict: 'id' })).error;
          if (!postError) {
            const metadataWithoutCover = [...metadata, ...(taggedUsersTag ? [taggedUsersTag] : [])];
            updatePendingPost(postId, { post: { ...publishedPost, post_metadata: metadataWithoutCover }, error: null });
          }
        }

        if (postError) {
          handleAppError('فشل حفظ المنشور', postError, 'تعذر حفظ المنشور. راجع التفاصيل التشخيصية.');
          let publishError: Error;
          if (isPostsPermissionError(postError)) {
            publishError = new Error('رفضت قاعدة البيانات حفظ المنشور بسبب صلاحيات جدول posts. راجع GRANT وسياسات RLS في Supabase لدور authenticated؛ لم يتم تجاوز الحماية.');
          } else if ((postError.code === '42703' || postError.code === 'PGRST204') && postError.message.includes('post_metadata')) {
            publishError = new Error('يجب تطبيق الترحيل 20261122000000_post_metadata_chips.sql على قاعدة Supabase قبل نشر الوسوم.');
          } else if ((postError.code === '42703' || postError.code === 'PGRST204') && postError.message.includes('destination')) {
            publishError = new Error('يجب تطبيق الترحيل 20261126000000_post_destinations.sql على Supabase لفصل منشورات الواجهة عن الريلز.');
          } else if (postError.code === '23514' && postError.message.includes('posts_content_length_check')) {
            publishError = new Error('قاعدة البيانات تستخدم قيدًا قديمًا للمنشورات. طبّق الترحيل 20261122000000_post_metadata_chips.sql على Supabase ثم أعد المحاولة.');
          } else {
            publishError = new Error(`فشل حفظ المنشور: ${postError.message}`);
          }
          markAppErrorReported(publishError);
          throw publishError;
        }

        updatePendingPost(postId, { stage: 'success', progress: 100, error: null, retry: null });
        window.dispatchEvent(new Event('aani:post-created'));
        window.setTimeout(() => {
          removePendingPost(postId);
          window.dispatchEvent(new Event('aani:post-created'));
        }, 1200);
      } catch (error) {
        if (!wasAppErrorReported(error)) {
          handleAppError('فشل نشر المنشور', error, 'تعذر نشر المنشور. راجع التفاصيل التشخيصية ثم أعد المحاولة.');
        }
        const message = error instanceof Error ? error.message : 'حدث خطأ غير متوقع أثناء النشر.';
        updatePendingPost(postId, { stage: 'failed', error: message, retry: () => { void attemptPublish(); } });
      } finally {
        attemptInProgress = false;
        releasePageInteraction();
      }
    };

    addPendingPost({
      id: postId,
      post: optimisticPost,
      progress: 0,
      stage: 'uploading',
      error: null,
      objectUrls,
      retry: () => { void attemptPublish(); },
    });
    void attemptPublish();

    setPostText('');
    setSelectedFiles([]);
    setImagePreviewImages([]);
    setShowImagePreviewModal(false);
    setShowVideoPreviewModal(false);
    setVideoTrim(null);
    setVideoCrop(null);
    setFileType(null);
    setDestination('feed');
    clearVideoCover();
    setVideoMentions([]);
    setShowCreateModal(false);
    setIsSubmitting(false);
    setCreateError('');
    // لا إعادة توجيه تلقائية للرئيسية: ابقَ في الشاشة التي كنت عليها،
    // والانتقال فقط عند تغيّر السياق الفعلي (نشر ريلز من غير شاشة الريلز،
    // أو مغادرة شاشة الريلز بعد نشر منشور تغذية)
    const destinationPath = postDestination === 'reels' ? '/reels' : '/feed';
    const shouldNavigate = postDestination === 'reels'
      ? path !== '/reels'
      : path === '/reels';
    if (shouldNavigate) setLocation(destinationPath);
  };

  const isFeedPath = path === '/' || path === '/feed';
  const isMessageThread = path.startsWith('/messages/');
  const isMessagesPath = path === '/messages' || isMessageThread;

  return (
    <div className={`app-frame min-h-screen bg-black text-white ${path === '/reels' ? 'is-reels' : ''} ${path === '/messages' || isMessageThread ? 'is-messages' : ''}${isMessageThread ? ' is-message-thread' : ''}${isProfilePath ? ' is-profile' : ''}`}>
      {!isMessagesPath && !isProfilePath && (
        <UnifiedTopBar
          hidden={isFeedPath ? unifiedTopBarHidden : chromeHidden}
          unreadCount={unreadCount}
          stories={isFeedPath ? headerStories : undefined}
          showSettingsButton={path === '/profile'}
          onOpenSettings={() => setShowSettingsModal(true)}
          onOpenNotifications={() => setShowNotifsModal(true)}
          onOpenCreatePost={() => setShowPublishOptionsSheet(true)}
          onRefresh={requestContentRefresh}
        />
      )}

      <ShellOverlayControls
        showPublishOptionsSheet={showPublishOptionsSheet}
        onClosePublishOptionsSheet={() => setShowPublishOptionsSheet(false)}
        onCreateTextPost={() => {
          setDestination('feed');
          setVideoMentions([]);
          setShowCreateModal(true);
        }}
        onSelectPublishImages={handleSelectPublishImages}
        onSelectPublishVideo={handleSelectPublishVideo}
        onOpenMorePublishOptions={requestStoryComposer}
        showImagePreviewModal={showImagePreviewModal}
        imagePreviewImages={imagePreviewImages}
        onImagePreviewImagesChange={handleImagePreviewChange}
        onCloseImagePreview={closeImagePreview}
        onNextImagePreview={continueToPostCaption}
        showVideoPreviewModal={showVideoPreviewModal}
        videoPreviewUrl={fileType === 'video' ? filePreviews[0]?.url || null : null}
        videoTrim={videoTrim}
        videoCrop={videoCrop}
        videoCoverPreview={videoCoverPreview}
        onVideoTrimChange={setVideoTrim}
        onVideoCropChange={setVideoCrop}
        onVideoCoverChange={handleVideoCoverChange}
        onVideoMentionSelect={handleVideoMentionSelect}
        onVideoMentionDeselect={handleVideoMentionDeselect}
        initialVideoMentions={videoMentions}
        onCloseVideoPreview={closeVideoPreview}
        onNextVideoPreview={continueToVideoCaption}
        showCreateModal={showCreateModal}
        postText={postText}
        selectedFiles={selectedFiles}
        fileType={fileType}
        destination={destination}
        onDestinationChange={setDestination}
        filePreviews={filePreviews}
        isSubmitting={isSubmitting}
        createError={createError}
        initialCreateTags={initialCreateTags}
        onPostTextChange={setPostText}
        onRemoveFile={index => {
          setSelectedFiles(files => files.filter((_, idx) => idx !== index));
          if (fileType === 'video') {
            setVideoTrim(null);
            setVideoCrop(null);
            setFileType(null);
            setDestination('feed');
          }
        }}
        onPublish={(tagContent, postDestination) => void handlePublish(tagContent, postDestination)}
        onCloseCreatePost={() => {
          setShowCreateModal(false);
          setVideoMentions([]);
          if (fileType === 'video') {
            setSelectedFiles([]);
            setVideoTrim(null);
            setVideoCrop(null);
            setFileType(null);
            setDestination('feed');
          }
        }}
        showSettingsModal={showSettingsModal}
        onCloseSettings={() => setShowSettingsModal(false)}
        profile={profile}
        onProfileUpdate={onProfileUpdate}
        onOpenNotifications={() => setShowNotifsModal(true)}
        onSignOut={handleSignOut}
        showNotifsModal={showNotifsModal}
        onCloseNotifications={() => setShowNotifsModal(false)}
        openFollowRequests={openFollowRequestsOnOpen}
        onOpenFollowRequestsHandled={acknowledgeOpenFollowRequests}
        onOpenFollowRequests={requestOpenFollowRequests}
        onOpenComments={onOpenComments}
        onOpenStory={onOpenStory}
        NotificationsModalComponent={NotificationsModalComponent}
        userId={userId}
        showAssistantModal={showAssistantModal}
        hideAssistantLauncher={isProfilePath}
        onOpenAssistant={() => setShowAssistantModal(true)}
        onCloseAssistant={() => setShowAssistantModal(false)}
      />
      <CallManager currentUserId={userId} currentProfile={profile} contact={null} />
      {followListView && (
        <FollowListView
          kind={followListView.kind}
          targetUserId={followListView.targetUserId}
          currentUserId={userId}
          restoreSession={followListView.restoreSession}
          onClose={() => setFollowListView(null)}
          onDismiss={() => setFollowListView(null)}
        />
      )}

      <div className="content-shell" style={{ paddingBottom: isMessageThread ? 0 : 'calc(6rem + env(safe-area-inset-bottom))' }}>
        <main
          ref={mainRef}
          className={`main-content ${
            swipeDirection === 'forward'
              ? 'page-slide-forward'
              : swipeDirection === 'backward'
                ? 'page-slide-backward'
                : ''
          }`}
          style={{ touchAction: isProfileSubView ? 'pan-y' : undefined }}
          onTouchStart={path === '/search' || isMessagesPath ? undefined : handleSwipeStart}
          onTouchMove={path === '/search' || isMessagesPath ? undefined : handleSwipeMove}
          onTouchEnd={path === '/search' || isMessagesPath ? undefined : handleSwipeEnd}
          onTouchCancel={path === '/search' || isMessagesPath ? undefined : handleSwipeEnd}
          onTouchStartCapture={path === '/search' && !isMessagesPath ? handleSwipeStart : undefined}
          onTouchMoveCapture={path === '/search' && !isMessagesPath ? handleSwipeMove : undefined}
          onTouchEndCapture={path === '/search' && !isMessagesPath ? handleSwipeEnd : undefined}
          onTouchCancelCapture={path === '/search' && !isMessagesPath ? handleSwipeEnd : undefined}
        >
          {children}
        </main>
        {!isMessageThread && (
          <ShellBottomNav
            path={path}
            chromeHidden={isProfilePath ? false : chromeHidden}
            onNavigationTap={handleHomeNavigationTap}
          />
        )}
      </div>
    </div>
  );
}
