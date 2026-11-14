import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';

import { SkeletonBlock } from '@/components/Skeletons';
import { supabase, supabaseConfigured } from '@/lib/supabase';

type StoryReplyPreviewMeta = {
  id: string;
  media_url: string | null;
  media_type: string;
  expires_at: string | null;
  author_name: string | null;
};

interface StoryReplyPreviewProps {
  storyId: string;
  /** صاحب الستوري إن كان معروفاً من المحادثة (يُستخدم عند تعذّر تحميل الاسم). */
  ownerName?: string;
  /** فتح قصص صاحب الستوري النشطة، إن أمكن. */
  onOpen?: () => void;
}

// كاش على مستوى الوحدة: الردود المتعددة على الستوري نفسها لا تُعيد طلب الشبكة.
const metaCache = new Map<string, StoryReplyPreviewMeta>();
const metaRequests = new Map<string, Promise<StoryReplyPreviewMeta>>();

const isExpired = (expiresAt: string | null): boolean => {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed <= Date.now() : false;
};

async function loadStoryReplyPreviewMeta(storyId: string): Promise<StoryReplyPreviewMeta> {
  const unavailable: StoryReplyPreviewMeta = {
    id: storyId,
    media_url: null,
    media_type: 'image',
    expires_at: null,
    author_name: null,
  };
  if (!supabaseConfigured) return unavailable;

  const { data, error } = await supabase
    .from('stories')
    .select('id, user_id, media_url, media_type, expires_at')
    .eq('id', storyId)
    .maybeSingle();
  if (error) throw error;
  if (!data || typeof data.id !== 'string') return unavailable;

  let authorName: string | null = null;
  if (typeof data.user_id === 'string') {
    const { data: author, error: authorError } = await supabase
      .from('profiles')
      .select('id, username, full_name, display_name')
      .eq('id', data.user_id)
      .maybeSingle();
    if (authorError) console.warn('[story reply preview] تعذر تحميل اسم صاحب القصة:', authorError);
    authorName = author?.display_name || author?.full_name || author?.username || null;
  }

  return {
    id: data.id,
    media_url: typeof data.media_url === 'string' && data.media_url ? data.media_url : null,
    media_type: typeof data.media_type === 'string' ? data.media_type : 'image',
    expires_at: typeof data.expires_at === 'string' ? data.expires_at : null,
    author_name: authorName,
  };
}

function requestStoryReplyPreviewMeta(storyId: string): Promise<StoryReplyPreviewMeta> {
  const cached = metaCache.get(storyId);
  if (cached) return Promise.resolve(cached);

  const pending = metaRequests.get(storyId);
  if (pending) return pending;

  const request = loadStoryReplyPreviewMeta(storyId)
    .then(meta => {
      metaCache.set(storyId, meta);
      return meta;
    })
    .finally(() => {
      metaRequests.delete(storyId);
    });
  metaRequests.set(storyId, request);
  return request;
}

/**
 * معاينة الستوري التي رُدّ عليها داخل فقاعة الرسالة:
 * صورة مصغّرة + اسم صاحب القصة، أو «هذه الستوري لم تعد متاحة»
 * عند انتهاء صلاحيتها/حذفها. تعمل مع ردود متعددة على الستوري نفسها.
 */
export default function StoryReplyPreview({ storyId, ownerName, onOpen }: StoryReplyPreviewProps) {
  const [meta, setMeta] = useState<StoryReplyPreviewMeta | null>(() => metaCache.get(storyId) ?? null);
  const [loading, setLoading] = useState(!meta);

  useEffect(() => {
    if (!storyId) return;

    const cached = metaCache.get(storyId);
    if (cached) {
      setMeta(cached);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void requestStoryReplyPreviewMeta(storyId)
      .then(nextMeta => {
        if (active) setMeta(nextMeta);
      })
      .catch(error => {
        console.warn('[story reply preview] تعذر تحميل الستوري:', error);
        if (active) setMeta(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [storyId]);

  const unavailable = !meta || !meta.media_url || isExpired(meta.expires_at);
  const authorLabel = meta?.author_name || ownerName || '';
  const caption = unavailable
    ? 'هذه الستوري لم تعد متاحة'
    : authorLabel
      ? `ستوري ${authorLabel}`
      : 'ستوري';
  const canOpen = Boolean(onOpen) && !unavailable;

  const content = (
    <>
      <span className="relative block h-12 w-9 shrink-0 overflow-hidden rounded-md bg-white/10">
        {loading ? (
          <SkeletonBlock className="absolute inset-0 rounded-none" />
        ) : unavailable || !meta?.media_url ? (
          <span className="flex h-full w-full items-center justify-center text-white/45">
            <ImageOff size={14} />
          </span>
        ) : meta.media_type === 'video' ? (
          <video
            src={meta.media_url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img src={meta.media_url} alt="" className="h-full w-full object-cover" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-right">
        <span className="block truncate text-[10px] font-bold text-white/85">{caption}</span>
        <span className="block truncate text-[9px] text-white/50">
          {unavailable ? 'رد على ستوري' : 'اضغط لعرض القصص'}
        </span>
      </span>
    </>
  );

  const className = 'mb-1 flex w-full max-w-[230px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] p-1.5 text-right';

  if (!canOpen) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button type="button" onClick={onOpen} className={`${className} transition active:scale-[0.99]`}>
      {content}
    </button>
  );
}
