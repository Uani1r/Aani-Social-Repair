import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import {
  Bookmark, CheckCircle2, Heart, Loader2, MessageSquare, Pause, Play, Repeat, RotateCcw, Send, Volume2, VolumeX, X,
} from 'lucide-react';

import Avatar from '@/components/Avatar';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { useFeedVideoGestures } from '@/hooks/useFeedVideoGestures';
import EditPostSheet from '@/components/EditPostSheet';
import PostOptionsSheet from '@/components/PostOptionsSheet';
import PostPrivacySheet from '@/components/PostPrivacySheet';
import ShareSheet from '@/components/ShareSheet';
import UserIdentity from '@/components/UserIdentity';
import PostMetadataChips from '@/components/PostMetadataChips';
import ExpandablePostText from '@/components/ExpandablePostText';
import { recordShare, toggleLike as togglePostLike } from '@/lib/interactions';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { displayName, formatDate, type Post } from '@/lib/types';
import type { PendingPost } from '@/lib/pendingPosts';
import { getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment } from '@/lib/videoMedia';

const hasOpenFeedDialog = () => typeof document !== 'undefined' && Boolean(document.querySelector(
  '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
));

const formatReelTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function ReelSlide({ post, currentUserId, onOpenComments, onRefresh, pendingState, onRetryPending, onDismissPending, onClose, showCreatedAt = false, captionSheet = false }: {
  post: Post;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  pendingState?: PendingPost;
  onRetryPending?: () => void;
  onDismissPending?: () => void;
  onClose?: () => void;
  showCreatedAt?: boolean;
  captionSheet?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const manuallyPausedRef = useRef(false);
  const modalPlaybackStateRef = useRef<{ wasPlaying: boolean; wasMuted: boolean; wasManuallyPaused: boolean } | null>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [captionHasMore, setCaptionHasMore] = useState(false);
  const [showCaptionSheet, setShowCaptionSheet] = useState(false);
  const mediaUrl = post.media_url || '';
  const videoTimeRange = parseVideoTimeRange(mediaUrl);
  const videoCropTransform = getVideoCropTransform(parseVideoCrop(mediaUrl));
  const videoSrc = stripVideoEditFragment(mediaUrl);
  const liked = post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId);
  const likesCount = post.likes_count ?? post.likes?.length ?? 0;
  const likesVisible = !post.hide_likes || post.user_id === currentUserId;
  const commentsVisible = !post.hide_comments || post.user_id === currentUserId;
  const [saved, setSaved] = useState(post.saved_by_me ?? false);
  const [reposted, setReposted] = useState(post.reposted_by_me ?? false);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [showOptionsSheet, setShowOptionsSheet] = useState(false);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [showPrivacySheet, setShowPrivacySheet] = useState(false);
  const [editContent, setEditContent] = useState(post.content || '');
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const {
    dragOffset: captionDragOffset,
    dragging: captionDragging,
    onClickCapture: onCaptionSheetClickCapture,
    onPointerDown: onCaptionSheetPointerDown,
    onTouchStart: onCaptionSheetTouchStart,
    onTouchMove: onCaptionSheetTouchMove,
    onTouchEnd: onCaptionSheetTouchEnd,
    onTouchCancel: onCaptionSheetTouchCancel,
  } = useBottomSheetDismiss(showCaptionSheet, () => setShowCaptionSheet(false));

  // مزامنة أعلام التفاعل غير المعتمدة على مخزن التفاعلات
  useEffect(() => {
    setSaved(post.saved_by_me ?? false);
    setReposted(post.reposted_by_me ?? false);
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.reposted_by_me, post.saved_by_me, post.feedback_by_me]);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !manuallyPausedRef.current && !hasOpenFeedDialog()) {
            video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          } else if (!entry.isIntersecting) {
            video.pause();
            setPlaying(false);
            if (!hasOpenFeedDialog()) manuallyPausedRef.current = false;
          }
        });
      },
      { threshold: 0.6 },
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [videoSrc]);

  useEffect(() => {
    const pauseAndMute = () => {
      const video = videoRef.current;
      if (!video) return;
      if (!modalPlaybackStateRef.current) {
        modalPlaybackStateRef.current = {
          wasPlaying: !video.paused,
          wasMuted: video.muted,
          wasManuallyPaused: manuallyPausedRef.current,
        };
      }
      manuallyPausedRef.current = true;
      video.muted = true;
      setMuted(true);
      video.pause();
    };
    const resumeAfterModal = () => {
      const video = videoRef.current;
      const previousState = modalPlaybackStateRef.current;
      if (!video || !previousState) return;
      modalPlaybackStateRef.current = null;
      video.muted = previousState.wasMuted;
      setMuted(previousState.wasMuted);
      manuallyPausedRef.current = previousState.wasManuallyPaused;
      if (previousState.wasPlaying) void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    };

    window.addEventListener('aani:pause-feed-videos', pauseAndMute);
    window.addEventListener('aani:resume-feed-videos', resumeAfterModal);
    if (hasOpenFeedDialog()) pauseAndMute();
    return () => {
      window.removeEventListener('aani:pause-feed-videos', pauseAndMute);
      window.removeEventListener('aani:resume-feed-videos', resumeAfterModal);
    };
  }, []);

  useLayoutEffect(() => {
    const caption = captionRef.current;
    if (!captionSheet || !post.content || !caption) {
      setCaptionHasMore(false);
      return undefined;
    }

    const measureCaption = () => {
      setCaptionHasMore(caption.scrollHeight > caption.clientHeight + 1);
    };
    measureCaption();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureCaption);
      return () => window.removeEventListener('resize', measureCaption);
    }
    const observer = new ResizeObserver(measureCaption);
    observer.observe(caption);
    return () => observer.disconnect();
  }, [captionSheet, post.content]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      manuallyPausedRef.current = false;
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      manuallyPausedRef.current = true;
      v.pause();
      setPlaying(false);
    }
  };

  const playbackGestures = useFeedVideoGestures(videoRef, true, togglePlay);

  const toggleLike = () => {
    void togglePostLike(post, currentUserId);
  };

  const toggleBookmark = async () => {
    const prevSaved = saved;
    setSaved(!prevSaved);

    if (!supabaseConfigured) return;
    try {
      if (prevSaved) {
        const { error } = await supabase.from('bookmarks').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('bookmarks').insert({ post_id: post.id, user_id: currentUserId });
        if (error) throw error;
      }
    } catch {
      setSaved(prevSaved);
    }
  };

  const toggleRepost = async () => {
    const prevReposted = reposted;
    setReposted(!prevReposted);

    if (!supabaseConfigured) return;
    try {
      if (prevReposted) {
        const { error } = await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        if (error && error.code !== 'PGRST116') throw error;
      } else {
        const { error } = await supabase.from('reposts').insert({ post_id: post.id, user_id: currentUserId });
        // إعادة نشر مسجّلة مسبقًا = الحالة المطلوبة أصلًا
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      setReposted(prevReposted);
    }
  };

  const saveFeedback = async (value: 'interested' | 'not_interested') => {
    if (!supabaseConfigured) return;
    const previousFeedback = feedback;
    const nextFeedback = previousFeedback === value ? null : value;
    setFeedback(nextFeedback);
    try {
      const result = nextFeedback
        ? await supabase.from('post_feedback').upsert({ post_id: post.id, user_id: currentUserId, feedback: nextFeedback }, { onConflict: 'post_id,user_id' })
        : await supabase.from('post_feedback').delete().eq('post_id', post.id).eq('user_id', currentUserId);
      if (result.error) throw result.error;
    } catch {
      setFeedback(previousFeedback);
      alert('تعذر حفظ اختيارك. تأكد من تطبيق ترحيل تفاعلات المنشورات في Supabase.');
    }
  };

  const reportPost = async () => {
    const reason = window.prompt('ما سبب الإبلاغ عن هذا الريل؟');
    if (!reason?.trim() || !supabaseConfigured) return;
    const { error } = await supabase.from('post_reports').insert({
      post_id: post.id,
      reporter_id: currentUserId,
      reason: reason.trim(),
    });
    if (error) {
      alert(error.code === '23505' ? 'سبق أن أبلغت عن هذا الريل.' : 'تعذر إرسال البلاغ. تأكد من تطبيق ترحيل التفاعلات في Supabase.');
      return;
    }
    alert('تم إرسال البلاغ للمراجعة.');
  };

  const getTrimEnd = (video: HTMLVideoElement) => {
    if (!videoTimeRange) return 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoTimeRange.end;
    return Math.min(videoTimeRange.end, duration);
  };

  const seekToTrimStart = (video: HTMLVideoElement) => {
    if (videoTimeRange) {
      const end = getTrimEnd(video);
      video.currentTime = Math.min(videoTimeRange.start, Math.max(0, end - 0.05));
    }
    setPlaybackTime(video.currentTime);
  };

  const handleVideoLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
    seekToTrimStart(video);
  };

  const handleVideoSeeking = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!videoTimeRange) return;
    const end = getTrimEnd(video);
    if (video.currentTime < videoTimeRange.start || video.currentTime > end) {
      seekToTrimStart(video);
    }
  };

  const handleVideoTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setPlaybackTime(video.currentTime);
    if (!videoTimeRange || video.currentTime < getTrimEnd(video) - 0.04) return;
    seekToTrimStart(video);
  };

  const handleVideoPlay = (event: SyntheticEvent<HTMLVideoElement>) => {
    setPlaying(true);
    const video = event.currentTarget;
    setPlaybackTime(video.currentTime);
    if (videoTimeRange && video.currentTime >= getTrimEnd(video) - 0.04) {
      seekToTrimStart(video);
    }
  };

  const handleVideoEnded = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (!videoTimeRange) return;
    seekToTrimStart(event.currentTarget);
    void event.currentTarget.play().catch(() => undefined);
  };

  const timelineStart = videoTimeRange?.start ?? 0;
  const timelineEnd = videoDuration > 0
    ? videoTimeRange ? Math.min(videoTimeRange.end, videoDuration) : videoDuration
    : timelineStart;
  const safePlaybackTime = Math.min(timelineEnd, Math.max(timelineStart, playbackTime));
  const timelineProgress = timelineEnd > timelineStart
    ? ((safePlaybackTime - timelineStart) / (timelineEnd - timelineStart)) * 100
    : 0;

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured || busy) return;
    const content = editContent.trim();
    setBusy(true);
    try {
      let mediaUrl = post.media_url;
      let mediaUrls = post.media_urls?.length ? post.media_urls : (post.media_url ? [post.media_url] : []);
      if (replacementFile) {
        if (!replacementFile.type.startsWith('video/')) throw new Error('اختر ملف فيديو بدلًا من الصورة.');
        const safeName = replacementFile.name.replace(/[^a-zA-Z0-9._-]/g, '-') || 'reel-video';
        const path = `${currentUserId}/${post.id}/edited-${Date.now()}-${safeName}`;
        await uploadMedia({ file: replacementFile, path });
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
        mediaUrls = [mediaUrl];
      }

      const { error } = await supabase.from('posts').update({
        content,
        media_url: mediaUrl,
        media_urls: mediaUrls,
      }).eq('id', post.id).eq('user_id', currentUserId);
      if (error) throw error;
      setShowEditSheet(false);
      setReplacementFile(null);
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'تعذر تعديل الريل. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const deletePost = async () => {
    if (!supabaseConfigured || !window.confirm('هل أنت متأكد من رغبتك في حذف هذا الريل؟')) return;
    const { error } = await supabase.from('posts').delete().eq('id', post.id).eq('user_id', currentUserId);
    if (error) {
      alert('تعذر حذف الريل. حاول مرة أخرى.');
      return;
    }
    onRefresh();
  };

  return (
    <section
      ref={containerRef}
      className="reel-slide relative w-full h-screen overflow-hidden bg-black"
      onPointerDown={playbackGestures.onPointerDown}
      onPointerMove={playbackGestures.onPointerMove}
      onPointerUp={playbackGestures.onPointerUp}
      onPointerCancel={playbackGestures.onPointerCancel}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        loop={!videoTimeRange}
        muted={muted}
        playsInline
        preload="metadata"
        onLoadedMetadata={handleVideoLoadedMetadata}
        onSeeking={handleVideoSeeking}
        onTimeUpdate={handleVideoTimeUpdate}
        onPlay={handleVideoPlay}
        onEnded={handleVideoEnded}
        onDurationChange={event => setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onPause={() => setPlaying(false)}
        className="w-full h-full object-cover cursor-pointer"
        style={{ transform: videoCropTransform, transformOrigin: 'center' }}
      />

      <button
        type="button"
        aria-label={muted ? 'تشغيل الصوت' : 'كتم الصوت'}
        aria-pressed={muted}
        onClick={() => {
          playbackGestures.revealControlsBriefly();
          const nextMuted = !muted;
          setMuted(nextMuted);
          if (videoRef.current) videoRef.current.muted = nextMuted;
        }}
        className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] z-30 grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-md"
      >
        {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
      </button>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق استعراض الريل"
          className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-30 grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-md"
        >
          <X size={20} />
        </button>
      )}

      {pendingState && (
        <div className="absolute inset-x-0 top-0 z-40 bg-black/70 px-4 pb-4 pt-[max(4rem,calc(1rem+env(safe-area-inset-top)))] text-white backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2">
              {pendingState.stage === 'success' ? <CheckCircle2 size={15} className="text-emerald-400" /> : pendingState.stage === 'failed' ? <X size={15} className="text-rose-400" /> : <Loader2 size={15} className="animate-spin text-[#f1a17f]" />}
              {pendingState.stage === 'uploading' ? 'جارٍ رفع الريل' : pendingState.stage === 'publishing' ? 'جارٍ حفظ الريل' : pendingState.stage === 'success' ? 'تم نشر الريل' : 'تعذر نشر الريل'}
            </span>
            {pendingState.stage !== 'failed' && <span>{pendingState.progress}%</span>}
          </div>
          {pendingState.stage !== 'failed' ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-label="تقدم نشر الريل" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pendingState.progress}>
              <div className={`h-full rounded-full transition-[width] duration-200 ${pendingState.stage === 'success' ? 'bg-emerald-400' : 'bg-[#f1a17f]'}`} style={{ width: `${pendingState.progress}%` }} />
            </div>
          ) : (
            <>
              <p role="alert" className="text-xs leading-5 text-rose-200">{pendingState.error || 'حدث خطأ أثناء نشر الريل.'}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={onRetryPending} className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs"><RotateCcw size={13} /> إعادة المحاولة</button>
                <button type="button" onClick={onDismissPending} className="rounded-full px-3 py-1.5 text-xs text-white/70">إزالة</button>
              </div>
            </>
          )}
        </div>
      )}

      {!playing && !playbackGestures.controlsVisible && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[22%] z-10 flex justify-center">
          <div className="rounded-full bg-black/50 p-4 text-white backdrop-blur-md">
            <Play size={30} fill="currentColor" />
          </div>
        </div>
      )}

      {playbackGestures.controlsVisible && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-24 bg-gradient-to-t from-black/90 via-black/45 to-transparent">
            <button
              type="button"
              onClick={() => {
                playbackGestures.revealControlsBriefly();
                togglePlay();
              }}
              className="pointer-events-auto absolute bottom-7 left-1/2 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
              aria-label={playing ? 'إيقاف الفيديو' : 'تشغيل الفيديو'}
            >
              {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
            </button>
            <div className="absolute inset-x-3 bottom-2 flex items-center justify-between text-[11px] text-white/90">
              <span className="tabular-nums">{formatReelTime(Math.max(0, safePlaybackTime - timelineStart))}</span>
              <span className="tabular-nums">{formatReelTime(Math.max(0, timelineEnd - timelineStart))}</span>
            </div>
          </div>
          <div className="feed-video-timeline absolute inset-x-0 bottom-0 z-40 h-[3px] bg-white/30" aria-label="شريط تقدم الفيديو">
            <div className="h-full bg-white" style={{ width: `${timelineProgress}%` }} />
            <input
              type="range"
              min={timelineStart}
              max={timelineEnd > timelineStart ? timelineEnd : timelineStart + 0.1}
              step="0.1"
              value={safePlaybackTime}
              onPointerDown={playbackGestures.revealControlsBriefly}
              onChange={event => {
                const nextTime = Number(event.currentTarget.value);
                setPlaybackTime(nextTime);
                if (videoRef.current) videoRef.current.currentTime = nextTime;
              }}
              className="feed-video-timeline-input"
              aria-label="تقدم الفيديو"
              disabled={videoDuration <= 0}
            />
          </div>
        </>
      )}

      {playbackGestures.acceleratedSide && (
        <div className={`absolute top-1/2 z-40 -translate-y-1/2 rounded-full bg-black/65 px-3 py-1.5 text-sm font-bold text-white backdrop-blur ${playbackGestures.acceleratedSide === 'left' ? 'left-5' : 'right-5'}`} aria-live="polite">
          2x
        </div>
      )}

      {/* تفاصيل الريل أسفل الشاشة */}
      <div className="absolute inset-x-0 bottom-0 pt-24 pb-12 px-4 reel-gradient-bottom z-20 pointer-events-none">
        <div className="flex items-end justify-between gap-4">
          <div className="flex-1 min-w-0 text-white pointer-events-auto">
            <div className="mb-2 flex items-center gap-4">
              <Avatar profile={post.author} />
              <UserIdentity
                name={displayName(post.author)}
                username={post.author?.username}
                className="min-w-0 flex-1"
                nameClassName="text-sm font-bold text-white"
                usernameClassName="text-xs text-zinc-300"
              />
              {showCreatedAt && <time className="reel-created-at">{formatDate(post.created_at)}</time>}
            </div>
            {post.content && (captionSheet ? (
              <div className="mt-2 flex min-w-0 items-end gap-2">
                <p ref={captionRef} className="reel-caption-preview min-w-0 flex-1 text-sm leading-snug">{post.content}</p>
                {captionHasMore && (
                  <button type="button" onClick={() => setShowCaptionSheet(true)} className="shrink-0 text-xs font-bold text-white underline underline-offset-2">
                    عرض المزيد
                  </button>
                )}
              </div>
            ) : (
              <ExpandablePostText text={post.content} className="text-sm leading-snug" />
            ))}
            <PostMetadataChips tags={post.post_metadata || []} className="mt-2" />
          </div>
        </div>
      </div>

      {captionSheet && showCaptionSheet && (
        <div className="fixed inset-0 z-[70] bg-black/65" onClick={() => setShowCaptionSheet(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="reel-caption-sheet-title"
            dir="rtl"
            className="reel-caption-sheet fixed inset-x-0 bottom-0 z-[71] max-h-[70dvh] overflow-y-auto rounded-t-[24px] border border-white/10 bg-[#18181b] px-5 pt-2 text-white shadow-[0_-12px_50px_rgba(0,0,0,0.45)]"
            style={{
              transform: captionDragOffset > 0 ? `translate3d(0, ${captionDragOffset}px, 0)` : undefined,
              transition: captionDragging ? 'none' : 'transform 220ms ease-out',
              paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))',
            }}
            onClick={event => event.stopPropagation()}
          >
            <div
              className="flex w-full touch-none justify-center py-3"
              onClickCapture={onCaptionSheetClickCapture}
              onPointerDown={onCaptionSheetPointerDown}
              onTouchStart={onCaptionSheetTouchStart}
              onTouchMove={onCaptionSheetTouchMove}
              onTouchEnd={onCaptionSheetTouchEnd}
              onTouchCancel={onCaptionSheetTouchCancel}
            >
              <span className="h-1 w-10 rounded-full bg-zinc-600" aria-hidden="true" />
            </div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="reel-caption-sheet-title" className="text-base font-bold">الوصف</h2>
              <button type="button" onClick={() => setShowCaptionSheet(false)} className="rounded-full p-2 text-zinc-300 hover:bg-white/10" aria-label="إغلاق الوصف">
                <X size={18} />
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-100">{post.content}</p>
          </section>
        </div>
      )}

      {/* الأزرار العائمة المرتفعة عن شريط التنقل والمتحركة مع كل فيديو */}
      <div className="absolute right-4 bottom-28 z-30 flex flex-col items-center gap-4">
        {/* 1. الإعجاب */}
        <button onClick={toggleLike} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${liked ? 'text-pink-500' : ''}`}>
            <Heart size={22} fill={liked ? 'currentColor' : 'none'} />
          </span>
          {likesVisible && <span className="text-[11px] font-semibold">{likesCount}</span>}
        </button>

        {/* 2. التعليقات */}
        {commentsVisible && (
          <button onClick={() => onOpenComments(post.id)} className="flex flex-col items-center gap-1 text-white">
            <span className="p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md">
              <MessageSquare size={22} />
            </span>
            <span className="text-[11px] font-bold">
              {post.comments_count ?? post.comments?.length ?? 0}
            </span>
          </button>
        )}

        {/* 3. إعادة النشر */}
        <button onClick={toggleRepost} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${reposted ? 'text-[#E53E3E]' : ''}`}>
            <Repeat size={22} />
          </span>
        </button>

        {/* 4. المشاركة */}
        <button onClick={() => setShowShareSheet(true)} className="flex flex-col items-center gap-1 text-white">
          <span className="p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md">
            <Send size={22} />
          </span>
        </button>

        {/* 5. الحفظ */}
        <button onClick={toggleBookmark} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${saved ? 'text-amber-400' : ''}`}>
            <Bookmark size={22} fill={saved ? 'currentColor' : 'none'} />
          </span>
        </button>

        <PostOptionsSheet
          open={showOptionsSheet}
          onOpenChange={setShowOptionsSheet}
          isOwner={post.user_id === currentUserId}
          feedback={feedback}
          onEdit={() => {
            setEditContent(post.content || '');
            setReplacementFile(null);
            setShowEditSheet(true);
          }}
          onOpenPrivacySettings={() => setShowPrivacySheet(true)}
          onPromote={() => alert('خدمة ترويج المنشورات غير متاحة بعد.')}
          onDelete={() => void deletePost()}
          onReport={() => void reportPost()}
          onFeedback={value => void saveFeedback(value)}
          triggerClassName="border border-white/20 bg-black/40 p-2 text-white backdrop-blur-md"
        />
      </div>

      {showShareSheet && (
        <ShareSheet
          post={post}
          currentUserId={currentUserId}
          reposted={reposted}
          onToggleRepost={toggleRepost}
          onRecordExternalShare={() => void recordShare(post, currentUserId)}
          onClose={() => setShowShareSheet(false)}
        />
      )}

      <EditPostSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        postId={post.id}
        postType={post.type}
        content={editContent}
        onContentChange={setEditContent}
        onSubmit={saveEdit}
        busy={busy}
        onReplacementFileChange={event => setReplacementFile(event.target.files?.[0] || null)}
      />

      <PostPrivacySheet
        open={showPrivacySheet}
        post={post}
        currentUserId={currentUserId}
        onClose={() => setShowPrivacySheet(false)}
        onSaved={onRefresh}
      />
    </section>
  );
}
