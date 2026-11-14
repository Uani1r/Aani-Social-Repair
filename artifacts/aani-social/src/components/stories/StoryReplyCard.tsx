import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ImageOff, RotateCw } from 'lucide-react';

import { SkeletonBlock } from '@/components/Skeletons';
import { isImageStoryMediaType, isVideoStoryMediaType } from '@/lib/storyReplyMessages';
import { supabase, supabaseConfigured } from '@/lib/supabase';

interface StoryReplyCardProps {
  storyId: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
  isMine: boolean;
  onOpen?: () => void;
  /** معاينة الرد المتسلسل (replyPreview) تظهر أعلى البطاقة. */
  header?: ReactNode;
  /** فقاعة نص الرد + وقت الرسالة وحالتها. */
  children?: ReactNode;
}

type StoryMedia = {
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
};

type StoryLookupResult =
  | { status: 'found'; media: StoryMedia; expiresAt: string | null }
  | { status: 'missing' };

type LookupStatus = 'idle' | 'loading' | 'error' | 'missing';

// كاش على مستوى الوحدة للنتائج الناجحة فقط: الفشل المؤقت (شبكة/RLS) لا يُحفظ
// كنتيجة نهائية، فتحاول البطاقة مجدداً عند فتح المحادثة لاحقاً.
const mediaCache = new Map<string, { media: StoryMedia; expiresAt: string | null }>();
const mediaRequests = new Map<string, Promise<StoryLookupResult>>();

function asUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isPastDate(value: string | null): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed <= Date.now() : false;
}

async function queryStoryMedia(storyId: string, withExpiry: boolean): Promise<StoryLookupResult> {
  const columns = withExpiry
    ? 'id, media_url, media_type, thumbnail_url, expires_at'
    : 'id, media_url, media_type, thumbnail_url';
  const { data, error } = await supabase
    .from('stories')
    .select(columns)
    .eq('id', storyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 'missing' };

  return {
    status: 'found',
    media: {
      thumbnailUrl: asUrl(data.thumbnail_url),
      mediaUrl: asUrl(data.media_url),
      mediaType: typeof data.media_type === 'string' ? data.media_type : null,
    },
    expiresAt: withExpiry && typeof data.expires_at === 'string' ? data.expires_at : null,
  };
}

async function loadStoryMedia(storyId: string): Promise<StoryLookupResult> {
  if (!supabaseConfigured) throw new Error('Supabase is not configured');
  try {
    return await queryStoryMedia(storyId, true);
  } catch (error) {
    // قاعدة قديمة بلا expires_at: نعيد المحاولة بالأعمدة الأساسية فقط.
    const message = error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : '';
    if (!/expires_at/i.test(message)) throw error;
    return queryStoryMedia(storyId, false);
  }
}

function requestStoryMedia(storyId: string): Promise<StoryLookupResult> {
  const cached = mediaCache.get(storyId);
  if (cached) {
    return Promise.resolve({ status: 'found', media: cached.media, expiresAt: cached.expiresAt });
  }

  const pending = mediaRequests.get(storyId);
  if (pending) return pending;

  const request = loadStoryMedia(storyId)
    .then(result => {
      if (result.status === 'found') {
        mediaCache.set(storyId, { media: result.media, expiresAt: result.expiresAt });
      }
      return result;
    })
    .finally(() => {
      mediaRequests.delete(storyId);
    });
  mediaRequests.set(storyId, request);
  return request;
}

/**
 * بطاقة رد الستوري داخل المحادثة الخاصة:
 * عنوان صغير + إطار معاينة 90×120 + فقاعة نص الرد.
 *
 * أولوية الوسائط: story_thumbnail_url المحفوظة مع الرسالة، ثم story_media_url
 * المحفوظة. عند غيابهما نقرأ الستوري من جدول stories عبر story_id (وليس posts).
 * «انتهت صلاحية الستوري» تظهر فقط عند تأكيد غياب السجل أو انتهاء وقته بلا أي
 * وسائط؛ فشل الشبكة/RLS يظهر كحالة «تعذر تحميل المعاينة» مع إعادة المحاولة.
 */
