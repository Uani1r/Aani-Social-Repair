import { useEffect, useRef } from 'react';

import { registerOverlayBack, type OverlayBackOptions } from '@/lib/overlayBack';

/**
 * اربط نافذة/عارضاً بزناد الرجوع (زر الهاتف/المتصفح):
 * عند التفعيل يُسجل معالج الإغلاق في رصة الرجوع المركزية،
 * وزر الرجوع يغلق هذه النافذة بدل مغادرة الصفحة.
 */
export function useOverlayBack(active: boolean, onClose: () => void, options?: OverlayBackOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return undefined;
    return registerOverlayBack(() => onCloseRef.current(), optionsRef.current);
  }, [active]);
}
