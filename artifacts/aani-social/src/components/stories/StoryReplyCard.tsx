import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';

import { SkeletonBlock } from '@/components/Skeletons';
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

type ResolvedStoryMedia = {
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
};

// كاش على مستوى الوحدة: عدة ردود على الستوري نفسها لا تُعيد طلب الشبكة.
const mediaCache = new Map<string, ResolvedStoryMedia>();
const mediaRequests = new Map<string, Promise<ResolvedStoryMedia>>();

function asUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function loadStoryMedia(storyId: string): Promise<ResolvedStoryMedia> {
  const empty: ResolvedStoryMedia = { thumbnailUrl: null, mediaUrl: null, mediaType: null };
  if (!supabaseConfigured) return empty;

  const { data, error } = await supabase
    .from('stories')
    .select('id, media_url, media_type, thumbnail_url')
    .eq('id', storyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return empty;

  return {
    thumbnailUrl: asUrl(data.thumbnail_url),
    mediaUrl: asUrl(data.media_url),
    mediaType: typeof data.media_type === 'string' ? data.media_type : null,
  };
}

function requestStoryMedia(storyId: string): Promise<ResolvedStoryMedia> {
  const cached = mediaCache.get(storyId);
  if (cached) return Promise.resolve(cached);

  const pending = mediaRequests.get(storyId);
  if (pending) return pending;

  const request = loadStoryMedia(storyId)
    .then(media => {
      mediaCache.set(storyId, media);
      return media;
    })
    .finally(() => {
      mediaRequests.delete(storyId);
    });
  mediaRequests.set(storyId, request);
  return request;
}

function pickPrimarySource(media: ResolvedStoryMedia): string | null {
  if (media.thumbnailUrl) return media.thumbnailUrl;
  if (media.mediaType === 'video') return null;
  return media.mediaUrl;
}

function pickSecondarySource(media: ResolvedStoryMedia, primary: string | null): string | null {
  if (media.mediaType === 'video') return null;
  if (!media.mediaUrl || media.mediaUrl === primary) return null;
  return media.mediaUrl;
}

/**
 * بطاقة رد الستوري داخل المحادثة الخاصة (Instagram Direct style):
 * عنوان صغير + صورة عمودية 9:16 للستوري أو إطار فيديو أول + فقاعة نص الرد.
 *
 * الصورة تأتي من البيانات المحفوظة مع الرسالة نفسها (story_thumbnail_url /
 * story_media_url)، فتبقى البطاقة سليمة بعد انتهاء صلاحية الستوري أو حذفها.
 * عند غياب البيانات المحفوظة (رسائل قديمة) نحاول قراءة الستوري من جدول stories،
 * وإن تعذّر ذلك نعرض بطاقة بديلة أنيقة بدل مساحة صورة فارغة.
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
  const [resolved, setResolved] = useState<ResolvedStoryMedia>(() => ({ thumbnailUrl, mediaUrl, mediaType }));
  const [loading, setLoading] = useState(() => (
    Boolean(storyId) && !pickPrimarySource({ thumbnailUrl, mediaUrl, mediaType })
  ));
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [secondaryFailed, setSecondaryFailed] = useState(false);

  useEffect(() => {
    setResolved({ thumbnailUrl, mediaUrl, mediaType });
    setPrimaryFailed(false);
    setSecondaryFailed(false);
  }, [thumbnailUrl, mediaUrl, mediaType]);

  const needsLookup = useMemo(
    () => Boolean(storyId) && !pickPrimarySource({ thumbnailUrl, mediaUrl, mediaType }),
    [storyId, thumbnailUrl, mediaUrl, mediaType],
  );

  useEffect(() => {
    if (!needsLookup || !storyId) {
      setLoading(false);
      return;
    }

    const cached = mediaCache.get(storyId);
    if (cached) {
      setResolved(current => ({ ...current, ...cached }));
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void requestStoryMedia(storyId)
      .then(media => {
        if (active) setResolved(current => ({ ...current, ...media }));
      })
      .catch(error => {
        console.warn('[story reply card] تعذر تحميل بيانات الستوري:', error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [needsLookup, storyId]);

  const primarySource = pickPrimarySource(resolved);
  const secondarySource = pickSecondarySource(resolved, primarySource);
  const source = primaryFailed
    ? (secondaryFailed ? null : secondarySource)
    : primarySource;

  const handleImageError = () => {
    if (source && secondarySource && source === secondarySource && primaryFailed) {
      setSecondaryFailed(true);
      return;
    }
    setPrimaryFailed(true);
  };

  const media = loading ? (
    <div className="messages-story-reply-media" aria-hidden="true">
      <SkeletonBlock className="absolute inset-0 rounded-none" />
    </div>
  ) : source ? (
    onOpen ? (
      <button
        type="button"
        className="messages-story-reply-media is-button"
        onClick={onOpen}
        aria-label="عرض الستوري"
      >
        <img src={source} alt="" loading="lazy" onError={handleImageError} />
      </button>
    ) : (
      <div className="messages-story-reply-media">
        <img src={source} alt="" loading="lazy" onError={handleImageError} />
      </div>
    )
  ) : (
    <div className="messages-story-reply-media is-unavailable" role="img" aria-label="انتهت صلاحية الستوري">
      <span className="messages-story-reply-fallback">
        <ImageOff size={22} aria-hidden="true" />
        <span>انتهت صلاحية الستوري</span>
      </span>
    </div>
  );

  return (
    <div className={`messages-story-reply${isMine ? ' is-mine' : ' is-theirs'}`}>
      {header}
      <span className="messages-story-reply-label">{isMine ? 'رددت على قصته' : 'ردّ على قصتك'}</span>
      {media}
      {children}
    </div>
  );
}
