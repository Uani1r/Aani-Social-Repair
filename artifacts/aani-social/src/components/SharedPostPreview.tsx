import { useEffect, useState } from 'react';
import { Play, Repeat, SendHorizontal, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { postShareUrl } from '@/lib/interactions';
import { displayName, normalizePostMetadata, type PostMetadataTag, type Profile } from '@/lib/types';
import PostMetadataChips from '@/components/PostMetadataChips';

export default function SharedPostPreview({ content, postId }: { content?: string | null; postId?: string | null }) {
  const match = (content || '').match(/^\[post:(\S+)\]([\s\S]*)$/);
  const resolvedId = postId || match?.[1] || '';
  const caption = (match?.[2] || '').trim();
  const [info, setInfo] = useState<{ author: Profile | null; media: string; text: string; type: string; metadata: PostMetadataTag[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(true);
  const [, navigateToPost] = useLocation();

  useEffect(() => {
    let active = true;

    if (!supabaseConfigured || !resolvedId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    void (async () => {
      try {
        const { data: p } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type')
          .eq('id', resolvedId)
          .maybeSingle();

        if (!active) return;

        if (!p) {
          setInfo({ author: null, media: '', text: '', type: 'text', metadata: [] });
          return;
        }

        const { data: a } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .eq('id', p.user_id)
          .maybeSingle();

        if (!active) return;

        const raw = p as { media_urls?: string[] | null; media_url?: string | null; content?: string; type?: string; post_metadata?: unknown };
        const media = (raw.media_urls?.length ? raw.media_urls[0] : raw.media_url) || '';

        setInfo({
          author: (a || null) as Profile | null,
          media,
          text: String(raw.content || ''),
          type: String(raw.type || 'text'),
          metadata: normalizePostMetadata(raw.post_metadata),
        });
      } catch {
        if (active) setInfo({ author: null, media: '', text: '', type: 'text', metadata: [] });
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [resolvedId]);

  if (!resolvedId) return null;

  const shareLink = async () => {
    const url = postShareUrl(resolvedId);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'منشور على آني', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success('تم نسخ رابط المنشور');
    } catch {
      /* ألغى المستخدم المشاركة */
    }
  };

  const isVideo = info?.type === 'reel';

  return (
    <div className="flex w-full items-center gap-2" dir="rtl">
      {/* صورة الناشر خارج الفقاعة يميناً، بمحاذاة وسط كرت الوسائط */}
      <span className="flex h-full shrink-0 items-center">
        {info?.author?.avatar_url ? (
          <img src={info.author.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-[10px] font-bold text-white">
            {info?.author ? displayName(info.author).replace('@', '').charAt(0) : 'آ'}
          </span>
        )}
      </span>

      {/* فقاعة الرسالة: عرض 62% وحدود منقطة رمادية فاتحة */}
      <div
        role="link"
        tabIndex={0}
        onClick={() => navigateToPost(`/post/${resolvedId}`)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            navigateToPost(`/post/${resolvedId}`);
          }
        }}
        className="w-[62%] min-w-0 shrink-0 cursor-pointer overflow-hidden rounded-2xl border-[1.5px] border-dashed border-zinc-300/60 bg-zinc-900/75 transition hover:border-pink-500/60"
      >
        <div className="relative aspect-[4/5] w-full overflow-hidden bg-black">
          {loading ? (
            <div className="h-full w-full animate-pulse bg-zinc-800/80" />
          ) : isVideo && info?.media ? (
            <video
              src={info.media}
              muted={muted}
              autoPlay
              loop
              playsInline
              className="h-full w-full object-cover"
            />
          ) : info?.media ? (
            <img src={info.media} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-pink-600/25 to-violet-600/25 p-3">
              <p className="line-clamp-5 text-center text-[11px] leading-5 text-zinc-100">
                {info?.text || 'منشور على آني'}
              </p>
            </div>
          )}

          {/* شعار/أيقونة أعلى الزاوية */}
          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white backdrop-blur">
            <Repeat size={10} /> آني
          </span>

          {/* زر التشغيل في منتصف الوسائط */}
          {isVideo && !loading && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
                <Play size={16} fill="currentColor" />
              </span>
            </span>
          )}

          {/* زر كتم الصوت أسفل اليسار (للريلز) */}
          {isVideo && !loading && (
            <button
              type="button"
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                setMuted(current => !current);
              }}
              aria-label={muted ? 'إلغاء الكتم' : 'كتم الصوت'}
              className="absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/75"
            >
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          )}
        </div>

        {(info?.text || caption || (info?.metadata.length ?? 0) > 0) && !loading && (
          <div className="space-y-1 px-2 py-1.5">
            {info?.text && (
              <p className="line-clamp-2 text-right text-[11px] leading-4 text-zinc-300">{info.text}</p>
            )}
            {caption && (
              <p className="line-clamp-1 text-right text-[10px] text-zinc-500">{caption}</p>
            )}
            <PostMetadataChips tags={info?.metadata || []} className="gap-1" />
          </div>
        )}

        {!loading && !info && (
          <p className="px-2 py-1.5 text-right text-[11px] text-zinc-400">هذا المنشور لم يعد متاحاً.</p>
        )}
      </div>

      {/* أيقونة المشاركة خارج الفقاعة على اليسار */}
      <button
        type="button"
        onClick={() => void shareLink()}
        aria-label="مشاركة المنشور"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-zinc-300 transition hover:border-pink-500/60 hover:text-white"
      >
        <SendHorizontal size={14} className="rotate-180" />
      </button>
    </div>
  );
}
