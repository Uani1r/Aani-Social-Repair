/**
 * وصول موحّد إلى وسائط التخزين و ImageKit: قيمة مخزّنة → رابط قابل للعرض.
 *
 * نوعان من الوسائط في هذا المشروع:
 *   1. ImageKit (كل الرفع الحالي): الرابط عام بطبيعته. توقيعه لا يفيد إلا إذا
 *      كانت الملفات مضبوطة على Restricted access أو رُفعت بـ isPrivateFile.
 *   2. Supabase Storage (الصفوف القديمة): bucket عام، فرابط /object/public/
 *      يفتح الملف لأي شخص يعرفه. الحماية تحتاج bucket خاصاً + روابط موقّعة.
 *
 * هذه الوحدة:
 *   - ImageKit عند VITE_IMAGEKIT_SIGNED_URLS=true: الرابط الموقّع وحده. لا رجوع
 *     إلى الرابط العام إطلاقاً — فشل التوقيع (بلا جلسة، 401، 403، انقطاع)
 *     يعني null: لا يُطلب الملف ولا يُعرض. عند إطفاء المتغير يعمل الرابط العام
 *     كما كان، فالتفعيل وحده يقلب السلوك إلى «الفشل مغلق».
 *   - مسار تخزين أو رابط Supabase: رابط موقّع، وإن تعذّر التوقيع يُعاد الرابط
 *     العام (الـbucket ما يزال عاماً، وتوقيعه لا يزيد حماية بعد).
 *   - blob:/data:/أي مضيف آخر: يُعاد كما هو بلا أي طلب شبكة.
 */

import { useEffect, useState } from 'react';

import { storageBucket, supabase, supabaseConfigured } from '@/lib/supabase';

/** مدة صلاحية الرابط الموقّع بالثواني. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** تجديد قبل الانتهاء بهامش حتى لا ينتهي الرابط أثناء العرض. */
const SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/**
 * تهدئة بعد فشل التوقيع: لا يُعاد الطلب لنفس المسار قبل انقضائها، فلا تتحول
 * صورة ممنوعة واحدة إلى سيل من 403 مع كل إعادة رسم.
 */
const SIGN_FAILURE_BACKOFF_MS = 30 * 1000;

/**
 * توقيع روابط ImageKit لا يُفعَّل افتراضياً: بدون Restricted access على حساب
 * ImageKit يبقى الرابط العادي صالحاً ويصبح التوقيع بلا فائدة.
 * راجع docs/PRIVATE_MEDIA_AR.md لخطوات التفعيل.
 */
const IMAGEKIT_SIGNING_ENABLED = ((): boolean => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return String(env?.VITE_IMAGEKIT_SIGNED_URLS || '').toLowerCase() === 'true';
  } catch {
    return false;
  }
})();

/** هل التوقيع الإلزامي مفعّل في هذه النسخة؟ (للواجهة والتشخيص) */
export function isImageKitSigningEnabled(): boolean {
  return IMAGEKIT_SIGNING_ENABLED;
}

/**
 * هل تُرفع الملفات الجديدة كخاصة (isPrivateFile)؟
 *
 * لا يُفعَّل إلا مع التوقيع الإلزامي: ملف خاص بلا توقيع في الواجهة = ملف لا
 * يُعرض أبداً. تفعيله منفرداً خطأ إعداد، لذلك يُشترط الاثنان معاً.
 */
const IMAGEKIT_PRIVATE_UPLOADS = ((): boolean => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return String(env?.VITE_IMAGEKIT_PRIVATE_UPLOADS || '').toLowerCase() === 'true';
  } catch {
    return false;
  }
})();

export function isImageKitPrivateUploadEnabled(): boolean {
  return IMAGEKIT_SIGNING_ENABLED && IMAGEKIT_PRIVATE_UPLOADS;
}

type CacheEntry = { url: string; expiresAt: number | null };

const urlCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<string | null>>();
/** طلبات توقيع ImageKit الجارية، مفتاحها المسار — تمنع تكرار الطلب نفسه. */
const pendingImageKitRequests = new Map<string, Promise<string | null>>();
/** مسارات فشل توقيعها ImageKit مؤخراً → وقت الفشل (ms). */
const signFailures = new Map<string, number>();

const STORAGE_PUBLIC_PATH = /\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/;
const IMAGEKIT_HOST = /(^|\.)ik\.imagekit\.io$/i;

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

/**
 * مسار ImageKit الكامل (بلا استعلام/جزء)، مع معرّف الحساب كما في الرابط المخزّن.
 *
 *   https://ik.imagekit.io/abc/u1/a b.jpg?tr=q-auto  →  /abc/u1/a%20b.jpg
 *
 * إبقاء معرّف الحساب يجعل المقارنة مع القيمة المخزّنة في قاعدة البيانات دقيقة
 * (نفس الشكل بعد تطبيع المسار)، والخادم هو من يحذف الـendpoint قبل التوقيع.
 */
