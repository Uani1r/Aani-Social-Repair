import type { ImgHTMLAttributes, VideoHTMLAttributes } from 'react';

import { useMediaUrl } from '@/lib/mediaAccess';

/**
 * بكسل شفاف مضمّن: يُعرض بدل الوسيط حين يتعذّر التوقيع، فلا يبقى إطار مكسور
 * ولا يُطلب الملف من ImageKit بلا توقيع، ولا يتغيّر حجم العنصر.
 */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

type SignedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined;
};

type SignedVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src' | 'poster'> & {
  src: string | null | undefined;
  poster?: string | null;
};

/**
 * صورة/فيديو من وسائط قد تكون محمية (bucket خاص أو ImageKit موقّع).
 * عند تفعيل VITE_IMAGEKIT_SIGNED_URLS لا يُعرض شيء قبل وصول الرابط الموقّع،
 * ولا يُعرض شيء إن فشل التوقيع — الفشل المتوقع للمحتوى غير المسموح لا يُكشف.
 * تُستخدم داخل الخرائط (map) حيث لا يصح استدعاء الخطافات مباشرة.
 */
export function SignedImage({ src, ...rest }: SignedImageProps) {
  const resolved = useMediaUrl(src);
  return (
    <img
      {...rest}
      src={resolved ?? TRANSPARENT_PIXEL}
      alt={rest.alt ?? ''}
      aria-busy={resolved ? undefined : true}
      data-aani-media-pending={resolved ? undefined : ''}
    />
  );
}

export function SignedVideo({ src, poster, ...rest }: SignedVideoProps) {
  const resolved = useMediaUrl(src);
  const resolvedPoster = useMediaUrl(poster);
  // بلا توقيع صالح لا يُعرض عنصر فيديو فارغ يشوّش المشغّل.
  if (!resolved) return null;
  return <video {...rest} src={resolved} poster={resolvedPoster ?? undefined} />;
}
