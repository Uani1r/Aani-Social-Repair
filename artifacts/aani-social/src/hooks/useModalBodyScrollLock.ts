import { useLayoutEffect } from 'react';

const OPEN_DIALOG_SELECTOR = '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])';

export function useModalBodyScrollLock() {
  useLayoutEffect(() => {
    const body = document.body;
    let locked = false;
    let scrollTop = 0;
    let previousBodyOverflow = '';
    let previousBodyOverscroll = '';
    let unlockFrame: number | null = null;
    let restoreFrame: number | null = null;

    const restorePageScroll = () => {
      if (window.scrollY !== scrollTop) {
        window.scrollTo({ left: window.scrollX, top: scrollTop, behavior: 'auto' });
      }
    };

    const cancelRestoreFrame = () => {
      if (restoreFrame === null) return;
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    };

    const scheduleScrollRestore = (expectedLockedState: boolean) => {
      cancelRestoreFrame();
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = null;
        if (locked === expectedLockedState) restorePageScroll();
      });
    };

    const unlock = (scheduleRestore = true) => {
      if (!locked) return;
      locked = false;
      // 'unset' بدلاً من '' لضمان إعادة تفعيل التمرير دائماً
      body.style.overflow = previousBodyOverflow || 'unset';
      body.style.overscrollBehavior = previousBodyOverscroll;
      restorePageScroll();
      if (scheduleRestore) scheduleScrollRestore(false);
    };

    const syncScrollLock = () => {
      const hasOpenDialog = Boolean(document.querySelector(OPEN_DIALOG_SELECTOR));
      if (!hasOpenDialog) {
        if (locked && unlockFrame === null) {
          unlockFrame = window.requestAnimationFrame(() => {
            unlockFrame = null;
            if (!document.querySelector(OPEN_DIALOG_SELECTOR)) unlock();
          });
        }
        return;
      }

      if (unlockFrame !== null) {
        window.cancelAnimationFrame(unlockFrame);
        unlockFrame = null;
      }
      cancelRestoreFrame();
      if (locked) {
        restorePageScroll();
        return;
      }

      locked = true;
      scrollTop = Math.max(0, window.scrollY);
      previousBodyOverflow = body.style.overflow;
      previousBodyOverscroll = body.style.overscrollBehavior;
      body.style.overflow = 'hidden';
      body.style.overscrollBehavior = 'none';
      restorePageScroll();
      scheduleScrollRestore(true);
    };

    const observer = new MutationObserver(syncScrollLock);
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-modal', 'data-state', 'role'],
    });
    syncScrollLock();

    return () => {
      observer.disconnect();
      if (unlockFrame !== null) window.cancelAnimationFrame(unlockFrame);
      unlockFrame = null;
      cancelRestoreFrame();
      unlock(false);
      // شبكة أمان إلزامية عند الإغلاق/العودة للبروفايل: حتى لو تعطل
      // مسار المراقب (MutationObserver) يجب ألا يبقى body مقفلاً أبداً،
      // وإلا يتجمد تمرير الصفحة بعد مغادرة عارض المنشورات أو مشغل الريلز.
      const remainingOpenDialog = Boolean(document.querySelector(OPEN_DIALOG_SELECTOR));
      if (!remainingOpenDialog && body.style.overflow === 'hidden') {
        document.body.style.overflow = 'unset';
        document.body.style.overscrollBehavior = '';
        restorePageScroll();
      }
    };
  }, []);
}
