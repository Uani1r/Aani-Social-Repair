import { useEffect } from 'react';

import {
  clearRouteScrollMemory,
  hasVisitedRoute,
  markRouteVisited,
  readRouteScrollPosition,
  saveRouteScrollPosition,
} from '@/lib/routeScrollMemory';

/**
 * ذاكرة موضع التمرير عبر التنقل بين مسارات التطبيق:
 * - أول زيارة لمسار: يبدأ من الأعلى (السلوك الطبيعي).
 * - العودة لمسار سبق زيارته: يستعيد موضع التمرير المحفوظ لحظة مغادرته.
 */
export function useRouteScrollMemory(path: string) {
  useEffect(() => {
    const returning = hasVisitedRoute(path);
    markRouteVisited(path);

    if (returning) {
      const saved = readRouteScrollPosition(path);
      window.requestAnimationFrame(() => {
        if (saved > 0) window.scrollTo({ left: 0, top: saved, behavior: 'auto' });
      });
    } else {
      window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }

    // الحفظ مستمر مع كل تمرير (حتى لا يُحفظ صفر بعد إعادة الضبط أثناء التنقل)
    const saveCurrent = () => saveRouteScrollPosition(path, window.scrollY);
    window.addEventListener('scroll', saveCurrent, { passive: true });
    return () => {
      window.removeEventListener('scroll', saveCurrent);
    };
  }, [path]);
}
