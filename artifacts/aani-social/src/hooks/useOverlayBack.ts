import { useEffect, useRef } from 'react';

import { registerOverlayBack } from '@/lib/overlayBack';

/**
 * اربط نافذة/عارضاً بزناد الرجوع (زر الهاتف/المتصفح):
 * عند التفعيل يُسجل معالج الإغلاق في رصة الرجوع المركزية،
 * وزر الرجوع يغلق هذه النافذة بدل مغادرة الصفحة.
 */
export function useOverlayBack(active: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return undefined;
    return registerOverlayBack(() => onCloseRef.current());
  }, [active]);
}