export function parseImageKitPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!IMAGEKIT_HOST.test(parsed.hostname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const encoded = segments.map(segment => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  });

  return `/${encoded.join('/')}`;
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
 * يطلب من الخادم رابط ImageKit موقّعاً. الخادم يتحقق من الجلسة ومن حق المشاهد
 * في المحتوى (aani_can_read_media_object) قبل التوقيع بالمفتاح الخاص.
 *
 * عند التفعيل: **لا رجوع إلى الرابط العام**. أي فشل (بلا جلسة، 401، 403،
 * شبكة، استجابة بلا رابط) يُعيد null فلا يُطلب الملف من ImageKit إطلاقاً،
 * ولا يُكشف وجود ملف خاص. النتيجة السلبية تُحفظ 30 ثانية لتفادي تكرار الطلب.
 */
async function signImageKitUrl(raw: string): Promise<string | null> {
  const path = parseImageKitPath(raw);
  if (!path) return raw;
  if (!IMAGEKIT_SIGNING_ENABLED) return raw;
  if (!supabaseConfigured) return null;

  const key = `imagekit:${path}`;
  const cached = readCached(key);
  if (cached) return cached;

  const failedAt = signFailures.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < SIGN_FAILURE_BACKOFF_MS) return null;

  const pending = pendingImageKitRequests.get(key);
  if (pending) return pending;

  const request = (async (): Promise<string | null> => {
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      // بلا جلسة لا يوجد توقيع: فشل مغلق لا رابط عام.
      if (!accessToken) return null;

      const response = await fetch(`/api/media/imagekit-sign?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        // تشخيص بلا أسرار: المسار القادم من الرابط المخزّن وحالة HTTP فقط.
        console.warn('[media] تعذر توقيع رابط ImageKit', { status: response.status, path });
        signFailures.set(key, Date.now());
        return null;
      }

      const payload = await response.json().catch(() => null) as { url?: unknown; expire?: unknown } | null;
      if (typeof payload?.url !== 'string' || !payload.url) {
        console.warn('[media] استجابة توقيع ImageKit بلا رابط', { status: response.status, path });
        signFailures.set(key, Date.now());
        return null;
      }

      const expiresAt = typeof payload.expire === 'number' ? payload.expire * 1000 : null;
      signFailures.delete(key);
      urlCache.set(key, { url: payload.url, expiresAt });
      return payload.url;
    } catch (error) {
      console.warn('[media] فشل طلب توقيع ImageKit', { path, error: error instanceof Error ? error.message : 'unknown' });
      signFailures.set(key, Date.now());
      return null;
    } finally {
      pendingImageKitRequests.delete(key);
    }
  })();

  pendingImageKitRequests.set(key, request);
  return request;
}

/**
 * رابط قابل للعرض لقيمة وسائط مخزّنة.
 * يُعيد القيمة كما هي لغير مسارات التخزين، وnull للقيم الفارغة — وnull أيضاً
 * لوسيط ImageKit تعذّر توقيعه عند تفعيل التوقيع الإلزامي.
 */
export async function resolveMediaUrl(raw: string | null | undefined): Promise<string | null> {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  // ImageKit: عند التفعيل الرابط الموقّع وحده، وإلا الرابط كما هو.
  if (parseImageKitPath(value)) return signImageKitUrl(value);

  const ref = parseStorageRef(value);
  // ليس مسار تخزين: لا تحويل ولا طلب شبكة.
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
 * نسخة متزامنة: تُعيد الرابط الموقّع إن كان في الذاكرة.
 * لوسائط ImageKit عند تفعيل التوقيع: تُعيد null بدل الرابط العام إن لم يكن
 * الموقّع جاهزاً — لا يُطلب الملف من ImageKit بلا توقيع في أي لحظة.
 */
export function resolveMediaUrlSync(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const imageKitPath = parseImageKitPath(value);
  if (imageKitPath) {
    if (!IMAGEKIT_SIGNING_ENABLED) return value;
    return readCached(`imagekit:${imageKitPath}`);
  }
  const ref = parseStorageRef(value);
  if (!ref) return value;
  return readCached(cacheKeyOf(ref.bucket, ref.path)) || value;
}

/**
 * نسخة React للوسائط المفردة (صورة ملف، غلاف، قصة، رسالة).
 * عند تفعيل التوقيع الإلزامي تكون القيمة null حتى يصل الموقّع، وتبقى null إن
 * فشل التوقيع — فيُعرض بدل الوسيط عنصر محايد (انظر SignedImage) بدل طلب
 * الرابط العام أو كسر الصورة.
 */
export function useMediaUrl(raw: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => resolveMediaUrlSync(raw));

  useEffect(() => {
    let active = true;
    setResolved(resolveMediaUrlSync(raw));
    void resolveMediaUrl(raw).then(url => {
      // null يعني فشل التوقيع: يُثبَّت null ولا يُستبدل بالرابط العام.
      if (active) setResolved(url);
    });
    return () => {
      active = false;
    };
  }, [raw]);

  return resolved;
}
