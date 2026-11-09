// رفع الوسائط مع نسبة تقدّم حقيقية عبر XHR وخطة بديلة عبر عميل Supabase.

import { supabase, storageBucket, supabasePublicKey, supabaseUrl } from '@/lib/supabase';
import { safeExecute } from '@/lib/appErrors';
import { readLocalUserPreferences, type MediaQualityPreference } from '@/lib/userPreferences';

interface UploadOptions {
  file: File;
  path: string;
  onProgress?: (percent: number) => void;
  quality?: MediaQualityPreference;
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

async function uploadMediaUnsafe({ file, path, onProgress, quality }: UploadOptions): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const baseUrl = supabaseUrl;
  const anonKey = supabasePublicKey;
  const resolvedQuality = quality || readLocalUserPreferences(data.session?.user?.id || '').mediaQuality;
  const uploadFile = await prepareMediaFile(file, resolvedQuality);

  if (!token || !baseUrl) {
    const { error } = await supabase.storage
      .from(storageBucket)
      .upload(path, uploadFile, { contentType: uploadFile.type, upsert: true });
    if (error) throw error;
    onProgress?.(100);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let fallbackStarted = false;
    const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');

    const fallbackUpload = async () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      try {
        const { error } = await supabase.storage
          .from(storageBucket)
          .upload(path, uploadFile, { contentType: uploadFile.type, upsert: true });
        if (error) throw error;
        onProgress?.(100);
        resolve();
      } catch (error) {
        reject(error || new Error('تعذر رفع ملف الوسائط إلى التخزين'));
      }
    };

    xhr.open('POST', `${baseUrl.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(storageBucket)}/${encodedPath}`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    if (anonKey) xhr.setRequestHeader('apikey', anonKey);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.setRequestHeader('content-type', uploadFile.type || 'application/octet-stream');

    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        void fallbackUpload();
      }
    };

    xhr.onerror = () => void fallbackUpload();
    xhr.onabort = () => reject(new Error('أُلغيت عملية رفع الوسائط'));
    xhr.send(uploadFile);
  });
}

export function uploadMedia(options: UploadOptions): Promise<void> {
  return safeExecute(
    'فشل رفع الوسائط',
    () => uploadMediaUnsafe(options),
    'تعذر رفع ملف الوسائط. حاول مرة أخرى.',
  );
}

export const uploadStoryMedia = uploadMedia;
