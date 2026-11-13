import { useLayoutEffect } from 'react';

const OPEN_DIALOG_SELECTOR = '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])';

type SavedBodyScrollState = {
  scrollTop: number;
  overflow: string;
  overscrollBehavior: string;
};

/**
 * حالة القفل مشتركة على مستوى الوحدة (وليس لكل نسخة من الـ hook):
 * التطبيق يحتفظ بنسخة دائمة (App) والمشغلات تحتفظ بنسخ أخرى، وكانت
 * كل نسخة تحفظ قيمة overflow السابقة بنفسها — فتعارض القفل المزدوج
 * كان يعيد 'hidden' بعد الإغلاق ويتجمد التمرير. هنا يُحسب القفل
 * بعدّاد مشترك، ولا تُستعاد القيم الأصلية إلا بعد تحرّر كل المالكين.
 */
let lockOwners = 0;
let savedBodyState: SavedBodyScrollState | null = null;
let refreshFrame: number | null = null;

function hasOpenDialog(): boolean {
  return Boolean(document.querySelector(OPEN_DIALOG_SELECTOR));
}

function refreshBodyScrollLock() {
  const body = document.body;
  const shouldLock = lockOwners > 0 && hasOpenDialog();

  if (shouldLock && savedBodyState === null) {
    savedBodyState = {
      scrollTop: Math.max(0, window.scrollY),
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
    };
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    return;
  }

  if (!shouldLock && savedBodyState !== null) {
    const { scrollTop, overflow, overscrollBehavior } = savedBodyState;
    savedBodyState = null;
    body.style.overflow = overflow || 'unset';
    body.style.overscrollBehavior = overscrollBehavior;
    if (window.scrollY !== scrollTop) {
      window.scrollTo({ left: window.scrollX, top: scrollTop, behavior: 'auto' });
    }
  }
}

function scheduleRefresh() {
  // متزامن مع دورة النافذة: MutationObserver يُستدعى بعد اكتمال تغييرات DOM
  // مباشرة، فلا حاجة لتأجيله إلى requestAnimationFrame (كان يترك نافذة زمنية
  // تبقى فيها الصفحة مقفلة بعد إغلاق النافذة على iOS Safari).
  refreshBodyScrollLock();
}

export function useModalBodyScrollLock() {
  useLayoutEffect(() => {
    lockOwners += 1;
    refreshBodyScrollLock();

    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-modal', 'data-state', 'role'],
    });

    return () => {
      observer.disconnect();
      if (refreshFrame !== null) {
        window.cancelAnimationFrame(refreshFrame);
        refreshFrame = null;
      }
      lockOwners = Math.max(0, lockOwners - 1);
      refreshBodyScrollLock();

      // شبكة أمان عند مغادرة آخر مكوّن: لا نلمس body إلا إذا كنّا نحن من قفلناه
      // فعلاً (سجّلنا الحالة الأصلية). مجرد رؤية overflow === 'hidden' ليست دليلاً
      // على الملكية — قد يكون قفلاً لنظام/مكوّن آخر ويجب ألا نغيّر قيمته الأصلية.
      // والنوافذ المتداخلة تبقى مقفلة ما دامت هناك نافذة مفتوحة أو مالك آخر.
      if (lockOwners === 0 && !hasOpenDialog() && savedBodyState !== null) {
        const body = document.body;
        const { scrollTop, overflow, overscrollBehavior } = savedBodyState;
        savedBodyState = null;
        // استعادة القيمة الأصلية مرة واحدة فقط (حتى لو كانت hidden أصلاً)
        body.style.overflow = overflow;
        body.style.overscrollBehavior = overscrollBehavior;
        if (scrollTop !== null && window.scrollY !== scrollTop) {
          window.scrollTo({ left: window.scrollX, top: scrollTop, behavior: 'auto' });
        }
      }
    };
  }, []);
}
