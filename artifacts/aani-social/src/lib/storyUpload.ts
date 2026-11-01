// رفع وسائط الستوري مع نسبة تقدّم حقيقية عبر XHR (لا يجمّد الواجهة)

import { supabase, storageBucket, supabasePublicKey, supabaseUrl } from '@/lib/supabase';

interface UploadOptions {
  file: File;
  path: string;
  onProgress?: (percent: number) => void;
}

export async function uploadStoryMedia({ file, path, onProgress }: UploadOptions): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const baseUrl = supabaseUrl;
  const anonKey = supabasePublicKey;

  // بدون جلسة مصادقة: نرجع لرفع المكتبة (دون تقدم حقيقي)
  if (!token || !baseUrl) {
    const { error } = await supabase.storage
      .from(storageBucket)
      .upload(path, file, { contentType: file.type, upsert: true });
    onProgress?.(100);
    if (error) throw error;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
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
        return;
      }

      // بعض إعدادات التخزين لا تقبل رفع XHR: نجرب المكتبة كخطة بديلة
      void supabase.storage
        .from(storageBucket)
        .upload(path, file, { contentType: file.type, upsert: true })
        .then(({ error }) => {
          if (error) reject(error);
          else {
            onProgress?.(100);
            resolve();
          }
        });
    };

    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}
