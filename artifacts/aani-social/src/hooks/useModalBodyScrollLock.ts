import { useLayoutEffect } from 'react';

const OPEN_DIALOG_SELECTOR = '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])';

export function useModalBodyScrollLock() {
  useLayoutEffect(() => {
    const body = document.body;
    const documentElement = document.documentElement;
    let locked = false;
    let scrollTop = 0;
    let previousBodyOverflow = '';
    let previousDocumentOverflow = '';
    let previousBodyOverscroll = '';
    let previousDocumentOverscroll = '';
    let unlockFrame: number | null = null;

    const unlock = () => {
      if (!locked) return;
      locked = false;
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      body.style.overscrollBehavior = previousBodyOverscroll;
      documentElement.style.overscrollBehavior = previousDocumentOverscroll;
      if (window.scrollY !== scrollTop) window.scrollTo({ top: scrollTop, behavior: 'auto' });
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
      if (locked) return;

      locked = true;
      scrollTop = Math.max(window.scrollY, documentElement.scrollTop, body.scrollTop);
      previousBodyOverflow = body.style.overflow;
      previousDocumentOverflow = documentElement.style.overflow;
      previousBodyOverscroll = body.style.overscrollBehavior;
      previousDocumentOverscroll = documentElement.style.overscrollBehavior;
      body.style.overflow = 'hidden';
      documentElement.style.overflow = 'hidden';
      body.style.overscrollBehavior = 'none';
      documentElement.style.overscrollBehavior = 'none';
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
      unlock();
    };
  }, []);
}
