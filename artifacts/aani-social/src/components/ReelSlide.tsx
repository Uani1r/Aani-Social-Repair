import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import {
  Bookmark, CheckCircle2, Heart, Loader2, MessageSquare, Play, Repeat, RotateCcw, Send, Volume2, VolumeX, X,
} from 'lucide-react';

import Avatar from '@/components/Avatar';
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
import { displayName, type Post } from '@/lib/types';
import type { PendingPost } from '@/lib/pendingPosts';
import { getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment } from '@/lib/videoMedia';

const hasOpenFeedDialog = () => typeof document !== 'undefined' && Boolean(document.querySelector(
  '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
));

export default function ReelSlide({ post, currentUserId, onOpenComments, onRefresh, pendingState, onRetryPending, onDismissPending }: {
  post: Post;
  currentUserId: string;
  onOpenComments: (postId: string) => void;
  onRefresh: () => void;
  pendingState?: PendingPost;
  onRetryPending?: () => void;
  onDismissPending?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const manuallyPausedRef = useRef(false);
  const modalPlaybackStateRef = useRef<{ wasPlaying: boolean; wasMuted: boolean; wasManuallyPaused: boolean } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
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
    if (!videoTimeRange) return;
    const end = getTrimEnd(video);
    video.currentTime = Math.min(videoTimeRange.start, Math.max(0, end - 0.05));
  };

  const handleVideoLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    seekToTrimStart(event.currentTarget);
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
    if (!videoTimeRange || video.currentTime < getTrimEnd(video) - 0.04) return;
    seekToTrimStart(video);
  };

  const handleVideoPlay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (videoTimeRange && video.currentTime >= getTrimEnd(video) - 0.04) {
      seekToTrimStart(video);
    }
  };

  const handleVideoEnded = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (!videoTimeRange) return;
    seekToTrimStart(event.currentTarget);
    void event.currentTarget.play().catch(() => undefined);
  };

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
    <section ref={containerRef} className="reel-slide relative w-full h-screen overflow-hidden bg-black">
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
        onClick={togglePlay}
        onPause={() => setPlaying(false)}
        className="w-full h-full object-cover cursor-pointer"
        style={{ transform: videoCropTransform, transformOrigin: 'center' }}
      />

      <button
        type="button"
        aria-label={muted ? 'تشغيل الصوت' : 'كتم الصوت'}
        aria-pressed={muted}
        onClick={() => {
          const nextMuted = !muted;
          setMuted(nextMuted);
          if (videoRef.current) videoRef.current.muted = nextMuted;
        }}
        className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] z-30 grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-md"
      >
        {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
      </button>

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

      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-black/50 rounded-full p-5 backdrop-blur-md text-white">
            <Play size={36} fill="currentColor" />
          </div>
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
            </div>
            {post.content && (
              <ExpandablePostText text={post.content} className="text-sm leading-snug" />
            )}
            <PostMetadataChips tags={post.post_metadata || []} className="mt-2" />
          </div>
        </div>
      </div>

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
