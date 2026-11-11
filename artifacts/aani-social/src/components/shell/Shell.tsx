import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { useLocation } from 'wouter';

import ShellBottomNav from './ShellBottomNav';
import ShellOverlayControls from './ShellOverlayControls';
import UnifiedTopBar from './UnifiedTopBar';
import CallManager, { CALL_LOG_EVENT, OPEN_INCOMING_CALL_EVENT, type CallLogEventDetail } from '@/components/CallManager';
import FollowListView, { type FollowListKind } from '@/components/FollowListView';
import NearbyUsersSheet from '@/components/NearbyUsersSheet';
import SoundDetailSheet from '@/components/SoundDetailSheet';
import SoundPickerSheet from '@/components/SoundPickerSheet';
import type { VideoMentionPerson } from '@/components/VideoPreviewModal';
import { playMessageChime, unlockNotificationAudio } from '@/lib/notificationSounds';
import { isHorizontalGestureArea } from '@/lib/appShared';
import { registerRealtimeReconnect } from '@/lib/realtimeReconnect';
import { USE_SOUND_EVENT } from '@/lib/sounds';
import { playInstant, stopInstant, warmAudioContext } from '@/lib/instantAudio';
import { pickDefaultSound, warmDefaultSounds } from '@/lib/defaultSounds';
import { fetchUnreadMessagesCount } from '@/lib/unreadMessages';
import { toast } from 'sonner';
import { handleAppError, markAppErrorReported, wasAppErrorReported } from '@/lib/appErrors';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { addPendingPost, removePendingPost, updatePendingPost } from '@/lib/pendingPosts';
import { uploadMedia } from '@/lib/storyUpload';
import { appendImageMediaAspect, appendVideoTrimFragment, buildVideoMediaUrl } from '@/lib/videoMedia';
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

const truncateCanvasText = (value: string, max: number): string => {
  const characters = Array.from(value);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : value;
};

/**
 * خلفية مرئية افتراضية مولّدة تلقائياً (نظام الأصوات):
 * canvas يدمج أيقونة الصوت واسم صاحبه ليتمكن المستخدم من النشر فوراً
 * عند استخدام صوت بلا فيديو/صورة مختارة. تُبنى كصورة PNG تُرفع كأي وسائط.
 */
