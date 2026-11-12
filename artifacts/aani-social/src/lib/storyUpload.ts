// رفع الوسائط مباشرة إلى ImageKit.io مع ضغط وعزل صوت من جهة العميل.
//
// - الصور: ضغط دائم عبر mediaCompressor (avatar/cover/feedImage) — WebP مع
//   تحويل تلقائي إلى JPEG على iOS Safari + تصحيح EXIF.
// - الفيديو: ضغط H.264+AAC داخل MP4 بحد أقصى 720p عبر mediabunny، مع مسار
//   احتياطي آمن (متصفح قديم + ملف ≤24MB → يُرفع كما هو).
// - الصوت: voiceMessage يحوَّل إلى .m4a بتردد 44.1kHz متوافق مع iOS وAndroid.
// التوقيع الآمن (token/expire/signature) يأتي من الخادم الخلفي:
// GET /api/media/imagekit-auth (يستخدم IMAGEKIT_PRIVATE_KEY ولا يكشفه).
// الرابط العام الناتج يُسجَّل في supabase.ts فيُرجعه getPublicUrl.

import { supabase, registerUploadedMediaUrl } from '@/lib/supabase';
import { safeExecute } from '@/lib/appErrors';
import { recordUploadLedgerReliably } from '@/lib/uploadLedgerQueue';
import {
  compressImage,
  compressVideo,
  extractAudio,
  isImagePreset,
  MAX_UPLOAD_BYTES,
  MediaTooLargeError,
  UNCOMPRESSIBLE_IMAGE_MAX_BYTES,
  type MediaPreset,
} from '@/utils/mediaCompressor';

export type UploadPhase = 'compressing' | 'extracting-audio' | 'uploading';

interface UploadOptions {
  file: File;
  path: string;
  /** نسبة الرفع نفسه (كما كانت) */
  onProgress?: (percent: number) => void;
  /** المرحلة الحالية: تحسين الجودة / عزل الصوت / الرفع */
  onPhase?: (phase: UploadPhase, percent?: number) => void;
  /** إعداد الضغط — عند غيابه يُستنتج من نوع الملف */
  preset?: MediaPreset;
  /** إلغاء الضغط والرفع الجاري */
  signal?: AbortSignal;
  /** توافق قديم فقط — الضغط يعمل دائماً الآن بغض النظر عن هذه القيمة */
  quality?: 'hd' | 'data-saving';
}

type ImageKitAuthParams = {
  urlEndpoint: string;
  publicKey: string;
  token: string;
  expire: number;
  signature: string;
};

async function fetchImageKitAuth(signal?: AbortSignal): Promise<ImageKitAuthParams> {
  // بلا كاش نهائياً: توكن ImageKit يُقبل مرة واحدة فقط — كل محاولة رفع
  // (أول مرة، إعادة محاولة، عدة ملفات، أو فيديو ثم صوته) تحصل على توقيع
  // طازج من الخادم. إعادة استخدام التوكن كانت تجعل ImageKit يرفض الرفع
  // برسالة "token has been used before" (HTTP 400).
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('يجب تسجيل الدخول قبل رفع الوسائط.');

  const response = await fetch('/api/media/imagekit-auth', {
    headers: { authorization: `Bearer ${accessToken}` },
    // ترويسات تمنع أي تخزين مؤقت على مستوى الشبكة أيضاً
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null) as
    | (ImageKitAuthParams & { success?: unknown; error?: unknown })
    | null;
  if (!response.ok || !result || result.success !== true) {
    throw new Error(typeof result?.error === 'string' ? result.error : 'تعذر تجهيز توقيع رفع الوسائط.');
  }

  return {
    urlEndpoint: result.urlEndpoint,
    publicKey: result.publicKey,
    token: result.token,
    expire: result.expire,
    signature: result.signature,
  };
}

function detectPreset(file: File): MediaPreset | null {
  if (file.type.startsWith('video/')) return 'video';
  // GIF وSVG تُرفع كما هي (شفافية/حركة) — والحماية العليا عبر MAX_UPLOAD_BYTES
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return null;
  if (file.type.startsWith('image/')) return 'feedImage';
  return null;
}

/** امتداد صحيح حسب نوع المحتوى — ImageKit يرفض أسماء بلا امتداد */
function ensureUploadName(file: File, fallbackBase: string): string {
  if (file.name && /\.[a-zA-Z0-9]+$/.test(file.name)) return file.name;
  const extensionByType: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/png': '.png',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/mp4': '.m4a',
    'audio/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
  };
  const extension = extensionByType[file.type] ?? '.bin';
  return `${fallbackBase || 'media'}${extension}`;
}

