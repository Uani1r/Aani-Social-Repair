// رفع الوسائط مع نسبة تقدّم حقيقية عبر XHR وخطة بديلة عبر عميل Supabase.

import { supabase, storageBucket, supabasePublicKey, supabaseUrl } from '@/lib/supabase';
import { safeExecute } from '@/lib/appErrors';

interface UploadOptions {
  file: File;
  path: string;
  onProgress?: (percent: number) => void;
}

async function uploadMediaUnsafe({ file, path, onProgress }: UploadOptions): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const baseUrl = supabaseUrl;
  const anonKey = supabasePublicKey;

  if (!token || !baseUrl) {
    const { error } = await supabase.storage
      .from(storageBucket)
      .upload(path, file, { contentType: file.type, upsert: true });
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
          .upload(path, file, { contentType: file.type, upsert: true });
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
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

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
    xhr.send(file);
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
