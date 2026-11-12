import { supabase, storageBucket } from '@/lib/supabase';

type PostMediaRecord = {
  media_url: string | null;
  media_urls?: string[] | null;
  media_asset_id?: string | null;
};

// معاملات التحسين التلقائي من ImageKit للصور: جودة تكيفية حسب الشبكة + صيغة تلقائية
// (WebP/AVIF) — تقلّص الحجم وتسرّع العرض. أما الفيديو فيُبثّ مباشرة بلا أي
// تحويلات حتى يبدأ التشغيل فوراً من CDN على متصفح الهاتف (iOS Safari).
const IMAGEKIT_MEDIA_TRANSFORMS = 'q-auto,f-auto';

const VIDEO_FILE_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp|m2ts)(?=$|[?#])/i;

function isImageKitHost(hostname: string): boolean {
  return /(^|\.)ik\.imagekit\.io$/i.test(hostname);
}

/** رابط فيديو مضاف إلى ImageKit؟ (بالامتداد، قبل أي ?query أو #fragment) */
export function isImageKitVideoUrl(url: string | null | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;

  const fragmentIndex = url.indexOf('#');
  const base = fragmentIndex >= 0 ? url.slice(0, fragmentIndex) : url;

  try {
    const parsed = new URL(base);
    return isImageKitHost(parsed.hostname) && VIDEO_FILE_EXTENSION_PATTERN.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * صورة مصغرة تلقائية للفيديو عبر ImageKit بإلحاق `/ik-thumbnail.jpg`
 * بنهاية رابط الفيديو — تُستخدم في poster بدل الشاشة السوداء.
 * يعيد null لغير روابط ImageKit.
 */
export function getImageKitVideoThumbnailUrl(url: string | null | undefined): string | null {
  if (!isImageKitVideoUrl(url)) return null;

  const source = url as string;
  const fragmentIndex = source.indexOf('#');
  const base = fragmentIndex >= 0 ? source.slice(0, fragmentIndex) : source;

  try {
    const parsed = new URL(base);
    parsed.searchParams.delete('tr');
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}/ik-thumbnail.jpg${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * يضيف `?tr=q-auto,f-auto` إلى روابط الصور من ImageKit فقط (ik.imagekit.io)
 * مع منع التكرار، وإلحاق الاستعلام قبل أي رمز تعديل (#t= / #crop=...).
 * روابط الفيديو تُعاد مباشرة بلا تحويلات لضمان أسرع بثّ، وغيرها تُعاد كما هي.
 */
export function optimizeImageKitMediaUrl(url: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  if (isImageKitVideoUrl(url)) return url;

  const fragmentIndex = url.indexOf('#');
  const base = fragmentIndex >= 0 ? url.slice(0, fragmentIndex) : url;
  const fragment = fragmentIndex >= 0 ? url.slice(fragmentIndex) : '';

  try {
    const parsed = new URL(base);
    if (!isImageKitHost(parsed.hostname)) return url;

    const existingTr = parsed.searchParams.getAll('tr');
    if (existingTr.some(value => value.includes('q-auto') && value.includes('f-auto'))) return url;

    parsed.searchParams.delete('tr');
    // سلسلة التحويلات في ImageKit تُفصل بفواصل داخل معامل tr واحد
    parsed.searchParams.set('tr', [...existingTr, IMAGEKIT_MEDIA_TRANSFORMS].join(','));

    return `${parsed.toString()}${fragment}`;
  } catch {
    return url;
  }
}

function toPublicMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^(?:https?:|blob:|data:|\/\/)/i.test(raw)) return optimizeImageKitMediaUrl(raw);

  const hashIndex = raw.indexOf('#');
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  const pathWithQuery = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = pathWithQuery.indexOf('?');
  const query = queryIndex >= 0 ? pathWithQuery.slice(queryIndex) : '';
  let objectPath = queryIndex >= 0 ? pathWithQuery.slice(0, queryIndex) : pathWithQuery;
  let bucket = storageBucket;

  const publicObjectMatch = objectPath.match(/(?:^|\/)storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (publicObjectMatch) {
    try {
      bucket = decodeURIComponent(publicObjectMatch[1]);
    } catch {
      bucket = publicObjectMatch[1];
    }
    objectPath = publicObjectMatch[2];
  } else {
    objectPath = objectPath.replace(/^\/+/, '');
    const bucketPrefix = `${storageBucket}/`;
    if (objectPath.startsWith(bucketPrefix)) objectPath = objectPath.slice(bucketPrefix.length);
  }

  if (!objectPath) return null;
  const publicUrl = supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
  return publicUrl ? optimizeImageKitMediaUrl(`${publicUrl}${query}${fragment}`) : null;
}

export async function resolvePostMediaUrls<T extends PostMediaRecord>(posts: T[]): Promise<T[]> {
  if (posts.length === 0) return posts;

  const normalized = posts.map(post => {
    const mediaUrls = Array.isArray(post.media_urls)
      ? post.media_urls.map(toPublicMediaUrl).filter((url): url is string => Boolean(url))
      : [];
    const mediaUrl = toPublicMediaUrl(post.media_url) || mediaUrls[0] || null;
    return {
      ...post,
      media_url: mediaUrl,
      media_urls: mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : null,
    };
  });

  const assetIds = Array.from(new Set(normalized
    .filter(post => !post.media_url && !post.media_urls?.length && post.media_asset_id)
    .map(post => post.media_asset_id as string)));
  if (assetIds.length === 0) return normalized as T[];

  try {
    const { data, error } = await supabase
      .from('media_assets')
      .select('id, video_url, original_path')
      .in('id', assetIds);
    if (error || !Array.isArray(data)) return normalized as T[];

    const assetsById = new Map<string, Record<string, unknown>>();
    (data as unknown[]).forEach(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const asset = value as Record<string, unknown>;
      if (typeof asset.id === 'string') assetsById.set(asset.id, asset);
    });

    return normalized.map(post => {
      if (post.media_url || post.media_urls?.length || !post.media_asset_id) return post;
      const asset = assetsById.get(post.media_asset_id);
      const mediaUrl = toPublicMediaUrl(asset?.video_url)
        || toPublicMediaUrl(asset?.original_path);
      return mediaUrl ? { ...post, media_url: mediaUrl, media_urls: [mediaUrl] } : post;
    }) as T[];
  } catch {
    // Posts still render when the optional media-assets lookup is unavailable.
    return normalized as T[];
  }
}
