import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { useLocation } from 'wouter';

import ShellBottomNav from './ShellBottomNav';
import ShellOverlayControls from './ShellOverlayControls';
import ShellTopBar from './ShellTopBar';
import { isHorizontalGestureArea } from '@/lib/appShared';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import type { PostMetadataTag } from '@/lib/types';
import type { ShellProps } from './types';

export default function Shell({
  children,
  profile,
  userId,
  onSignOut,
  onOpenComments,
  NotificationsModalComponent,
}: ShellProps) {
  const [path, setLocation] = useLocation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPublishOptionsSheet, setShowPublishOptionsSheet] = useState(false);
  const [pendingStoryComposerRequest, setPendingStoryComposerRequest] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showNotifsModal, setShowNotifsModal] = useState(false);
  const [showAssistantModal, setShowAssistantModal] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const handleSignOut = () => {
    // Root is valid in both session states: feed before logout, login after it.
    setLocation('/');
    onSignOut();
  };

  const homeTapAtRef = useRef(0);
  const homeTapResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
  }, []);

  useEffect(() => {
    if (!pendingStoryComposerRequest || (path !== '/' && path !== '/feed')) return;

    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('aani:open-story-composer'));
      setPendingStoryComposerRequest(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [path, pendingStoryComposerRequest]);

  const handleHomeNavigationTap = (event: MouseEvent<HTMLAnchorElement>, navId: string) => {
    if (navId !== 'feed') {
      homeTapAtRef.current = 0;
      if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
      homeTapResetTimerRef.current = null;
      return;
    }

    const now = Date.now();
    if (homeTapAtRef.current > 0 && now - homeTapAtRef.current <= 450) {
      event.preventDefault();
      homeTapAtRef.current = 0;
      if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
      homeTapResetTimerRef.current = null;
      setLocation('/feed');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.setTimeout(() => window.dispatchEvent(new Event('aani:feed-refresh')), 0);
      return;
    }

    homeTapAtRef.current = now;
    if (homeTapResetTimerRef.current) window.clearTimeout(homeTapResetTimerRef.current);
    homeTapResetTimerRef.current = window.setTimeout(() => {
      homeTapAtRef.current = 0;
      homeTapResetTimerRef.current = null;
    }, 450);

    if (path === '/feed') event.preventDefault();
  };

  // إخفاء/إظهار الشريطين: يعتمد على اتجاه حركة الإصبع مباشرة
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeHiddenRef = useRef(false);
  const prevChromeHiddenRef = useRef(false);
  const storyRevealTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const setHidden = (hidden: boolean) => {
      if (chromeHiddenRef.current === hidden) return;
      chromeHiddenRef.current = hidden;
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

      if (document.body.classList.contains('aani-immersive')) return;
      if (touching && now - lastTouchMoveAt < 120) return;

      const y = Math.max(
        0,
        window.scrollY || 0,
        document.documentElement.scrollTop || 0,
        document.body.scrollTop || 0,
      );
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
      if (document.body.classList.contains('aani-immersive')) return;
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
    };
  }, []);

  // تمرير حالة الإخفاء إلى شريط القصص عبر كلاس على الصفحة (بدون تغيير منطقها)
  useEffect(() => {
    const wasHidden = prevChromeHiddenRef.current;
    prevChromeHiddenRef.current = chromeHidden;

    document.body.classList.toggle('aani-chrome-hidden', chromeHidden);

    // سلسلة الظهور: الشريط العلوي أولًا، ثم ينبثق شريط القصص من خلفه إلى مكانه
    if (wasHidden && !chromeHidden) {
      document.body.classList.remove('aani-chrome-revealed');
      // إعادة تشغيل الأنيميشن من البداية
      void document.body.offsetWidth;
      document.body.classList.add('aani-chrome-revealed');

      if (storyRevealTimerRef.current) window.clearTimeout(storyRevealTimerRef.current);
      storyRevealTimerRef.current = window.setTimeout(() => {
        document.body.classList.remove('aani-chrome-revealed');
      }, 1000);
    }

    return () => {
      document.body.classList.remove('aani-chrome-hidden');
    };
  }, [chromeHidden]);

  // السحب الأفقي للتنقل بين الصفحات الرئيسية (حركة بصرية فقط)
  const [swipeDirection, setSwipeDirection] = useState<'forward' | 'backward' | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y'; dx: number; pullCandidate: boolean } | null>(null);
  const swipeTimerRef = useRef<number | null>(null);

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
    // التنقل بالسحب مخصص لتبويبات الشريط السفلي فقط، ولا يعمل داخل شاشات القصص
    if (document.body.classList.contains('aani-immersive')) {
      swipeStartRef.current = null;
      return;
    }

    const target = event.target as HTMLElement | null;

    // لا نلتقط السحب داخل العناصر التي تملك إيماءة أفقية أو حقول الإدخال
    if (isHorizontalGestureArea(target)) {
      swipeStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;

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
      pullCandidate,
    };
  };

  const handleSwipeMove = (event: ReactTouchEvent) => {
    const start = swipeStartRef.current;
    if (!start || start.axis === 'y') return;

    const touch = event.touches[0];
    if (!touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

    if (start.pullCandidate && dy >= 24 && dy >= Math.abs(dx) * 0.55) {
      start.axis = 'y';
      start.dx = 0;
      setMainOffset(0, false);
      return;
    }

    // تحديد نوع الحركة عند أول 6 بكسل، مع إمكانية التصحيح إذا تغيّر الاتجاه
    if (start.axis === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    } else if (start.axis === 'y' && Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 14) {
      start.axis = 'x';
    }

    if (start.axis !== 'x') return;

    start.dx = dx;

    // مقاومة عند حدود البداية والنهاية (السحب من اليسار لليمين = للأمام)
    const index = getRouteIndex(path);
    const atForwardLimit = index >= swipeRoutes.length - 1 && dx > 0;
    const atBackwardLimit = index <= 0 && dx < 0;

    setMainOffset(atForwardLimit || atBackwardLimit ? dx * 0.25 : dx, false);
  };

  const handleSwipeEnd = () => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    const width = window.innerWidth || 360;
    const threshold = Math.max(56, width * 0.18);

    const horizontalSwipe = Boolean(start && start.axis === 'x');
    const shouldNavigate = Boolean(start && start.axis === 'x' && Math.abs(start.dx) >= threshold);
    let navigated = false;

    if (shouldNavigate && start) {
      const index = getRouteIndex(path);

      if (index >= 0) {
        // السحب من اليسار إلى اليمين (dx > 0) يقدّم للأمام، ومن اليمين لليسار يرجع
        const goingForward = start.dx > 0;
        const nextIndex = goingForward ? index + 1 : index - 1;

        if (nextIndex >= 0 && nextIndex < swipeRoutes.length) {
          navigated = true;
          setSwipeDirection(goingForward ? 'forward' : 'backward');
          setLocation(swipeRoutes[nextIndex]);

          // بداية الصفحة الجديدة من الأعلى لتبدو الحركة انتقالًا حقيقيًا
          window.scrollTo({ top: 0, behavior: 'auto' });

          if (swipeTimerRef.current) window.clearTimeout(swipeTimerRef.current);
          swipeTimerRef.current = window.setTimeout(() => setSwipeDirection(null), 420);
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
  const [fileType, setFileType] = useState<'image' | 'video' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

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
    if (!supabaseConfigured || !userId) return;
    void supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', userId).eq('is_read', false).then(({ count }) => {
      setUnreadCount(count || 0);
    });
  }, [userId, showNotifsModal]);

  const handlePublish = async (postMetadata: PostMetadataTag[] = []) => {
    if (!supabaseConfigured) {
      setCreateError('إعدادات الاتصال بقاعدة البيانات غير مكتملة في Secrets.');
      return;
    }

    const content = postText.trim();
    if (!content && selectedFiles.length === 0 && postMetadata.length === 0) return;
    if (Array.from(content).length > 2000) {
      setCreateError('نص المنشور يتجاوز الحد الأقصى البالغ 2000 حرف. اختصر النص قبل النشر.');
      return;
    }

    setIsSubmitting(true);
    setCreateError('');
    try {
      const uploadedUrls: string[] = [];
      let type: 'text' | 'photo' | 'reel' = 'text';

      if (selectedFiles.length > 0 && fileType) {
        for (const file of selectedFiles) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
          const uploadedPath = `${userId}/${Date.now()}-${safeName}`;

          const { error: uploadError } = await supabase.storage
            .from(storageBucket)
            .upload(uploadedPath, file, { upsert: true, contentType: file.type });

          if (uploadError) throw new Error(`فشل رفع الملف: ${uploadError.message}`);

          const publicData = supabase.storage.from(storageBucket).getPublicUrl(uploadedPath);
          const publicUrl = publicData?.data?.publicUrl;
          if (publicUrl) uploadedUrls.push(publicUrl);
        }
        type = fileType === 'image' ? 'photo' : 'reel';
      }

      const { error: postError } = await supabase.from('posts').insert({
        user_id: userId,
        content,
        post_metadata: postMetadata,
        media_url: uploadedUrls[0] || null,
        media_urls: uploadedUrls.length > 0 ? uploadedUrls : null,
        type,
      });

      if (postError) {
        if ((postError.code === '42703' || postError.code === 'PGRST204') && postError.message.includes('post_metadata')) {
          throw new Error('يجب تطبيق الترحيل 20261122000000_post_metadata_chips.sql على قاعدة Supabase قبل نشر الوسوم.');
        }
        if (postError.code === '23514' && postError.message.includes('posts_content_length_check')) {
          throw new Error('قاعدة البيانات تستخدم قيدًا قديمًا للمنشورات. طبّق الترحيل 20261122000000_post_metadata_chips.sql على Supabase ثم أعد المحاولة.');
        }
        throw new Error(`فشل حفظ المنشور: ${postError.message}`);
      }

      setPostText('');
      setSelectedFiles([]);
      setFileType(null);
      setShowCreateModal(false);
      window.dispatchEvent(new Event('aani:post-created'));

      if (type === 'reel') {
        setLocation('/reels');
      } else {
        setLocation('/feed');
      }
    } catch (err: any) {
      setCreateError(err.message || 'حدث خطأ غير متوقع أثناء النشر.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="app-frame min-h-screen bg-black text-white">
      <ShellTopBar
        path={path}
        chromeHidden={chromeHidden}
        unreadCount={unreadCount}
        onOpenNotifications={() => setShowNotifsModal(true)}
        onOpenSettings={() => setShowSettingsModal(true)}
        onOpenCreatePost={() => setShowPublishOptionsSheet(true)}
      />

      <ShellOverlayControls
        showPublishOptionsSheet={showPublishOptionsSheet}
        onClosePublishOptionsSheet={() => setShowPublishOptionsSheet(false)}
        onCreateTextPost={() => setShowCreateModal(true)}
        onSelectPublishImages={files => {
          setSelectedFiles(files);
          setFileType('image');
          setCreateError('');
          setShowCreateModal(true);
        }}
        onSelectPublishVideo={file => {
          setSelectedFiles([file]);
          setFileType('video');
          setCreateError('');
          setShowCreateModal(true);
        }}
        onOpenMorePublishOptions={() => {
          setPendingStoryComposerRequest(true);
          if (path !== '/' && path !== '/feed') setLocation('/feed');
        }}
        showCreateModal={showCreateModal}
        postText={postText}
        selectedFiles={selectedFiles}
        fileType={fileType}
        filePreviews={filePreviews}
        isSubmitting={isSubmitting}
        createError={createError}
        onPostTextChange={setPostText}
        onRemoveFile={index => setSelectedFiles(files => files.filter((_, idx) => idx !== index))}
        onPublish={tagContent => void handlePublish(tagContent)}
        onCloseCreatePost={() => setShowCreateModal(false)}
        showSettingsModal={showSettingsModal}
        onCloseSettings={() => setShowSettingsModal(false)}
        profile={profile}
        onSignOut={handleSignOut}
        showNotifsModal={showNotifsModal}
        onCloseNotifications={() => setShowNotifsModal(false)}
        NotificationsModalComponent={NotificationsModalComponent}
        userId={userId}
        showAssistantModal={showAssistantModal}
        onOpenAssistant={() => setShowAssistantModal(true)}
        onCloseAssistant={() => setShowAssistantModal(false)}
      />

      <div className="content-shell" style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
        <main
          ref={mainRef}
          className={`main-content ${
            swipeDirection === 'forward'
              ? 'page-slide-forward'
              : swipeDirection === 'backward'
                ? 'page-slide-backward'
                : ''
          }`}
          style={{ touchAction: 'pan-y' }}
          onTouchStart={handleSwipeStart}
          onTouchMove={handleSwipeMove}
          onTouchEnd={handleSwipeEnd}
          onTouchCancel={handleSwipeEnd}
        >
          {children}
        </main>
        <ShellBottomNav
          path={path}
          chromeHidden={chromeHidden}
          onNavigationTap={handleHomeNavigationTap}
        />
      </div>
    </div>
  );
}