export default function StoryReplyCard({
  storyId,
  mediaUrl,
  thumbnailUrl,
  mediaType,
  isMine,
  onOpen,
  header,
  children,
}: StoryReplyCardProps) {
  const [found, setFound] = useState<{ media: StoryMedia; expiresAt: string | null } | null>(null);
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>('idle');
  const [retryNonce, setRetryNonce] = useState(0);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setFound(null);
    setLookupStatus('idle');
    setFailedImages([]);
    setVideoFailed(false);
  }, [storyId, thumbnailUrl, mediaUrl, mediaType]);

  const resolved = useMemo<StoryMedia>(() => ({
    thumbnailUrl: thumbnailUrl || found?.media.thumbnailUrl || null,
    mediaUrl: mediaUrl || found?.media.mediaUrl || null,
    mediaType: mediaType || found?.media.mediaType || null,
  }), [thumbnailUrl, mediaUrl, mediaType, found]);

  // لا نبحث في stories إلا عند غياب أي وسائط محفوظة مع الرسالة.
  const needsLookup = useMemo(
    () => Boolean(storyId) && !thumbnailUrl && !mediaUrl,
    [storyId, thumbnailUrl, mediaUrl],
  );

  useEffect(() => {
    if (!needsLookup || !storyId) return;

    const cached = mediaCache.get(storyId);
    if (cached) {
      setFound({ media: cached.media, expiresAt: cached.expiresAt });
      setLookupStatus('idle');
      return;
    }

    let active = true;
    setLookupStatus('loading');
    void requestStoryMedia(storyId)
      .then(result => {
        if (!active) return;
        if (result.status === 'missing') {
          setLookupStatus('missing');
          return;
        }
        setFound({ media: result.media, expiresAt: result.expiresAt });
        setLookupStatus('idle');
      })
      .catch(error => {
        if (!active) return;
        console.warn('[story reply card] تعذر تحميل بيانات الستوري (شبكة أو صلاحيات):', error);
        setLookupStatus('error');
      });

    return () => {
      active = false;
    };
  }, [needsLookup, storyId, retryNonce]);

  const imageSources = useMemo(() => {
    const candidates = [
      resolved.thumbnailUrl,
      isImageStoryMediaType(resolved.mediaType) ? resolved.mediaUrl : null,
    ];
    return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
  }, [resolved]);

  const usableImage = imageSources.find(source => !failedImages.includes(source)) ?? null;
  const videoSource = !usableImage && isVideoStoryMediaType(resolved.mediaType) && resolved.mediaUrl
    ? resolved.mediaUrl
    : null;

  const storyExpired = Boolean(found?.expiresAt && isPastDate(found.expiresAt));
  const hasPreview = Boolean(usableImage) || Boolean(videoSource && !videoFailed);

  // «انتهت صلاحية الستوري» لا تُعرض إلا عند تأكيد غياب السجل، أو عند ثبوت
  // انتهاء expires_at مع عدم وجود أي معاينة قابلة للعرض. وجود سجل بلا وسائط
  // (أو بلا expires_at) حالة فشل تحميل: «تعذر تحميل المعاينة».
  let fallbackKind: 'loading' | 'error' | 'expired' = 'error';
  if (needsLookup && lookupStatus === 'loading') fallbackKind = 'loading';
  else if (needsLookup && lookupStatus === 'error') fallbackKind = 'error';
  else if (needsLookup && lookupStatus === 'missing') fallbackKind = 'expired';
  else if (found && storyExpired && !hasPreview) fallbackKind = 'expired';
  else fallbackKind = 'error';

  const retry = () => {
    setFailedImages([]);
    setVideoFailed(false);
    if (lookupStatus === 'error') setRetryNonce(value => value + 1);
  };

  const handleImageError = (source: string) => {
    setFailedImages(current => (current.includes(source) ? current : [...current, source]));
  };

  const openable = Boolean(onOpen) && (
    Boolean(usableImage) || Boolean(videoSource && !videoFailed)
  );

  let media: ReactNode;
  if (!usableImage && !videoSource && fallbackKind === 'loading') {
    media = (
      <div className="messages-story-reply-media" aria-hidden="true">
        <SkeletonBlock className="absolute inset-0 rounded-none" />
      </div>
    );
  } else if (usableImage) {
    media = (
      <img
        src={usableImage}
        alt=""
        loading="lazy"
        onError={() => handleImageError(usableImage)}
      />
    );
  } else if (videoSource && !videoFailed) {
    // إطار الفيديو الأول عبر عنصر فيديو متوقف (بلا تشغيل ولا أزرار).
    media = (
      <video
        src={videoSource}
        muted
        playsInline
        preload="metadata"
        onError={() => setVideoFailed(true)}
      />
    );
  } else if (fallbackKind === 'error') {
    media = (
      <span className="messages-story-reply-fallback">
        <ImageOff size={18} aria-hidden="true" />
        <span>تعذر تحميل المعاينة</span>
        <button type="button" className="messages-story-reply-retry" onClick={retry}>
          <RotateCw size={12} aria-hidden="true" />
          إعادة المحاولة
        </button>
      </span>
    );
  } else {
    media = (
      <span className="messages-story-reply-fallback">
        <ImageOff size={18} aria-hidden="true" />
        <span>انتهت صلاحية الستوري</span>
      </span>
    );
  }

  const mediaClassName = `messages-story-reply-media${hasPreview ? '' : ' is-unavailable'}${openable ? ' is-button' : ''}`;

  const mediaBody = openable ? (
    <button type="button" className={mediaClassName} onClick={onOpen} aria-label="عرض الستوري">
      {media}
    </button>
  ) : (
    <div
      className={mediaClassName}
      role={hasPreview ? undefined : 'img'}
      aria-label={hasPreview
        ? undefined
        : fallbackKind === 'error'
          ? 'تعذر تحميل معاينة الستوري'
          : 'انتهت صلاحية الستوري'}
    >
      {media}
    </div>
  );

  return (
    <div className={`messages-story-reply${isMine ? ' is-mine' : ' is-theirs'}`}>
      {header}
      <span className="messages-story-reply-label">{isMine ? 'رددت على قصته' : 'ردّ على قصتك'}</span>
      {mediaBody}
      {children}
    </div>
  );
}
