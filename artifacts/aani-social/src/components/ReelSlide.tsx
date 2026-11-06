import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import {
  Bookmark, CheckCircle2, Heart, Loader2, MessageCircle, RotateCcw, Send, Volume2, VolumeX, X,
} from 'lucide-react';

import Avatar from '@/components/Avatar';
import RepostIcon from '@/components/RepostIcon';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { useFeedVideoGestures } from '@/hooks/useFeedVideoGestures';
import EditPostSheet from '@/components/EditPostSheet';
import PostOptionsSheet from '@/components/PostOptionsSheet';
import PostPrivacySheet from '@/components/PostPrivacySheet';
import ShareSheet from '@/components/ShareSheet';
import UserIdentity from '@/components/UserIdentity';
import PostMetadataChips from '@/components/PostMetadataChips';
import ExpandablePostText from '@/components/ExpandablePostText';
import { recordShare, usePostInteractions } from '@/lib/interactions';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { displayName, formatDate, type Post } from '@/lib/types';
import type { PendingPost } from '@/lib/pendingPosts';
import { getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment } from '@/lib/videoMedia';

const hasOpenFeedDialog = () => typeof document !== 'undefined' && Array.from(document.querySelectorAll(
  '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
)).some(dialog => !dialog.closest('.feed-reel-viewer'));

const formatReelTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function ReelSlide({ post, currentUserId, onOpenComments, onRefresh, pendingState, onRetryPending, onDismissPending, onClose, initialPlaybackTime, onPlaybackTimeChange, showCreatedAt = false, captionSheet = false }: {
  post: Post;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  pendingState?: PendingPost;
  onRetryPending?: () => void;
  onDismissPending?: () => void;
  onClose?: () => void;
  initialPlaybackTime?: number;
  onPlaybackTimeChange?: (currentTime: number) => void;
  showCreatedAt?: boolean;
  captionSheet?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const initialPlaybackAppliedRef = useRef(initialPlaybackTime === undefined);
  const manuallyPausedRef = useRef(false);
  const modalPlaybackStateRef = useRef<{ wasPlaying: boolean; wasManuallyPaused: boolean } | null>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const isOverlayOpen = Boolean(onClose);
  const [isVisible, setIsVisible] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [captionHasMore, setCaptionHasMore] = useState(false);
  const [showCaptionSheet, setShowCaptionSheet] = useState(false);
  const mediaUrl = post.media_url || '';
  const videoTimeRange = parseVideoTimeRange(mediaUrl);
  const videoCropTransform = getVideoCropTransform(parseVideoCrop(mediaUrl));
  const videoSrc = stripVideoEditFragment(mediaUrl);
  const interactions = usePostInteractions(post, currentUserId);
  const liked = interactions.liked;
  const likesCount = interactions.likes;
  const likesVisible = !post.hide_likes || post.user_id === currentUserId;
  const commentsVisible = !post.hide_comments || post.user_id === currentUserId;
  const saved = interactions.bookmarked;
  const reposted = interactions.reposted;
  const repostsCount = interactions.reposts;
  const sharesCount = interactions.shares;
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
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.feedback_by_me]);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const isVisible = entry.isIntersecting && entry.intersectionRatio >= 0.6;
          setIsVisible(isVisible);
          if (isVisible && !manuallyPausedRef.current && !hasOpenFeedDialog()) {
            void video.play().catch(() => undefined);
          } else if (!isVisible) {
            video.pause();
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
    if (!isOverlayOpen) return;
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || manuallyPausedRef.current || hasOpenFeedDialog()) return;

    const bounds = container.getBoundingClientRect();
    const visibleHeight = Math.min(bounds.bottom, window.innerHeight) - Math.max(bounds.top, 0);
    if (visibleHeight < bounds.height * 0.6) return;

    video.muted = muted;
    void video.play().catch(error => {
      console.log('Autoplay issue handled:', error);
    });
  }, [isOverlayOpen, muted, videoSrc]);

  useEffect(() => {
    const pauseForModal = () => {
      const video = videoRef.current;
      if (!video) return;
      if (containerRef.current?.closest('.feed-reel-viewer') && !hasOpenFeedDialog()) return;
      if (!modalPlaybackStateRef.current) {
        modalPlaybackStateRef.current = {
          wasPlaying: !video.paused,
          wasManuallyPaused: manuallyPausedRef.current,
        };
      }
      manuallyPausedRef.current = true;
      video.pause();
    };
    const resumeAfterModal = () => {
      const video = videoRef.current;
      const previousState = modalPlaybackStateRef.current;
      if (!video || !previousState) return;
      modalPlaybackStateRef.current = null;
      manuallyPausedRef.current = previousState.wasManuallyPaused;
      if (previousState.wasPlaying) void video.play().catch(() => undefined);
    };

    window.addEventListener('aani:pause-feed-videos', pauseForModal);
    window.addEventListener('aani:resume-feed-videos', resumeAfterModal);
    if (hasOpenFeedDialog()) pauseForModal();
    return () => {
      window.removeEventListener('aani:pause-feed-videos', pauseForModal);
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

  const startPlayback = () => {
    const video = videoRef.current;
    if (!video || !video.paused) return;
    manuallyPausedRef.current = false;
    void video.play().catch(() => undefined);
  };

  const playbackGestures = useFeedVideoGestures(videoRef, true, startPlayback);

  const toggleLike = () => {
    void interactions.toggleLike();
  };

  const toggleBookmark = () => {
    void interactions.toggleBookmark();
  };

  const toggleRepost = () => {
    void interactions.toggleRepost();
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

  const reportPlaybackTime = (time: number) => {
    setPlaybackTime(time);
    onPlaybackTimeChange?.(time);
  };

  const seekToTime = (video: HTMLVideoElement, requestedTime: number) => {
    const trimStart = videoTimeRange?.start ?? 0;
    const end = videoTimeRange ? getTrimEnd(video) : video.duration;
    const start = Number.isFinite(end) && end > 0
      ? Math.min(trimStart, Math.max(0, end - 0.05))
      : trimStart;
    const maxTime = Number.isFinite(end) && end > start ? Math.max(start, end - 0.05) : start;
    video.currentTime = Math.min(maxTime, Math.max(start, requestedTime));
    reportPlaybackTime(video.currentTime);
  };

  const seekToTrimStart = (video: HTMLVideoElement) => {
    seekToTime(video, videoTimeRange?.start ?? 0);
  };

  const handleVideoLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
    if (!initialPlaybackAppliedRef.current && typeof initialPlaybackTime === 'number' && Number.isFinite(initialPlaybackTime)) {
      initialPlaybackAppliedRef.current = true;
      video.muted = false;
      video.volume = 1;
      setMuted(false);
      seekToTime(video, initialPlaybackTime);
      return;
    }
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
    reportPlaybackTime(video.currentTime);
    if (!videoTimeRange || video.currentTime < getTrimEnd(video) - 0.04) return;
    seekToTrimStart(video);
  };

  const handleVideoPlay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    reportPlaybackTime(video.currentTime);
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
        autoPlay={isOverlayOpen && isVisible}
        muted={muted}
        playsInline
        preload="auto"
        onLoadedMetadata={handleVideoLoadedMetadata}
        onSeeking={handleVideoSeeking}
        onTimeUpdate={handleVideoTimeUpdate}
        onPlay={handleVideoPlay}
        onEnded={handleVideoEnded}
        onDurationChange={event => setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        className="w-full h-full object-cover cursor-pointer"
        style={{ transform: videoCropTransform, transformOrigin: 'center' }}
      />

      <div className="reel-gradient-top" aria-hidden="true" />
      <div className="reel-top-bar" dir="ltr">
        {onClose && (
          <button type="button" onClick={onClose} aria-label="إغلاق استعراض الريل" className="reel-top-button">
            <X size={26} strokeWidth={2} />
          </button>
        )}
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
          className="reel-top-button"
        >
          {muted ? <VolumeX size={26} strokeWidth={2} /> : <Volume2 size={26} strokeWidth={2} />}
        </button>
      </div>

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

      {playbackGestures.controlsVisible && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-24 bg-gradient-to-t from-black/90 via-black/45 to-transparent">
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
                reportPlaybackTime(nextTime);
                if (videoRef.current) videoRef.current.currentTime = nextTime;
              }}
              className="feed-video-timeline-input"
              aria-label="تقدم الفيديو"
              disabled={videoDuration <= 0}
            />
          </div>
        </>
      )}

      <div className="reel-gradient-bottom" aria-hidden="true" />
      {/* معلومات الريل والوصف بمحاذاة أسفل الشاشة */}
      <div className="reel-bottom-info" dir="rtl">
        <div className="reel-account-row">
          <span className="reel-avatar-frame"><Avatar profile={post.author} /></span>
          <UserIdentity
            name={displayName(post.author)}
            username={post.author?.username}
            className="reel-account-identity"
            nameClassName="reel-account-name"
            usernameClassName="reel-account-handle"
          />
          {showCreatedAt && <time className="reel-created-at">{formatDate(post.created_at)}</time>}
        </div>
        {post.content && (captionSheet ? (
          <div className="reel-caption-row">
            <p ref={captionRef} className="reel-caption-preview">{post.content}</p>
            {captionHasMore && (
              <button type="button" onClick={() => setShowCaptionSheet(true)} className="reel-caption-more">
                عرض المزيد
              </button>
            )}
          </div>
        ) : (
          <ExpandablePostText text={post.content} className="reel-description" />
        ))}
        <PostMetadataChips tags={post.post_metadata || []} className="mt-2" />
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

      {/* شريط التفاعلات الجانبي */}
      <div className="reel-sidebar">
        <button type="button" onClick={toggleLike} aria-label="إعجاب" aria-pressed={liked} className={`reel-sidebar-button ${liked ? 'is-liked' : ''}`}>
          <Heart size={26} strokeWidth={2} fill={liked ? 'currentColor' : 'none'} />
          {likesVisible && <span>{likesCount}</span>}
        </button>

        {commentsVisible && (
          <button type="button" onClick={() => onOpenComments(post.id)} aria-label="التعليقات" className="reel-sidebar-button">
            <MessageCircle size={26} strokeWidth={2} />
            <span>{interactions.comments}</span>
          </button>
        )}

        <button type="button" onClick={toggleRepost} aria-label={reposted ? 'إلغاء إعادة النشر' : 'إعادة النشر'} aria-pressed={reposted} className={`reel-sidebar-button ${reposted ? 'is-reposted' : ''}`}>
          <RepostIcon active={reposted} size={26} strokeWidth={2} />
          <span>{repostsCount}</span>
        </button>

        <button type="button" onClick={() => setShowShareSheet(true)} aria-label="مشاركة" className="reel-sidebar-button">
          <Send size={26} strokeWidth={2} />
          <span>{sharesCount}</span>
        </button>

        <button type="button" onClick={toggleBookmark} aria-label="حفظ" aria-pressed={saved} className={`reel-sidebar-button ${saved ? 'is-saved' : ''}`}>
          <Bookmark size={26} strokeWidth={2} fill={saved ? 'currentColor' : 'none'} />
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
          triggerClassName="reel-options-trigger"
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
