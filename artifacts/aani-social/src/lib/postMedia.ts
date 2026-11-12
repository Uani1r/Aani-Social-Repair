import { supabase, storageBucket } from '@/lib/supabase';

type PostMediaRecord = {
  media_url: string | null;
  media_urls?: string[] | null;
  media_asset_id?: string | null;
};

function toPublicMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^(?:https?:|blob:|data:|\/\/)/i.test(raw)) return raw;

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
  return publicUrl ? `${publicUrl}${query}${fragment}` : null;
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
