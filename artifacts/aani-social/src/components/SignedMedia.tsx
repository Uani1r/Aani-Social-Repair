import type { ImgHTMLAttributes, VideoHTMLAttributes } from 'react';

import { useMediaUrl } from '@/lib/mediaAccess';

/**
 * صورة/فيديو من وسائط قد تكون محمية (bucket خاص أو ImageKit موقّع).
 * تُعرض القيمة الأصلية فوراً ثم تُستبدل بالرابط الموقّع عند وصوله، فلا وميض
 * ولا انكسار قبل الترحيل. تُستخدم داخل الخرائط (map) حيث لا يصح استدعاء
 * الخطافات مباشرة.
 */
export function SignedImage({ src, ...rest }: { src: string | null | undefined } & ImgHTMLAttributes<HTMLImageElement>) {
  const resolved = useMediaUrl(src);
  if (!resolved) return null;
  return <img {...rest} src={resolved} alt={rest.alt ?? ''} />;
}

export function SignedVideo({ src, ...rest }: { src: string | null | undefined } & VideoHTMLAttributes<HTMLVideoElement>) {
  const resolved = useMediaUrl(src);
  if (!resolved) return null;
  return <video {...rest} src={resolved} />;
}