const createAutoSoundCanvas = async (soundTitle: string, creatorName: string): Promise<File> => {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر تجهيز مساحة الرسم.');

  // خلفية متدرجة داكنة
  const background = context.createLinearGradient(0, 0, 1080, 1350);
  background.addColorStop(0, '#1d1b21');
  background.addColorStop(0.55, '#3a2630');
  background.addColorStop(1, '#243b35');
  context.fillStyle = background;
  context.fillRect(0, 0, 1080, 1350);

  // هالة دائرية ناعمة بلون الصوت
  const halo = context.createRadialGradient(540, 520, 80, 540, 520, 540);
  halo.addColorStop(0, 'rgba(241, 161, 127, 0.32)');
  halo.addColorStop(1, 'rgba(241, 161, 127, 0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, 1080, 1350);

  // أيقونة الصوت (نغمة)
  context.fillStyle = '#f1a17f';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = 'bold 340px serif';
  context.fillText('♪', 540, 480);

  // عنوان الصوت
  context.fillStyle = '#ffffff';
  context.font = 'bold 62px sans-serif';
  context.fillText(truncateCanvasText(soundTitle, 24), 540, 910);

  // اسم صاحب الصوت
  if (creatorName.trim()) {
    context.fillStyle = 'rgba(255, 255, 255, 0.65)';
    context.font = '38px sans-serif';
    context.fillText(`@${truncateCanvasText(creatorName, 20)}`, 540, 995);
  }

  // توقيع التطبيق
  context.fillStyle = 'rgba(255, 255, 255, 0.35)';
  context.font = '30px sans-serif';
  context.fillText('آني Aani', 540, 1255);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('تعذر تجهيز الخلفية التلقائية.')), 'image/png');
  });
  return new File([blob], `sound-canvas-${Date.now()}.png`, { type: 'image/png' });
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
  const isMessagesScreenNow = path === '/messages' || path.startsWith('/messages/');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPublishOptionsSheet, setShowPublishOptionsSheet] = useState(false);
  const [pendingStoryComposerRequest, setPendingStoryComposerRequest] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showNotifsModal, setShowNotifsModal] = useState(false);
  const [openFollowRequestsOnOpen, setOpenFollowRequestsOnOpen] = useState(false);
  const [showAssistantModal, setShowAssistantModal] = useState(false);
  // نظام الأصوات: الصوت المختار من مكتبة أصوات التطبيق — يُربط بالمنشور الجاري إنشاؤه عند النشر
  // مع زمني اقتصاص الصوت (بالثواني) فيسمع الجميع نفس الجزء
  const [pendingSound, setPendingSound] = useState<{
    id: string;
    title: string;
    sourceVideoUrl?: string | null;
    soundTrim?: { start: number; end: number } | null;
    creatorName?: string | null;
    /** مصدر الصوت: 'user' = اختاره المستخدم يدوياً من المكتبة (لا يُستبدل)، 'auto' = اقتراح تلقائي (يُستبدل في كل دخول) */
    origin?: 'auto' | 'user';
  } | null>(null);
  // التوليد التلقائي للوسائط: هل الوسائط الحالية خلفية مولّدة من الصوت؟
  const [autoSoundMedia, setAutoSoundMedia] = useState(false);
  // وسوم منشور الصور من الشاشة الموحدة (موقع/إشارة)
  const [imagePostTags, setImagePostTags] = useState<PostMetadataTag[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // شارة الرسائل غير المقروءة على أيقونة الرسائل في الشريط السفلي
  const [messagesUnreadCount, setMessagesUnreadCount] = useState(0);
  const seenNotificationIdsRef = useRef(new Set<string>());
  const handledCallLogsRef = useRef(new Set<string>());
  const messagesCountTimerRef = useRef<number | null>(null);
  const showNotifsModalRef = useRef(showNotifsModal);
  const [unifiedTopBarHidden, setUnifiedTopBarHidden] = useState(() => Math.max(
    window.scrollY || 0,
    document.documentElement.scrollTop || 0,
    document.body.scrollTop || 0,
  ) > 10);
  const unifiedTopBarHiddenRef = useRef(unifiedTopBarHidden);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  showNotifsModalRef.current = showNotifsModal;
  // نظام الأصوات: الاستماع لطلب «استخدام هذا الصوت» من مشغلات الريلز/المنشورات —
  // يفتح مسار إنشاء فيديو جديد ويُربط الفيديو الجديد بنفس sound_id عند النشر
  useEffect(() => {
    const onUseSound = (event: Event) => {
      const detail = (event as CustomEvent<{
        soundId?: string;
        title?: string | null;
        sourceVideoUrl?: string | null;
        soundTrim?: { start: number; end: number } | null;
        creatorName?: string | null;
        source?: 'picker' | 'post';
      }>).detail;
      if (!detail?.soundId) return;
      // أصوات القصة يديرها StoriesBar بنفسه (باتجاه القصة) — لا مسار نشر منشورات
      if (detail.source === 'story') return;
      setPendingSound({
        id: detail.soundId,
        title: detail.title || 'الصوت المختار',
        sourceVideoUrl: detail.sourceVideoUrl ?? null,
        soundTrim: detail.soundTrim ?? null,
        creatorName: detail.creatorName ?? null,
        origin: 'user',
      });
      // من مكتبة الأصوات: يُطبق فوراً على المنشور الجاري إنشاؤه
      // من شريط الصوت في منشور آخر: يفتح مسار إنشاء فيديو جديد بنفس الصوت
      if (detail.source === 'picker') {
        toast.success(`تم اختيار الصوت: ${detail.title || 'الصوت المختار'}`);
        // التوليد التلقائي للوسائط: إن لم تُختر وسائط بعد، جهّز خلفية مرئية
        // افتراضية تدمج أيقونة الصوت واسم صاحبه ليتمكن المستخدم من النشر فوراً
        // (مع إمكانية إزالتها أو استبدالها من شاشة المعاينة)
        if (selectedFilesRef.current.length === 0) {
          void (async () => {
            try {
              const canvasFile = await createAutoSoundCanvas(detail.title || 'صوت', detail.creatorName || '');
              setSelectedFiles([canvasFile]);
              setFileType('image');
              setDestination('feed');
              setVideoTrim(null);
              setVideoCrop(null);
              setAutoSoundMedia(true);
              setShowCreateModal(true);
              toast.success('تم تجهيز منشور بالصوت — انشره مباشرة أو استبدل الوسائط.');
            } catch (error) {
              handleAppError('فشل تجهيز الخلفية التلقائية', error, 'تعذر تجهيز الخلفية التلقائية. اختر وسائط يدوياً ثم انشر.');
            }
          })();
        }
        return;
      }
      setShowPublishOptionsSheet(true);
      toast.success('تم اختيار الصوت. اختر فيديو ثم انشر ليُربط بنفس الصوت.');
    };
    window.addEventListener(USE_SOUND_EVENT, onUseSound);
    return () => window.removeEventListener(USE_SOUND_EVENT, onUseSound);
  }, []);
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
  // شاشة الأشخاص القريبين — تُفتح من زر الدبوس في أعلى الشاشة الرئيسية فقط
  const [showNearbyUsers, setShowNearbyUsers] = useState(false);

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

  // تجهيز مسبق (Pre-Warming) لأعلى 3 أصوات افتراضية فور فتح واجهة النشر:
  // روابطها تُحفظ في الذاكرة وتُسخَّن في الكاش الشبكي ليبدأ التشغيل
  // لحظة اختيار الصورة (أقل من 50ms) دون أي استعلام في المسار الحرج
  useEffect(() => {
    if (!isPublishFlowOpen) return;
    // تنشيط صامت لسياق الصوت فور فتح واجهة النشر (داخل إيماءة المستخدم):
    // جعل الجلسة موثوقة للتشغيل الفوري التلقائي بلمح البصر بلا حظر
    warmAudioContext();
    void warmDefaultSounds();
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

  // مرجع لملفات المنشور الجاري إنشاؤه (يُستخدم في أحداث نظام الأصوات)
  const selectedFilesRef = useRef(selectedFiles);
  selectedFilesRef.current = selectedFiles;
  // سجل الأصوات المقترحة تلقائياً (الأحدث أولاً) — يُحفظ في الذاكرة والجلسة
  // (sessionStorage) ويُستبعد كله عند الاقتراح التالي: لا تكرار نهائياً
  // بين المتتاليات ولا عند الخروج والدخول المتكرر من شاشة النشر
  const RECENT_SUGGESTED_LIMIT = 6;
  const recentSuggestedSoundIdsRef = useRef<string[]>([]);
  const readRecentSuggestedSoundIds = (): string[] => {
    if (recentSuggestedSoundIdsRef.current.length > 0) return recentSuggestedSoundIdsRef.current;
    try {
      const stored = window.sessionStorage.getItem('aani:recent-suggested-sound-ids');
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) {
          recentSuggestedSoundIdsRef.current = parsed.filter((id): id is string => typeof id === 'string');
        }
      }
    } catch { /* قد يكون التخزين معطلاً في هذا السياق */ }
    return recentSuggestedSoundIdsRef.current;
  };
  const rememberSuggestedSoundId = (soundId: string) => {
    const next = [soundId, ...readRecentSuggestedSoundIds().filter(id => id !== soundId)].slice(0, RECENT_SUGGESTED_LIMIT);
    recentSuggestedSoundIdsRef.current = next;
    try {
      window.sessionStorage.setItem('aani:recent-suggested-sound-ids', JSON.stringify(next));
    } catch { /* قد يكون التخزين معطلاً في هذا السياق */ }
  };
  const pendingSoundRef = useRef(pendingSound);
  pendingSoundRef.current = pendingSound;

  useEffect(() => {
    const unlockAudio = () => {
      void unlockNotificationAudio();
      // تنشيط صامت لسياق الصوت (Silent Web Audio Warm-up): فتح سياسة التشغيل التلقائي
      warmAudioContext();
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

  // شارة الرسائل غير المقروءة: حساب أولي عند بدء الجلسة،
  // وإعادة حساب عند كل دخول شاشة الرسائل (بعد تعليم الرسائل مقروءة)
  useEffect(() => {
    if (!supabaseConfigured || !userId) {
      setMessagesUnreadCount(0);
      return;
    }
    void fetchUnreadMessagesCount(userId).then(count => {
      if (count !== null) setMessagesUnreadCount(count);
    });
  }, [userId, isMessagesScreenNow]);

  const refreshMessagesUnreadCount = useCallback(() => {
    if (!supabaseConfigured || !userId) return;
    if (messagesCountTimerRef.current !== null) window.clearTimeout(messagesCountTimerRef.current);
    messagesCountTimerRef.current = window.setTimeout(() => {
      messagesCountTimerRef.current = null;
      void fetchUnreadMessagesCount(userId).then(count => {
        if (count !== null) setMessagesUnreadCount(count);
      });
    }, 120);
  }, [userId]);

  useEffect(() => () => {
    if (messagesCountTimerRef.current !== null) window.clearTimeout(messagesCountTimerRef.current);
  }, []);

  // استماع Realtime لجدول messages: أي رسالة واردة أو تعليم قراءة أو حذف
  // يُحدّث شارة الرسائل فوراً دون الحاجة لفتح واجهة المحادثات
  useEffect(() => {
    if (!supabaseConfigured || !userId) return undefined;
    const channel = supabase.channel(`aani-messages-unread-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `recipient_id=eq.${userId}`,
      }, refreshMessagesUnreadCount)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `recipient_id=eq.${userId}`,
      }, refreshMessagesUnreadCount)
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `recipient_id=eq.${userId}`,
      }, refreshMessagesUnreadCount)
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshMessagesUnreadCount, userId]);

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
    // تنبيه منبثق فوري للإشعارات المهمة (متابعة / رسالة) مع اسم صاحب الإشعار
    const showRealtimeToast = (type: string, actorId: string) => {
      if (showNotifsModalRef.current) return;
      void supabase.from('profiles')
        .select('display_name, full_name, username')
        .eq('id', actorId)
        .maybeSingle()
        .then(({ data }) => {
          const actorName = displayName(data as { display_name?: string | null; full_name?: string | null; username?: string | null } | null) || 'مستخدم';
          if (type === 'follow') {
            toast(`${actorName} بدأ متابعتك`, {
              description: 'إشعار متابعة جديد',
              action: { label: 'عرض', onClick: () => setLocation(`/profile/${actorId}`) },
            });
          } else if (type === 'follow_request') {
            toast(`${actorName} أرسل طلب متابعة`, {
              description: 'راجع طلبات المتابعة من نافذة الإشعارات',
              action: { label: 'عرض', onClick: () => requestOpenFollowRequests() },
            });
          } else if (['message', 'new_message'].includes(type)) {
            // داخل شاشة الرسائل تُحدَّث القائمة لحظياً، فلا داعي للتنبيه المنبثق
            if (currentPathRef.current.startsWith('/messages')) return;
            toast(`رسالة جديدة من ${actorName}`, {
              description: 'اضغط لفتح المحادثة',
              action: { label: 'فتح', onClick: () => setLocation(`/messages/${actorId}`) },
            });
          }
        });
    };
    const channel = supabase.channel(`aani-notifications-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, payload => {
        const notification = payload.new as { id?: unknown; type?: unknown; is_read?: unknown; actor_id?: unknown };
        const notificationId = typeof notification.id === 'string' ? notification.id : '';
        if (notificationId && !seenNotificationIdsRef.current.has(notificationId)) {
          seenNotificationIdsRef.current.add(notificationId);
          if (seenNotificationIdsRef.current.size > 250) {
            const oldestId = seenNotificationIdsRef.current.values().next().value;
            if (oldestId) seenNotificationIdsRef.current.delete(oldestId);
          }
          const notificationType = String(notification.type || '');
          if (['message', 'new_message'].includes(notificationType)
            && profile?.notification_settings?.messages !== false) playMessageChime();
          // زيادة فورية للشارة قبل وصول نتيجة الاستعلام المضاد
          if (notification.is_read === false) setUnreadCount(current => current + 1);
          const actorId = typeof notification.actor_id === 'string' ? notification.actor_id : '';
          if (['follow', 'follow_request', 'message', 'new_message'].includes(notificationType) && actorId) {
            showRealtimeToast(notificationType, actorId);
          }
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
  }, [profile?.notification_settings?.messages, requestOpenFollowRequests, setLocation, userId]);

  // إعادة الاتصال التلقائي: عند عودة التطبيق من الخلفية أو رجوع الشبكة
  // تُعاد القنوات للاشتراك (عبر realtimeReconnect) ويُعاد حساب كل عدّادات
  // الشارات لمحاذاة الحالة الفعلية في قاعدة البيانات
  useEffect(() => {
    if (!supabaseConfigured || !userId) return undefined;
    return registerRealtimeReconnect(() => {
      void supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', userId).eq('is_read', false).then(({ count, error }) => {
        if (!error) setUnreadCount(count || 0);
      });
      void fetchUnreadMessagesCount(userId).then(count => {
        if (count !== null) setMessagesUnreadCount(count);
      });
    });
  }, [userId]);

  // ربط الصوت بحدث اختيار الصورة المباشر (Direct User Gesture Audio Trigger):
  // يُستدعى تزامنياً من onChange لاختيار الملفات (بلا أي await قبله) — يختار
  // صوتاً من الوساط المجهزة مسبقاً ويستدعي playInstant() داخل نفس سياق
  // الإيماءة لتجاوز قيود Autoplay Policy نهائياً. يعيد true عند النجاح
  // (فيُتخطى الاقتراح غير المتزامن) وfalse إن لم توجد أوساط مجهزة بعد.
  const attachWarmedSound = (): boolean => {
    if (!supabaseConfigured) return false;
    // صوت اختاره المستخدم يدوياً من مكتبة الأصوات لا يُستبدل — أما المقترح
    // التلقائي فيُستبدل بصوت جديد عشوائي في كل اختيار/دخول (بلا تكرار نهائياً)
    if (pendingSoundRef.current?.origin === 'user') return true;
    const chosen = pickDefaultSound(readRecentSuggestedSoundIds());
    if (!chosen || !chosen.source_video_url) return false;
    rememberSuggestedSoundId(chosen.id);
    setPendingSound({
      id: chosen.id,
      title: chosen.title,
      sourceVideoUrl: chosen.source_video_url || null,
      soundTrim: null,
      origin: 'auto',
    });
    // التشغيل في نفس الملي ثانية داخل سياق إيماءة المستخدم
    playInstant(chosen.source_video_url, { loop: true });
    return true;
  };

  const handleSelectPublishImages = async (files: File[]) => {
    if (!files.length) return;
    setShowVideoPreviewModal(false);
    setVideoTrim(null);
    setVideoCrop(null);
    setDestination('feed');
    setCreateError('');
    setAutoSoundMedia(false);
    // التشغيل الفوري داخل نفس سياق إيماءة المستخدم (onChange): صوت مجهّز مسبقاً
    // يبدأ فور اختيار الصورة بلا أي انتظار — وإن لم توجد أوساط مجهزة بعد
    // استُكمل بالاقتراح الذكي غير المتزامن (يبدأ التشغيل لحظة وصول الصوت)
    if (!attachWarmedSound()) void suggestTrendingSound();
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
    setImagePostTags([]);
    // الخروج من شاشة النشر يوقف الصوت ويفرغ المقترح —
    // فالدخول التالي يقترح صوتاً مختلفاً عشوائياً (بلا تكرار)
    stopInstant();
    setPendingSound(null);
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
    setAutoSoundMedia(false);
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
    setAutoSoundMedia(false);
    stopInstant();
    setPendingSound(null);
  };

  // إزالة الخلفية التلقائية المولدة من الصوت (بعدها يكتب نصاً أو يختار وسائط يدوياً)
  const clearAutoSoundMedia = () => {
    setSelectedFiles([]);
    setAutoSoundMedia(false);
  };

  // استبدال الخلفية التلقائية بوسائط يدوية (فيديو/صورة) من الاستوديو
  const replaceAutoSoundMedia = () => {
    setAutoSoundMedia(false);
    setShowCreateModal(false);
    setShowPublishOptionsSheet(true);
  };

  // النشر المباشر من الشاشة الموحدة لمنشورات الصور:
  // يجمع الوسائط المقصوصة + الوصف + الوسوم + الصوت (sound_id وأوقات الاقتصاص) في طلب واحد
  const handleImagePublishDirect = (croppedImages: { file: File; dataUrl: string }[]) => {
    setShowImagePreviewModal(false);
    setImagePreviewImages([]);
    handlePublish(imagePostTags, destination, croppedImages.map(image => image.file), 'image');
  };

  // الاقتراح الذكي: صوت عشوائي مختلف في كل مرة تتغير فيها الصورة
  // (ترتيب عشوائي على مستوى قاعدة البيانات ORDER BY random() عبر دالة
  // ترحيل 20270112000000، مع احتياط خلط محلي إن لم تُطبَّق الدالة بعد)
  const suggestTrendingSound = async () => {
    if (!supabaseConfigured) return;
    // لا تقترح فوق صوت اختاره المستخدم يدوياً من مكتبة الأصوات — الإلغاء (X) يعيد الاقتراح في المرة القادمة
    if (pendingSoundRef.current?.origin === 'user') return;
    try {
      let soundRows: { id: string; title: string; source_video_url: string | null }[] = [];
      // ترتيب عشوائي في SQL (ORDER BY random() LIMIT 10) — أسرع وأكثر عشوائية
      const randomized = await supabase.rpc('random_trending_sounds', { pool_size: 10 });
      if (!randomized.error && Array.isArray(randomized.data) && randomized.data.length > 0) {
        soundRows = randomized.data as typeof soundRows;
      } else {
        // الاحتياط: قاعدة بيانات بلا دالة الترتيب العشوائي بعد → استعلام عادي + خلط محلي
        const { data: fallbackRows, error: fallbackError } = await supabase
          .from('sounds')
          .select('id, title, source_video_url')
          .order('created_at', { ascending: false })
          .limit(30);
        if (fallbackError) return;
        const pool = (fallbackRows || []) as typeof soundRows;
        for (let index = pool.length - 1; index > 0; index--) {
          const swap = Math.floor(Math.random() * (index + 1));
          [pool[index], pool[swap]] = [pool[swap], pool[index]];
        }
        soundRows = pool.slice(0, 10);
      }
      if (soundRows.length === 0) return;
      // استبعد كل الأصوات المقترحة مؤخراً (سجل الجلسة: الأحدث أولاً) — لا تكرار نهائياً
      const recentIds = readRecentSuggestedSoundIds();
      const fresh = recentIds.length > 0 ? soundRows.filter(sound => !recentIds.includes(sound.id)) : soundRows;
      const candidates = fresh.length > 0 ? fresh : soundRows;
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      rememberSuggestedSoundId(chosen.id);
      setPendingSound({
        id: chosen.id,
        title: chosen.title,
        sourceVideoUrl: chosen.source_video_url || null,
        soundTrim: null,
        origin: 'auto',
      });
      // التشغيل الفوري لحظة وصول الصوت (بالتوازي مع ظهور الصورة بالواجهة) — بلا أي انتظار
      if (chosen.source_video_url) playInstant(chosen.source_video_url, { loop: true });
      toast.success(`صوت مقترح تلقائياً: ${chosen.title}`);
    } catch {
      // فشل الاقتراح لا يعطل مسار النشر
    }
  };

  const continueToVideoCaption = (range: VideoTrimRange, crop: VideoCropTransform) => {
    setVideoTrim(range);
    setVideoCrop(crop);
    setShowVideoPreviewModal(false);
    setShowCreateModal(true);
  };

  const handlePublish = (postMetadata: PostMetadataTag[] = [], postDestination: PostDestination = destination, filesOverride?: File[], fileTypeOverride?: 'image' | 'video' | null) => {
    if (!supabaseConfigured) {
      setCreateError('إعدادات الاتصال بقاعدة البيانات غير مكتملة في Secrets.');
      return;
    }

    const content = postText.trim();
    // الوسائط قد تأتي مباشرة من الشاشة الموحدة (الصور المقصوصة) أو من حالة النافذة
    const files = filesOverride ?? [...selectedFiles];
    const mediaType = fileTypeOverride !== undefined ? fileTypeOverride : fileType;
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
    // الصوت المختار من مكتبة الأصوات مع ترميز HTML5 (#t=start,end) لزمني الاقتصاص
    // — فيبدأ التشغيل عند البداية وينتهي عند النهاية مباشرة في المشغلات
    const borrowedAudioUrl = pendingSound?.sourceVideoUrl
      ? (pendingSound.soundTrim && pendingSound.soundTrim.end > pendingSound.soundTrim.start
        ? appendVideoTrimFragment(pendingSound.sourceVideoUrl, pendingSound.soundTrim)
        : pendingSound.sourceVideoUrl)
      : null;
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
      audio_url: borrowedAudioUrl ?? null,
      audio_title: pendingSound?.title ?? null,
      sound_id: pendingSound?.id ?? null,
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

        // نظام الأصوات: كل فيديو جديد يُنشئ صوته الأصلي تلقائياً ليتمكن الآخرون من «استخدام هذا الصوت»
        // (source_video_url يشير للفيديو المرفوع نفسه — بلا Storage إضافية؛ فشلها لا يعطل النشر)
        let attachedSoundId: string | null = null;
        if (mediaType === 'video' && !pendingSound && uploadedUrls[0]) {
          try {
            const { data: soundRow } = await supabase
              .from('sounds')
              .insert({
                title: `الصوت الأصلي - ${displayName(profile) || 'المستخدم'}`,
                source_video_url: uploadedUrls[0].replace(/#.*$/, ''),
                creator_id: authenticatedUserId,
              })
              .select('id')
              .single();
            attachedSoundId = soundRow?.id ?? null;
          } catch {
            attachedSoundId = null;
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

        // حدود القص المخزنة كأعمدة صريحة (trim_start/trim_end) بجانب ترميز #t=
        // في العنوان — يضمن التزامن حتى لو فُقد الرمز من عنوان الوسائط
        const trimColumns = mediaType === 'video' && trim && trim.end > trim.start
          ? {
              trim_start: Number(trim.start.toFixed(3)),
              trim_end: Number(trim.end.toFixed(3)),
            }
          : {};
        // معرّف الصوت المرتبط بالمنشور: صوت مختار من مكتبة الأصوات
        // أو صوت الفيديو الأصلي المُنشأ تلقائياً عند النشر
        const effectiveSoundId = pendingSound?.id ?? attachedSoundId;
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
          // نظام الأصوات: الصوت المختار من مكتبة الأصوات أو الصوت الأصلي للفيديو
          // (sound_id + audio_url بترميز #t= لزمني الاقتصاص + audio_title)
          ...(effectiveSoundId ? { sound_id: effectiveSoundId } : {}),
          ...(borrowedAudioUrl
            ? { audio_url: borrowedAudioUrl, audio_title: pendingSound?.title ?? null }
            : {}),
          // أوقات اقتصاص الصوت (بالثواني): يقرأها المشغل فيشغّل نفس الجزء للجميع
          ...(pendingSound?.soundTrim && pendingSound.soundTrim.end > pendingSound.soundTrim.start
            ? {
                sound_trim_start: Number(pendingSound.soundTrim.start.toFixed(3)),
                sound_trim_end: Number(pendingSound.soundTrim.end.toFixed(3)),
              }
            : {}),
          ...trimColumns,
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

        // قاعدة بيانات لم يُطبَّق عليها عمودا الصوت بعد → أعد المحاولة بدونهما حتى لا يتعطل النشر
        if (
          postError
          && borrowedAudioUrl
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('audio_url')
        ) {
          const payloadWithoutAudio = { ...postPayload } as Record<string, unknown>;
          delete payloadWithoutAudio.audio_url;
          delete payloadWithoutAudio.audio_title;
          postError = (await supabase.from('posts').upsert(payloadWithoutAudio, { onConflict: 'id' })).error;
        }

        // قاعدة بيانات لم يُطبَّق عليها جدول الأصوات/عمود sound_id بعد → أعد المحاولة بدونه
        if (
          postError
          && effectiveSoundId
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('sound_id')
        ) {
          const payloadWithoutSound = { ...postPayload } as Record<string, unknown>;
          delete payloadWithoutSound.sound_id;
          postError = (await supabase.from('posts').upsert(payloadWithoutSound, { onConflict: 'id' })).error;
        }

        // قاعدة بيانات لم يُطبَّق عليها عمودا اقتصاص الصوت بعد → أعد المحاولة بدونهما
        if (
          postError
          && pendingSound?.soundTrim
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('sound_trim')
        ) {
          const payloadWithoutSoundTrim = { ...postPayload } as Record<string, unknown>;
          delete payloadWithoutSoundTrim.sound_trim_start;
          delete payloadWithoutSoundTrim.sound_trim_end;
          postError = (await supabase.from('posts').upsert(payloadWithoutSoundTrim, { onConflict: 'id' })).error;
        }

        // قاعدة بيانات لم يُطبَّق عليها عمودا القص بعد → أعد المحاولة بدونهما
        // (القص يبقى محفوظاً داخل ترميز #t= في عنوان الوسائط)
        if (
          postError
          && 'trim_start' in postPayload
          && (postError.code === '42703' || postError.code === 'PGRST204')
          && postError.message.includes('trim_start')
        ) {
          const payloadWithoutTrim = { ...postPayload } as Record<string, unknown>;
          delete payloadWithoutTrim.trim_start;
          delete payloadWithoutTrim.trim_end;
          postError = (await supabase.from('posts').upsert(payloadWithoutTrim, { onConflict: 'id' })).error;
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

        updatePendingPost(postId, {
          stage: 'success',
          progress: 100,
          error: null,
          retry: null,
          post: { ...publishedPost, sound_id: effectiveSoundId ?? publishedPost.sound_id ?? null },
        });
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
    stopInstant();
    setPendingSound(null);
    setAutoSoundMedia(false);
    setImagePostTags([]);
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
          showNearbyButton={path === '/' || path === '/feed'}
          onOpenNearby={() => setShowNearbyUsers(true)}
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
        caption={postText}
        onCaptionChange={setPostText}
        imageTags={imagePostTags}
        onImageTagsChange={setImagePostTags}
        imageDestination={destination}
        onImageDestinationChange={setDestination}
        onImagePublish={handleImagePublishDirect}
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
        music={pendingSound}
        // زر الإلغاء (X): يوقف المشغّل الموحّد فوراً ويفرغ الصوت المختار
        onClearMusic={() => { stopInstant(); setPendingSound(null); }}
        autoSoundMedia={autoSoundMedia}
        onReplaceAutoMedia={replaceAutoSoundMedia}
        onClearAutoMedia={clearAutoSoundMedia}
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
          setAutoSoundMedia(false);
          stopInstant();
          setPendingSound(null);
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
      {showNearbyUsers && (
        <NearbyUsersSheet
          open={showNearbyUsers}
          onClose={() => setShowNearbyUsers(false)}
          currentUserId={userId}
          currentCity={profile?.city ?? null}
          currentProfile={profile}
          onProfileUpdate={onProfileUpdate}
        />
      )}
      <SoundDetailSheet />
      <SoundPickerSheet />

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
            messagesUnreadCount={messagesUnreadCount}
            onNavigationTap={handleHomeNavigationTap}
          />
        )}
      </div>
    </div>
  );
}