async function uploadMediaUnsafe({
  file,
  path,
  onProgress,
  onPhase,
  preset,
  signal,
}: UploadOptions): Promise<string> {
  if (signal?.aborted) throw new DOMException('أُلغيت العملية.', 'AbortError');

  // 1) الضغط/العزل من جهة العميل — يعمل دائماً افتراضياً
  onPhase?.('compressing', 0);
  const effectivePreset = preset ?? detectPreset(file);
  let uploadFile = file;

  // GIF وSVG تُستثنى من ضغط Canvas (شفافية/حركة) — بسقف صارم 2MB حتى لا
  // يُستثمر هذا الاستثناء في رفع ملفات ضخمة غير مضغوطة:
  if ((file.type === 'image/gif' || file.type === 'image/svg+xml')
    && file.size > UNCOMPRESSIBLE_IMAGE_MAX_BYTES) {
    throw new MediaTooLargeError('حجم ملف GIF/SVG يتجاوز الحد الأقصى المسموح (2 ميغابايت). اختر ملفاً أصغر.');
  }

  // SVG غير موثوق: يُفحص ضد المحتوى النشط (script/embed/object/iframe/foreignObject/
  // معالجات أحداث inline/xlink javascript/عناصر use خارجية) — يُرفض المشبوه برسالة
  // واضحة بدل تمرييره دون تنقية. الفحص يغطي أول 64KB (تُوضع العناصر النشطة دائماً
  // في مقدمة الملف عملياً). تنقية كاملة عبر مكتبة (DOMPurify) تتطلب اعتماد
  // تبعية جديدة — مؤجل لقرار مستقل، والموقف الحالي: الرفض بدل السماح المشبوه.
  if (file.type === 'image/svg+xml') {
    const svgText = await file.slice(0, 64 * 1024).text();
    if (/<script[\s>]|<\s*embed|<\s*object|foreignObject|<\s*iframe|<\s*use[\s>]|xlink:href\s*=\s*["']?\s*javascript:|data:text\/html|\son\w+\s*=\s*["'>]/i.test(svgText)) {
      throw new Error('ملف SVG يحتوي على محتوى غير آمن (برمجيات نشطة) ولا يمكن رفعه.');
    }
  }

  // ملف صورة فعلي (GIF/SVG لا يمران عبر ضغط Canvas حفاظاً على الحركة والشفافية)
  const isImageFile = file.type.startsWith('image/')
    && file.type !== 'image/gif'
    && file.type !== 'image/svg+xml';

  if (effectivePreset && isImagePreset(effectivePreset) && isImageFile) {
    // كل إعدادات الصور (avatar/cover/feedImage/highlightCover/storyImage/chatImage)
    // تمر إجبارياً عبر الضغط المركزي — لا يُرفع الأصل بصمت عند فشل الضغط.
    uploadFile = await compressImage(file, effectivePreset, percent => onPhase?.('compressing', percent), signal);
  } else if (effectivePreset === 'video'
    || (effectivePreset && isImagePreset(effectivePreset) && file.type.startsWith('video/'))) {
    // preset صوري مفروض على ملف فيديو (مسار إنشاء القصص مثلاً) — نعامله كفيديو:
    uploadFile = await compressVideo(file, {
      onProgress: percent => onPhase?.('compressing', percent),
      signal,
    });
  } else if (effectivePreset === 'voiceMessage') {
    // تسجيلات الدردشة (webm/opus في Chrome) تتحول إلى .m4a خفيف متوافق مع iOS —
    // وعند غياب الدعم يبقى التسجيل الأصلي (المسار الاحتياطي الآمن داخل extractAudio)
    uploadFile = await extractAudio(file, {
      kind: 'voiceMessage',
      onProgress: percent => onPhase?.('compressing', percent),
      signal,
    });
  }

  if (uploadFile.size > MAX_UPLOAD_BYTES) throw new MediaTooLargeError();

  // 2) امتداد المسار يطابق المحتوى الفعلي بعد التحويل (voiceMessage → .m4a)
  const normalizedPath = effectivePreset === 'voiceMessage' && /\.(webm|ogg|oga)$/i.test(path)
    ? path.replace(/\.(webm|ogg|oga)$/i, '.m4a')
    : path;

  // 3) الرفع المباشر إلى ImageKit
  onPhase?.('uploading');
  const auth = await fetchImageKitAuth(signal);

  const normalized = normalizedPath.replace(/^\/+/, '');
  // المسار يُنظَّف دائماً: رموز غير مقبولة لدى ImageKit تُستبدل بشرطة، وتُدمج
  // الشرطات المائلة المتتالية، ولا أقسام فارغة — مجلد نظيف خالٍ من العيوب
  const cleanPath = normalized
    .replace(/[^a-zA-Z0-9._\-\/]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const dirIndex = cleanPath.lastIndexOf('/');
  const fileName = dirIndex >= 0 ? cleanPath.slice(dirIndex + 1) : cleanPath;
  const folder = `/aani/${dirIndex >= 0 ? cleanPath.slice(0, dirIndex) : 'misc'}`;

  // اسم رفع آمن بامتداد صحيح — ImageKit يعتمد الامتداد لتحديد نوع المحتوى
  // ويرفض أسماء بلا امتداد؛ الضواغط قد تعيد Blob بلا اسم فيصار للنوع
  const uploadName = ensureUploadName(uploadFile, fileName || 'media');

  const url = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    // الاسم الآمن يُمرَّر صراحةً كوسيط ثالث — حتى لو عاد الضاغط كائن Blob
    // بلا اسم تبقى الامتداد صحيحاً (.jpg/.webp/.mp4/.m4a)
    form.append('file', uploadFile, uploadName);
    form.append('fileName', uploadName);
    form.append('folder', folder);
    form.append('useUniqueFileName', 'true');
    if (!auth.publicKey) {
      reject(new Error('مفتاح ImageKit العام مفقود من إعدادات الخادم (IMAGEKIT_PUBLIC_KEY).'));
      return;
    }
    form.append('publicKey', auth.publicKey);
    form.append('token', auth.token);
    // expire بالثواني (unix) كما يتطلب ImageKit — cachedAuth يبقيه تحت ساعة
    form.append('expire', String(auth.expire));
    form.append('signature', auth.signature);

    const detachAbort = signal
      ? (() => {
          const onAbort = () => xhr.abort();
          signal.addEventListener('abort', onAbort, { once: true });
          return () => signal.removeEventListener('abort', onAbort);
        })()
      : () => undefined;

    xhr.open('POST', 'https://upload.imagekit.io/api/v1/files/upload');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
      }
    };
    xhr.onload = () => {
      detachAbort();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as { url?: unknown };
          if (typeof parsed.url === 'string' && parsed.url) {
            onProgress?.(100);
            resolve(parsed.url);
          } else {
            reject(new Error('نجح الرفع لكن لم يُرجَع رابط الملف.'));
          }
        } catch {
          reject(new Error('تعذر قراءة رابط الملف بعد الرفع.'));
        }
      } else {
        // رسالة ImageKit الحقيقية تُستخرج من استجابة الخطأ بدل إخفائها
        let detail = '';
        try {
          const parsed = JSON.parse(xhr.responseText) as { message?: unknown; help?: unknown };
          if (typeof parsed.message === 'string' && parsed.message) {
            detail = parsed.message;
          } else if (typeof parsed.help === 'string' && parsed.help) {
            detail = parsed.help;
          }
        } catch {
          if (xhr.responseText) detail = xhr.responseText.slice(0, 200);
        }
        reject(new Error(`فشل رفع الوسائط (HTTP ${xhr.status})${detail ? `: ${detail}` : '.'}`));
      }
    };
    xhr.onerror = () => {
      detachAbort();
      reject(new Error('تعذر الاتصال بخدمة رفع الوسائط.'));
    };
    xhr.onabort = () => {
      detachAbort();
      reject(new DOMException('أُلغيت عملية رفع الوسائط.', 'AbortError'));
    };
    xhr.send(form);
  });

  // سجّل الرابط النهائي مقابل مسار الرفع الأصلي: أي getPublicUrl(path) لاحق
  // في التطبيق يعيد رابط ImageKit الحقيقي بدل رابط Supabase غير موجود.
  registerUploadedMediaUrl(path, url);

  // سجل الرفع (Upload Ledger): لملاحقة الملفات المرفوعة بلا مرجع — كنس اليتامى
  // يحدث لاحقاً من الخادم بعد فترة سماح وفحص مراجع صارم. التسجيل موثوق:
  // محاولة فورية، وعند فشلها يبقى الرابط في طابور محلي يُعاد إرساله تلقائياً
  // عند تسجيل الدخول/الإقلاع (uploadLedgerQueue). لا يُنتظر ولا يفشل الرفع
  // أبداً — لكن fire-and-forget وحده لم يعد الاعتماد الوحيد.
  void recordUploadLedgerReliably(url).catch(() => undefined);

  return url;
}

export function uploadMedia(options: UploadOptions): Promise<string> {
  return safeExecute(
    'فشل رفع الوسائط',
    () => uploadMediaUnsafe(options),
    'تعذر رفع ملف الوسائط. حاول مرة أخرى.',
  );
}

export const uploadStoryMedia = uploadMedia;
