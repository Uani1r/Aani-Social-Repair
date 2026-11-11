import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Loader2, Music2, Pause, Play } from 'lucide-react';
import { useLocation } from 'wouter';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { releaseOverlayBackForNavigation } from '@/lib/overlayBack';
import { OPEN_SOUND_EVENT, defaultSoundTitle, useExistingSound, type OpenSoundDetail } from '@/lib/sounds';
import { playInstant, stopInstant } from '@/lib/instantAudio';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, normalizePostMetadata, type Post, type Profile, type Sound } from '@/lib/types';

/**
 * صفحة/قائمة الصوت (نظام الأصوات بنمط TikTok):
 * تُفتح عند النقر على اسم/أيقونة الصوت في أي فيديو وتعرض كل الفيديوهات
 * المرتبطة بنفس sound_id، مع معاينة الصوت وزر «استخدام هذا الصوت».
 * تُستمع لطلب الفتح عبر حدث عام (OPEN_SOUND_EVENT) لتعمل من أي شاشة.
 */
export default function SoundDetailSheet() {
  const [detail, setDetail] = useState<OpenSoundDetail | null>(null);
  const [sound, setSound] = useState<Sound | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  // مؤشر التحميل الفوري: Spinner في نفس المللي ثانية ثم Pause عند أول نغمة صوتية
  const [previewLoading, setPreviewLoading] = useState(false);

  // إغلاق الصفحة: أوقف التشغيل الفوري وأفرغ المشغّل الموحّد
  // (يُعرَّف قبل استخدامه في useOverlayBack أسفله)
  const closeDetail = () => {
    stopInstant();
    setPreviewPlaying(false);
    setPreviewLoading(false);
    setDetail(null);
  };

  // زر الرجوع (الهاتف/المتصفح) يغلق صفحة الصوت ويعيدك لنفس المكان
  useOverlayBack(Boolean(detail), closeDetail);
  const [, navigate] = useLocation();

  // الاستماع لطلب فتح الصوت من مشغلات الريلز/المنشورات
  useEffect(() => {
    const onOpenSound = (event: Event) => {
      const next = (event as CustomEvent<OpenSoundDetail>).detail;
      if (!next?.soundId) return;
      stopInstant();
      setDetail(next);
      setSound(null);
      setPosts(null);
      setLoadError(false);
      setPreviewPlaying(false);
      setPreviewLoading(false);
    };
    window.addEventListener(OPEN_SOUND_EVENT, onOpenSound);
    return () => window.removeEventListener(OPEN_SOUND_EVENT, onOpenSound);
  }, []);

  // تحميل سجل الصوت + صانعه
  useEffect(() => {
    if (!detail || !supabaseConfigured) return;
    let active = true;
    void (async () => {
      try {
        const { data: soundRow, error: soundError } = await supabase
          .from('sounds')
          .select('id, title, source_video_url, creator_id, created_at')
          .eq('id', detail.soundId)
          .maybeSingle();
        if (!active) return;
        if (soundError) throw soundError;
        const resolved: Sound = soundRow
          ? (soundRow as unknown as Sound)
          : {
              id: detail.soundId,
              title: detail.title || defaultSoundTitle(detail.creatorName),
              source_video_url: detail.sourceVideoUrl ?? null,
              creator_id: null,
              created_at: null,
            };
        setSound(resolved);
        if (resolved.creator_id) {
          const { data: creatorRow } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
            .eq('id', resolved.creator_id)
            .maybeSingle();
          if (!active) return;
          if (creatorRow) setSound({ ...resolved, creator: creatorRow as unknown as Profile });
        }
      } catch {
        if (active) {
          setSound({
            id: detail.soundId,
            title: detail.title || defaultSoundTitle(detail.creatorName),
            source_video_url: detail.sourceVideoUrl ?? null,
            creator_id: null,
            created_at: null,
          });
        }
      }
    })();
    return () => { active = false; };
  }, [detail]);

  // كل الفيديوهات المرتبطة بـ sound_id
  useEffect(() => {
    if (!detail || !supabaseConfigured) return;
    let active = true;
    void (async () => {
      try {
        const { data: rows, error: postsError } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, audio_url, audio_title, sound_id, trim_start, trim_end')
          .eq('sound_id', detail.soundId)
          .eq('visibility', 'public')
          .order('created_at', { ascending: false })
          .limit(60);
        if (!active) return;
        if (postsError) throw postsError;
        const safeRows = (rows || []) as unknown[];
        const authorIds = Array.from(new Set(safeRows
          .map(row => (row as Record<string, unknown>).user_id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id))));
        const profiles = new Map<string, Profile>();
        if (authorIds.length > 0) {
          const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
            .in('id', authorIds);
          (Array.isArray(profileRows) ? profileRows : []).forEach(profile => {
            const row = profile as unknown as Record<string, unknown>;
            if (typeof row?.id === 'string') profiles.set(row.id, row as unknown as Profile);
          });
        }
        if (!active) return;
        setPosts(safeRows.map(row => {
          const record = row as Record<string, unknown>;
          const authorId = typeof record.user_id === 'string' ? record.user_id : '';
          return {
            ...(record as unknown as Post),
            post_metadata: normalizePostMetadata(record.post_metadata),
            author: profiles.get(authorId) || { id: authorId, username: '', full_name: '', avatar_url: null, bio: '' },
          } as Post;
        }));
      } catch {
        if (active) {
          setPosts([]);
          setLoadError(true);
        }
      }
    })();
    return () => { active = false; };
  }, [detail]);

  const togglePreview = () => {
    const url = sound?.source_video_url || detail?.sourceVideoUrl || '';
    if (!url) return;
    if (previewPlaying) {
      stopInstant();
      setPreviewPlaying(false);
      return;
    }
    if (previewLoading) return;
    // Optimistic UI عبر المشغّل العالمي الموحّد: Spinner فوراً ثم Pause عند صدور أول نغمة
    setPreviewLoading(true);
    playInstant(url, {
      loop: true,
      onPlaying: () => {
        setPreviewLoading(false);
        setPreviewPlaying(true);
      },
      onEnded: () => {
        setPreviewLoading(false);
        setPreviewPlaying(false);
      },
      onError: () => {
        setPreviewLoading(false);
        setPreviewPlaying(false);
      },
    });
  };

  const handleUseSound = () => {
    if (!detail) return;
    useExistingSound({
      soundId: detail.soundId,
      title: sound?.title || detail.title || defaultSoundTitle(detail.creatorName),
      sourceVideoUrl: sound?.source_video_url || detail.sourceVideoUrl || null,
    });
    closeDetail();
  };

  const openPost = (postId: string) => {
    // حرر مدخل حرس الرجوع ثم أغلق الصفحة ثم انتقل
    releaseOverlayBackForNavigation();
    closeDetail();
    navigate(`/post/${encodeURIComponent(postId)}`);
  };

  if (!detail) return null;

  const title = sound?.title || detail.title || defaultSoundTitle(detail.creatorName);
  const sourceUrl = sound?.source_video_url || detail.sourceVideoUrl || '';
  const creatorName = displayName(sound?.creator || null) || detail.creatorName || '';

  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex flex-col bg-[#0b0b0f] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="تفاصيل الصوت"
      dir="rtl"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 pb-3 pt-[calc(10px+env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={closeDetail}
          aria-label="رجوع"
          className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
        >
          <ArrowRight size={22} />
        </button>
        <h1 className="text-base font-bold">الصوت</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* بطاقة الصوت: معاينة + زر الاستخدام */}
        <section className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <button
            type="button"
            onClick={togglePreview}
            disabled={!sourceUrl}
            aria-label={previewLoading ? 'جارٍ تحميل الصوت' : previewPlaying ? 'إيقاف المعاينة' : 'تشغيل المعاينة'}
            className="grid h-24 w-24 place-items-center rounded-full bg-gradient-to-br from-[#f1a17f] to-[#e58b66] text-black shadow-lg transition disabled:opacity-40 hover:brightness-105"
          >
            {previewLoading
              ? <Loader2 size={30} className="animate-spin" />
              : previewPlaying ? <Pause size={30} /> : <Play size={30} className="translate-x-0.5" />}
          </button>
          <div className="min-w-0">
            <p className="break-words text-lg font-bold leading-6">{title}</p>
            {creatorName && <p className="mt-1 text-xs text-zinc-400">{creatorName}</p>}
          </div>
          <button
            type="button"
            onClick={handleUseSound}
            className="mt-1 flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-zinc-900 transition hover:bg-zinc-200"
          >
            <Music2 size={16} />
            استخدام هذا الصوت
          </button>
        </section>

        {/* الفيديوهات المرتبطة بنفس الصوت */}
        <section className="border-t border-white/10 px-4 py-4">
          <h2 className="mb-3 text-sm font-bold text-zinc-200">الفيديوهات</h2>
          {posts === null && <ListSkeleton count={5} avatarClass="h-12 w-12" className="px-1 py-1" />}
          {posts !== null && posts.length === 0 && (
            <div className="py-6">
              <EmptyState />
            </div>
          )}
          {posts !== null && posts.length > 0 && (
            <ul>
              {posts.map(post => (
                <li key={post.id}>
                  <button
                    type="button"
                    onClick={() => openPost(post.id)}
                    className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-2 py-2 text-right transition hover:bg-white/[0.06]"
                  >
                    <Avatar profile={post.author} />
                    <UserIdentity
                      name={displayName(post.author)}
                      username={post.author?.username ?? null}
                      className="min-w-0 flex-1"
                      nameClassName="text-sm font-semibold text-white"
                      usernameClassName="text-xs text-zinc-500"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loadError && (
            <p role="alert" className="py-4 text-center text-sm text-rose-300">تعذر تحميل فيديوهات الصوت. حاول مرة أخرى.</p>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
