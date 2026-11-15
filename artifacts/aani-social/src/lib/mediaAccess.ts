/**
 * وصول موحّد إلى وسائط التخزين: مسار → رابط قابل للعرض.
 *
 * المشكلة: bucket aani-media عام، فأي شخص يملك رابط الملف يفتحه ولو لم يكن
 * يحق له قراءة المنشور. إخفاء المنشور في الواجهة لا يحمي الملف نفسه.
 * الحل: bucket خاص + سياسة قراءة على storage.objects تتحقق من حق المشاهد في
 * المحتوى (aani_can_read_media_object)، ثم روابط موقّعة قصيرة العمر.
 *
 * هذه الوحدة تُبقي العرض كما هو في بقية التطبيق:
 *   - رابط خارجي (ImageKit، R2، أي مضيف) → يُعاد كما هو بلا أي طلب شبكة.
 *   - blob:/data: → يُعاد كما هو.
 *   - مسار داخل bucket أو رابط Supabase عام → رابط موقّع، وإن تعذّر التوقيع
 *     (bucket ما زال عاماً أو لا صلاحية) يُعاد الرابط العام كما كان سابقاً.
 * فالسلوك قبل تحويل الـbucket وبعده متطابق من جهة الواجهة.
 */

import { useEffect, useState } from 'react';

import { storageBucket, supabase, supabaseConfigured } from '@/lib/supabase';

/** مدة صلاحية الرابط الموقّع بالثواني. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** تجديد قبل الانتهاء بهامش حتى لا ينتهي الرابط أثناء العرض. */
const SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

type CacheEntry = { url: string; expiresAt: number | null };

const urlCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<string | null>>();

const STORAGE_PUBLIC_PATH = /\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/;

/** يستخرج (bucket, path) من قيمة مخزّنة في قاعدة البيانات، أو null لغير التخزين. */
export function parseStorageRef(raw: string | null | undefined): { bucket: string; path: string } | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  if (/^(?:https?:)?\/\//i.test(value) || /^(?:blob:|data:)/i.test(value)) {
    const match = value.match(STORAGE_PUBLIC_PATH);
    if (!match) return null;
    try {
      return { bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
    } catch {
      return { bucket: match[1], path: match[2] };
    }
  }

  let objectPath = value;
  const bucketPrefix = `${storageBucket}/`;
  if (objectPath.startsWith(bucketPrefix)) objectPath = objectPath.slice(bucketPrefix.length);
  objectPath = objectPath.replace(/^\/+/, '').split('?')[0].split('#')[0];
  return objectPath ? { bucket: storageBucket, path: objectPath } : null;
}

function cacheKeyOf(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

function readCached(key: string): string | null {
  const entry = urlCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS <= Date.now()) return null;
  return entry.url;
}

/**
 * رابط قابل للعرض لقيمة وسائط مخزّنة.
 * يُعيد القيمة كما هي لغير مسارات التخزين، وnull للقيم الفارغة.
 */
export async function resolveMediaUrl(raw: string | null | undefined): Promise<string | null> {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  const ref = parseStorageRef(value);
  // ليس مسار تخزين (ImageKit مثلاً): لا تحويل ولا طلب شبكة.
  if (!ref) return value;
  if (!supabaseConfigured) return value;

  const key = cacheKeyOf(ref.bucket, ref.path);
  const cached = readCached(key);
  if (cached) return cached;

  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const request = (async (): Promise<string | null> => {
    try {
      const { data, error } = await supabase.storage
        .from(ref.bucket)
        .createSignedUrl(ref.path, SIGNED_URL_TTL_SECONDS);

      if (!error && data?.signedUrl) {
        urlCache.set(key, {
          url: data.signedUrl,
          expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
        });
        return data.signedUrl;
      }
    } catch {
      // bucket عام أو بلا صلاحية توقيع: نسقط إلى الرابط العام كما كان.
    }

    try {
      const publicUrl = supabase.storage.from(ref.bucket).getPublicUrl(ref.path).data.publicUrl;
      if (publicUrl) {
        // لا يُخزَّن الرابط العام طويلاً: قد يصبح الملف محمياً بعد الترحيل.
        urlCache.set(key, { url: publicUrl, expiresAt: Date.now() + 30 * 1000 });
        return publicUrl;
      }
    } catch {
      // تجاهل: نُعيد القيمة الأصلية أدناه.
    }

    return value;
  })();

  pendingRequests.set(key, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(key);
  }
}

/**
 * نسخة متزامنة: تُعيد الرابط الموقّع إن كان في الذاكرة، وإلا القيمة الأصلية
 * حتى يصل الموقّع — تُستخدم لعرض فوري بلا وميض.
 */
export function resolveMediaUrlSync(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const ref = parseStorageRef(value);
  if (!ref) return value;
  return readCached(cacheKeyOf(ref.bucket, ref.path)) || value;
}

/**
 * نسخة React للوسائط المفردة (صورة ملف، غلاف): تُعرض القيمة الأصلية فوراً
 * ثم تُستبدل بالرابط الموقّع عند وصوله.
 */
export function useMediaUrl(raw: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => resolveMediaUrlSync(raw));

  useEffect(() => {
    let active = true;
    setResolved(resolveMediaUrlSync(raw));
    void resolveMediaUrl(raw).then(url => {
      if (active && url) setResolved(url);
    });
    return () => {
      active = false;
    };
  }, [raw]);

  return resolved;
}
