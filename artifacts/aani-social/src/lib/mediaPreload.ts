// Priority-aware media warm-up: real visible videos load through their P0
// player; a single nearest P1 video receives a bounded 200KB Range request.
import { isBackgroundMediaSuspended, subscribeBackgroundMediaSuspension } from '@/lib/activeVideo';

const preloadedImages = new Set<string>();
const inFlightImages = new Set<string>();

function isSupabaseStoragePublicUrl(url: string): boolean {
  return url.includes('/storage/v1/object/public/');
}

/** URL صغير للصور المرفوعة إلى Supabase Storage مع الرجوع للرابط الأصلي عند الحاجة. */
export function thumbnailUrl(url: string | null | undefined, width = 480): string {
  const source = typeof url === 'string' ? url : '';
  if (!source || !isSupabaseStoragePublicUrl(source)) return source;
  const separator = source.includes('?') ? '&' : '?';
  return `${source}${separator}width=${width}&quality=80`;
}

/** تحميل صورة مسبقاً مع منع الطلبات المكررة. */
export function preloadImage(url: string | null | undefined): void {
  const source = typeof url === 'string' ? url : '';
  if (!source || preloadedImages.has(source) || inFlightImages.has(source) || typeof window === 'undefined') return;

  inFlightImages.add(source);
  const image = new Image();
  image.onload = () => {
    inFlightImages.delete(source);
    preloadedImages.add(source);
  };
  image.onerror = () => inFlightImages.delete(source);
  image.src = source;
}

type VideoPreloadCandidate = {
  url: string;
  priority: 0 | 1;
  distance: number;
  attempted: boolean;
};

type VideoRangeRequest = {
  id: string;
  url: string;
  controller: AbortController;
  timeout: number;
};

const VIDEO_PREFETCH_BYTES = 200 * 1024;
const VIDEO_PREFETCH_TIMEOUT_MS = 5000;
const videoCandidates = new Map<string, VideoPreloadCandidate>();
let activeVideoRangeRequest: VideoRangeRequest | null = null;

function abortActiveVideoRangeRequest(): void {
  if (!activeVideoRangeRequest) return;
  window.clearTimeout(activeVideoRangeRequest.timeout);
  activeVideoRangeRequest.controller.abort();
  activeVideoRangeRequest = null;
}

function startNextVideoRangeRequest(): void {
  if (isBackgroundMediaSuspended()) {
    abortActiveVideoRangeRequest();
    return;
  }
  const next = Array.from(videoCandidates.entries())
    .filter(([, candidate]) => candidate.priority === 1 && !candidate.attempted)
    .sort((first, second) => first[1].distance - second[1].distance)[0];

  if (!next) {
    abortActiveVideoRangeRequest();
    return;
  }

  const [id, candidate] = next;
  const url = candidate.url.replace(/#.*$/, '');
  if (activeVideoRangeRequest?.id === id && activeVideoRangeRequest.url === url) return;

  abortActiveVideoRangeRequest();
  const controller = new AbortController();
  const request: VideoRangeRequest = { id, url, controller, timeout: 0 };
  activeVideoRangeRequest = request;
  let timedOut = false;
  request.timeout = window.setTimeout(() => {
    timedOut = true;
    const latestCandidate = videoCandidates.get(id);
    if (latestCandidate?.url.replace(/#.*$/, '') === url) {
      videoCandidates.set(id, { ...latestCandidate, attempted: true });
    }
    controller.abort();
  }, VIDEO_PREFETCH_TIMEOUT_MS);

  void (async () => {
    try {
      const init: RequestInit & { priority?: 'low' } = {
        headers: { Range: `bytes=0-${VIDEO_PREFETCH_BYTES - 1}` },
        signal: controller.signal,
        priority: 'low',
      };
      const response = await fetch(url, init);
      if (response.status !== 206) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) return;
      let received = 0;
      while (received < VIDEO_PREFETCH_BYTES) {
        const { done, value } = await reader.read();
        if (done) return;
        received += value.byteLength;
        if (received >= VIDEO_PREFETCH_BYTES) {
          await reader.cancel();
          return;
        }
      }
      await reader.cancel();
    } catch {
      // Prefetch is optional; native playback remains the P0 fallback.
    } finally {
      window.clearTimeout(request.timeout);
      if (!controller.signal.aborted || timedOut) {
        const latestCandidate = videoCandidates.get(id);
        if (latestCandidate?.url.replace(/#.*$/, '') === url) {
          videoCandidates.set(id, { ...latestCandidate, attempted: true });
        }
      }
      if (activeVideoRangeRequest === request) {
        activeVideoRangeRequest = null;
        startNextVideoRangeRequest();
      }
    }
  })();
}

subscribeBackgroundMediaSuspension(() => startNextVideoRangeRequest());

/** Update a visible/nearby video candidate. P0 uses its live player, never a duplicate fetch. */
export function setVideoPreloadCandidate(
  id: string,
  url: string | null | undefined,
  priority: 0 | 1,
  distance = 0,
): void {
  if (!id) return;
  if (!url) videoCandidates.delete(id);
  else {
    const previous = videoCandidates.get(id);
    const sameUrl = previous?.url.replace(/#.*$/, '') === url.replace(/#.*$/, '');
    videoCandidates.set(id, {
      url,
      priority,
      distance: Math.max(0, distance),
      attempted: Boolean(sameUrl && previous?.attempted),
    });
  }
  startNextVideoRangeRequest();
}

export function releaseVideoPreloadCandidate(id: string): void {
  if (!id || !videoCandidates.delete(id)) return;
  startNextVideoRangeRequest();
}

/** Legacy one-off warm-up path, now bounded and abortable. */
export function prebufferVideo(url: string | null | undefined, id = 'manual-video-preload'): void {
  setVideoPreloadCandidate(id, url, 1, 0);
}

/** Load images in a batch; video warm-up is owned by the visibility-aware P1 scheduler. */
export function preloadMediaList(urls: Array<string | null | undefined>, limit = 6): void {
  urls
    .filter((url): url is string => typeof url === 'string' && Boolean(url))
    .slice(0, limit)
    .forEach(url => {
      if (!/\.(mp4|webm|mov|m4v|avi|mkv)(\?|#|$)/i.test(url)) preloadImage(url);
    });
}

/** تهيئة الرابط حسب النوع؛ الفيديو عبر طلب Range محدود لا عبر عنصر فيديو وهمي. */
export function preloadMedia(url: string | null | undefined): void {
  const source = typeof url === 'string' ? url : '';
  if (!source) return;
  if (/\.(mp4|webm|mov|m4v|avi|mkv)(\?|#|$)/i.test(source)) prebufferVideo(source);
  else preloadImage(source);
}

/** أول رابط وسائط لمنشور. */
export function firstMediaUrlOfPost(post: { media_url?: string | null; media_urls?: string[] | null } | null | undefined): string | null {
  if (!post) return null;
  if (Array.isArray(post.media_urls) && post.media_urls.length > 0) return post.media_urls[0];
  return post.media_url || null;
}
