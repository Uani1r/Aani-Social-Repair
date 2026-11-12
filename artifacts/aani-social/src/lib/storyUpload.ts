// رفع الوسائط مباشرة إلى ImageKit.io مع نسبة تقدّم حقيقية عبر XHR.
// التوقيع الآمن (token/expire/signature) يأتي من الخادم الخلفي:
// GET /api/media/imagekit-auth (يستخدم IMAGEKIT_PRIVATE_KEY ولا يكشفه).
// الرابط العام الناتج يُسجَّل في supabase.ts فيُرجعه getPublicUrl
// لكل مكان يحوّل مسار الرفع إلى رابط عرض.

import { supabase, registerUploadedMediaUrl } from '@/lib/supabase';
import { safeExecute } from '@/lib/appErrors';
import { readLocalUserPreferences, type MediaQualityPreference } from '@/lib/userPreferences';

interface UploadOptions {
  file: File;
  path: string;
  onProgress?: (percent: number) => void;
  quality?: MediaQualityPreference;
}

type ImageKitAuthParams = {
  urlEndpoint: string;
  publicKey: string;
  token: string;
  expire: number;
  signature: string;
};

let cachedAuth: { params: ImageKitAuthParams; expiresAt: number } | null = null;

async function fetchImageKitAuth(): Promise<ImageKitAuthParams> {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) return cachedAuth.params;

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('يجب تسجيل الدخول قبل رفع الوسائط.');

  const response = await fetch('/api/media/imagekit-auth', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const result = await response.json().catch(() => null) as
    | (ImageKitAuthParams & { success?: unknown; error?: unknown })
    | null;
  if (!response.ok || !result || result.success !== true) {
    throw new Error(typeof result?.error === 'string' ? result.error : 'تعذر تجهيز توقيع رفع الوسائط.');
  }

  const params: ImageKitAuthParams = {
    urlEndpoint: result.urlEndpoint,
    publicKey: result.publicKey,
    token: result.token,
    expire: result.expire,
    signature: result.signature,
  };
  cachedAuth = { params, expiresAt: Date.now() + 25 * 60 * 1000 };
  return params;
}

async function prepareMediaFile(file: File, quality: MediaQualityPreference): Promise<File> {
  if (
    quality !== 'data-saving'
    || !file.type.startsWith('image/')
    || file.type === 'image/gif'
    || file.type === 'image/svg+xml'
  ) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('تعذر ضغط الصورة.'));
      image.src = objectUrl;
    });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.76));
    if (!blob || blob.size >= file.size) return file;

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}.webp`, { type: 'image/webp', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function uploadMediaUnsafe({ file, path, onProgress, quality }: UploadOptions): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const resolvedQuality = quality || readLocalUserPreferences(sessionData.session?.user?.id || '').mediaQuality;
  const uploadFile = await prepareMediaFile(file, resolvedQuality);
  const auth = await fetchImageKitAuth();

  const normalizedPath = path.replace(/^\/+/, '');
  const dirIndex = normalizedPath.lastIndexOf('/');
  const fileName = dirIndex >= 0 ? normalizedPath.slice(dirIndex + 1) : normalizedPath;
  const folder = `/aani/${dirIndex >= 0 ? normalizedPath.slice(0, dirIndex) : 'misc'}`;

  const url = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', uploadFile);
    form.append('fileName', fileName);
    form.append('folder', folder);
    form.append('useUniqueFileName', 'true');
    form.append('publicKey', auth.publicKey);
    form.append('token', auth.token);
    form.append('expire', String(auth.expire));
    form.append('signature', auth.signature);

    xhr.open('POST', 'https://upload.imagekit.io/api/v1/files/upload');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
      }
    };
    xhr.onload = () => {
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
        reject(new Error(`فشل رفع الوسائط (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('تعذر الاتصال بخدمة رفع الوسائط.'));
    xhr.onabort = () => reject(new Error('أُلغيت عملية رفع الوسائط.'));
    xhr.send(form);
  });

  // سجّل الرابط النهائي مقابل مسار الرفع: أي getPublicUrl(path) لاحق
  // في التطبيق يعيد رابط ImageKit الحقيقي بدل رابط Supabase غير موجود.
  registerUploadedMediaUrl(path, url);
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
