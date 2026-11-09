import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Bookmark, CheckCircle2, EyeOff, Flag, Heart, Loader2, MessageSquare, Repeat, RotateCcw, Send, ThumbsUp, X,
} from 'lucide-react';
import { Link } from 'wouter';
import { createPortal } from 'react-dom';

import Avatar from './Avatar';
import LikesListSheet from './LikesListSheet';
import RepostIcon from './RepostIcon';
import FeedReelViewer from './FeedReelViewer';
import ShareSheet from './ShareSheet';
import UserIdentity from './UserIdentity';
import PostMetadataChips from './PostMetadataChips';
import ExpandablePostText from './ExpandablePostText';
import PostImagePreview from './PostImagePreview';
import PostVideoPreview from './PostVideoPreview';
import PostOptionsSheet from './PostOptionsSheet';
import EditPostSheet from './EditPostSheet';
import PostPrivacySheet from './PostPrivacySheet';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { getVideoAspectRatio, parseVideoCrop } from '@/lib/videoMedia';
import { recordShare, usePostInteractions } from '@/lib/interactions';
import { displayName, formatDate, type Post, type Profile } from '@/lib/types';
import type { PendingPost } from '@/lib/pendingPosts';

type FeedPostComment = {
  id: string;
  content: string;
  author: Partial<Profile> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCommentAuthor(value: unknown): Partial<Profile> | null {
  const candidate: unknown = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate)) return null;

  const profile: Partial<Profile> = {};
  if (typeof candidate.id === 'string') profile.id = candidate.id;
  if (typeof candidate.username === 'string') profile.username = candidate.username;
  if (typeof candidate.full_name === 'string') profile.full_name = candidate.full_name;
  if (typeof candidate.display_name === 'string' || candidate.display_name === null) {
    profile.display_name = candidate.display_name;
  }
  if (typeof candidate.avatar_url === 'string' || candidate.avatar_url === null) {
    profile.avatar_url = candidate.avatar_url;
  }
  if (typeof candidate.bio === 'string') profile.bio = candidate.bio;
  if (typeof candidate.is_private === 'boolean') profile.is_private = candidate.is_private;

  return Object.keys(profile).length > 0 ? profile : null;
}

function normalizeFeedPostComments(value: unknown): FeedPostComment[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') return [];
    return [{
      id: item.id,
      content: typeof item.content === 'string' ? item.content : '',
      author: normalizeCommentAuthor(item.author),
    }];
  });
}

export default function FeedPostCard({ post, currentUserId, onRefresh, onOpenComments, pendingState, onRetryPending, onDismissPending, isMainFeed = false, feedVideoPosts, initialVideoIndex = 0 }: {
  post: Post;
  currentUserId: string;
  isMainFeed?: boolean;
  feedVideoPosts?: Post[];
  initialVideoIndex?: number;
  onRefresh: () => void;
  onOpenComments?: (postId: string) => void;
  pendingState?: PendingPost;
  onRetryPending?: () => void;
  onDismissPending?: () => void;
}) {
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState<FeedPostComment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentsCount, setCommentsCount] = useState(post.comments_count || 0);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [editContent, setEditContent] = useState(post.content || '');
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const interactions = usePostInteractions(post, currentUserId);
  const liked = interactions.liked;
  const likesCount = interactions.likes;
  const reposted = interactions.reposted;
  const repostsCount = interactions.reposts;
  const sharesCount = interactions.shares;
  const bookmarked = interactions.bookmarked;
  const isMainFeedVideo = isMainFeed && post.type === 'reel';
  const isMainFeedImage = isMainFeed && post.type === 'photo';

  // Optimistic UI states
  const [isAnimating, setIsAnimating] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [showLikesSheet, setShowLikesSheet] = useState(false);
  const [showOptionsSheet, setShowOptionsSheet] = useState(false);
  const [showPrivacySheet, setShowPrivacySheet] = useState(false);
  const [showMainFeedReel, setShowMainFeedReel] = useState(false);
  const likesVisible = !post.hide_likes || post.user_id === currentUserId;
  const commentsVisible = !post.hide_comments || post.user_id === currentUserId;

  const urls = useMemo(() => {
    if (post.media_urls && post.media_urls.length > 0) return post.media_urls;
    if (post.media_url) return [post.media_url];
    return [];
  }, [post.media_urls, post.media_url]);
  const activeVideoUrl = urls[currentImageIndex] || post.media_url;
  const activeVideoAspectRatio = post.type === 'reel' ? getVideoAspectRatio(parseVideoCrop(activeVideoUrl || '')) : undefined;
  const fullScreenPost = useMemo(() => ({
    ...post,
    media_url: activeVideoUrl,
    media_urls: activeVideoUrl ? [activeVideoUrl] : [],
  }), [post, activeVideoUrl]);

  const [mainFeedReelStartTime, setMainFeedReelStartTime] = useState(0);
  const [feedResumeTime, setFeedResumeTime] = useState<number | undefined>();
  const mainFeedReelTimeRef = useRef(0);

  const openMainFeedReel = (currentTime: number) => {
    const startTime = Number.isFinite(currentTime) ? currentTime : 0;
    mainFeedReelTimeRef.current = startTime;
    setMainFeedReelStartTime(startTime);
    window.dispatchEvent(new Event('aani:pause-feed-videos'));
    setShowMainFeedReel(true);
  };

  const closeMainFeedReel = (currentTime?: number) => {
    const resumeTime = typeof currentTime === 'number' && Number.isFinite(currentTime)
      ? currentTime
      : mainFeedReelTimeRef.current;
    mainFeedReelTimeRef.current = resumeTime;
    const feedVideo = trackRef.current?.children[currentImageIndex]?.querySelector('video');
    if (feedVideo) feedVideo.currentTime = resumeTime;
    setFeedResumeTime(resumeTime);
    setShowMainFeedReel(false);
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('aani:resume-feed-videos')));
  };

  // مزامنة أعلام التفاعل فقط عند تغيّرها فعليًا (وليس مع كل تحديث للعدّادات)
  useEffect(() => {
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.feedback_by_me]);

  // Keep the non-like counters synchronized with the post data.
  useEffect(() => {
    setCommentsCount(post.comments_count || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.comments_count]);

  // عدّاد التعليقات: تحديث فوري من نافذة التعليقات (Optimistic UI) دون إعادة تحميل
  useEffect(() => {
    const onCommentCount = (event: Event) => {
      const detail = (event as CustomEvent<{ postId?: string; count?: number }>).detail;
      if (!detail?.postId || detail.postId !== post.id) return;
      const next = Number(detail.count);
      if (Number.isFinite(next)) setCommentsCount(Math.max(0, next));
    };

    window.addEventListener('aani:comment-count', onCommentCount as EventListener);
    return () => window.removeEventListener('aani:comment-count', onCommentCount as EventListener);
  }, [post.id]);

  const handleScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(Math.abs(el.scrollLeft) / el.clientWidth);
    setCurrentImageIndex(Math.min(idx, urls.length - 1));
  }, [urls.length]);

  const goToImage = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: -i * el.clientWidth, behavior: 'smooth' });
  };

  const toggleLike = () => {
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 450);
    void interactions.toggleLike();
  };

  const toggleRepost = () => {
    void interactions.toggleRepost();
  };

  const toggleBookmark = () => {
    void interactions.toggleBookmark();
  };

  const loadComments = async () => {
    if (onOpenComments) {
      onOpenComments(post.id);
      return;
    }
    if (!supabaseConfigured) return;
    setBusy(true);
    const { data } = await supabase.from('comments').select('id,post_id,user_id,content,created_at,author:profiles(id,username,full_name,display_name,avatar_url)').eq('post_id', post.id).order('created_at', { ascending: true });
    setComments(normalizeFeedPostComments(data));
    setBusy(false);
  };

  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    const value = commentText.trim();
    if (!supabaseConfigured || !value || busy) return;

    // تحديث العداد فورًا (Optimistic UI) قبل انتظار الشبكة
    const previousCount = commentsCount;
    setCommentText('');
    setCommentsCount(previousCount + 1);

    setBusy(true);
    try {
      const { error } = await supabase.from('comments').insert({
        post_id: post.id,
        user_id: currentUserId,
        content: value,
      });
      if (error) throw error;
      await loadComments();
    } catch {
      setCommentsCount(previousCount);
      setCommentText(value);
      alert('تعذر نشر التعليق. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabaseConfigured || busy) return;
    const content = editContent.trim();
    if (post.type === 'text' && !content) {
      alert('لا يمكن أن يكون المنشور النصي فارغًا.');
      return;
    }

    setBusy(true);
    try {
      let mediaUrl = post.media_url;
      let mediaUrls = post.media_urls?.length ? post.media_urls : (post.media_url ? [post.media_url] : []);
      if (replacementFile) {
        const expectedType = post.type === 'photo' ? 'image/' : 'video/';
        if (!replacementFile.type.startsWith(expectedType)) {
          throw new Error(post.type === 'photo' ? 'اختر صورة بدلًا من الفيديو.' : 'اختر فيديو بدلًا من الصورة.');
        }
        const safeName = replacementFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const path = `${currentUserId}/${Date.now()}-${safeName}`;
        await uploadMedia({ file: replacementFile, path });
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
        mediaUrls = [mediaUrl];
      }

      const { error } = await supabase.from('posts').update({
        content,
        media_url: post.type === 'text' ? null : mediaUrl,
        media_urls: post.type === 'text' ? null : mediaUrls,
      }).eq('id', post.id).eq('user_id', currentUserId);
      if (error) throw error;
      setShowEditSheet(false);
      setReplacementFile(null);
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'تعذر تعديل المنشور. حاول مرة أخرى.');
    } finally {
      setBusy(false);
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
      alert('تعذر حفظ اختيارك. حاول مرة أخرى.');
    }
  };

  const reportPost = async () => {
    const reason = window.prompt('ما سبب الإبلاغ عن هذا المنشور؟');
    if (!reason?.trim() || !supabaseConfigured) return;
    const { error } = await supabase.from('post_reports').insert({
      post_id: post.id,
      reporter_id: currentUserId,
      reason: reason.trim(),
    });
    if (error) {
      alert(error.code === '23505' ? 'سبق أن أبلغت عن هذا المنشور.' : 'تعذر إرسال البلاغ. حاول مرة أخرى.');
      return;
    }
    alert('تم إرسال البلاغ للمراجعة.');
  };

  const handleDeletePost = async () => {
    if (!supabaseConfigured) return;
    if (confirm('هل أنت تأكد من رغبتك في حذف هذا المنشور؟')) {
      const { error } = await supabase.from('posts').delete().eq('id', post.id).eq('user_id', currentUserId);
      if (error) {
        alert('تعذر حذف المنشور. حاول مرة أخرى.');
        return;
      }
      onRefresh();
    }
  };

  const handlePromotePost = () => {
    alert('خدمة ترويج المنشورات غير متاحة بعد.');
  };

  return (
    <article className={`post-card fade-up relative ${isMainFeedVideo ? 'video-post-card' : ''} ${isMainFeedImage ? 'main-feed-image-post' : ''}`}>
      {post.repost_attribution && (
        <div className="flex items-center gap-1.5 px-1 pt-2 text-[11px] text-muted-foreground">
          <Repeat size={12} aria-hidden="true" />
          <span>
            قام <Link href={`/profile/${post.repost_attribution.id}`} className="font-bold text-zinc-300 hover:underline">{displayName(post.repost_attribution)}</Link> بإعادة نشر هذا المنشور
          </span>
        </div>
      )}
      <header className={`flex w-full items-start gap-4 ${isMainFeedVideo ? 'video-post-header' : ''}`}>
        <Link
          href={`/profile/${post.user_id}`}
          aria-label={`عرض ملف ${displayName(post.author)}`}
          className="block shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f1a17f]"
        >
          <Avatar profile={post.author} large={!isMainFeedVideo} />
        </Link>
        <div className={`flex min-w-0 flex-1 items-start gap-2 ${isMainFeedVideo ? 'video-post-identity-row' : ''}`}>
          <UserIdentity
            name={<Link href={`/profile/${post.user_id}`} className="hover:underline">{displayName(post.author)}</Link>}
            username={<Link href={`/profile/${post.user_id}`} className="hover:underline">{post.author?.username || 'user'}</Link>}
            className={`min-w-0 flex-1 ${isMainFeedVideo ? 'video-post-identity' : ''}`}
            nameClassName="text-sm font-bold text-foreground"
            usernameClassName="text-xs text-muted-foreground"
          />
          {isMainFeedVideo ? (
            <div className="video-post-top-meta">
              <time>{formatDate(post.created_at)}</time>
              {post.audio_title && <span>♫ {post.audio_title}</span>}
            </div>
          ) : (
            <time className="shrink-0 translate-x-2 whitespace-nowrap text-xs text-muted-foreground">{formatDate(post.created_at)}</time>
          )}
        </div>
        <PostOptionsSheet
          open={showOptionsSheet}
          onOpenChange={setShowOptionsSheet}
          isOwner={post.user_id === currentUserId}
          feedback={feedback}
          triggerClassName={isMainFeedVideo ? 'video-post-options-button' : ''}
          onEdit={() => {
            setEditContent(post.content || '');
            setReplacementFile(null);
            setShowEditSheet(true);
          }}
          onOpenPrivacySettings={() => setShowPrivacySheet(true)}
          onPromote={handlePromotePost}
          onDelete={() => void handleDeletePost()}
          onReport={() => void reportPost()}
          onFeedback={value => void saveFeedback(value)}
        />
      </header>

      {pendingState && (
        <section className={`mt-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 ${isMainFeedVideo ? 'video-post-pending' : ''}`} aria-label="حالة نشر المنشور">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2 text-zinc-200">
              {pendingState.stage === 'success' ? (
                <CheckCircle2 size={15} className="text-emerald-400" />
              ) : pendingState.stage === 'failed' ? (
                <X size={15} className="text-rose-400" />
              ) : (
                <Loader2 size={15} className="animate-spin text-[#f1a17f]" />
              )}
              {pendingState.stage === 'uploading' ? 'جارٍ رفع الوسائط' : pendingState.stage === 'publishing' ? 'جارٍ حفظ المنشور' : pendingState.stage === 'success' ? 'تم نشر المنشور' : 'تعذر نشر المنشور'}
            </span>
            {pendingState.stage !== 'failed' && <span className="text-muted-foreground">{pendingState.progress}%</span>}
          </div>
          {pendingState.stage !== 'failed' && (
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="تقدم النشر" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pendingState.progress}>
              <div className={`h-full rounded-full transition-[width] duration-200 ${pendingState.stage === 'success' ? 'bg-emerald-400' : 'bg-[#f1a17f]'}`} style={{ width: `${pendingState.progress}%` }} />
            </div>
          )}
          {pendingState.stage === 'failed' && (
            <>
              <p role="alert" className="text-xs leading-5 text-rose-300">{pendingState.error || 'حدث خطأ غير متوقع أثناء النشر.'}</p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onRetryPending} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15">
                  <RotateCcw size={13} /> إعادة المحاولة
                </button>
                <button type="button" onClick={onDismissPending} className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-white/5">إزالة</button>
              </div>
            </>
          )}
        </section>
      )}

      {/* معرض الصور التمريري (Carousel Slider) */}
      {urls.length > 0 && (
        <div
          className={isMainFeedImage
            ? 'post-image-container relative mt-3 w-full'
            : isMainFeedVideo
              ? 'feed-video-container mt-3'
              : `relative mt-3 aspect-[4/5] w-full overflow-hidden rounded-xl border-border ${post.type === 'reel' ? 'bg-black' : ''}`}
          style={!isMainFeedVideo && activeVideoAspectRatio ? { aspectRatio: String(activeVideoAspectRatio) } : undefined}
        >
          <div ref={trackRef} onScroll={handleScroll} className="carousel-track h-full">
            {urls.map((url, i) => (
              <div key={i} className="carousel-slide relative h-full">
                {post.type === 'reel' ? (
                  <PostVideoPreview
                    src={url}
                    autoPlayWhenVisible
                    showCustomControls
                    showMuteToggle
                    feedVideo
                    loop
                    restoreTime={i === currentImageIndex ? feedResumeTime : undefined}
                    onExpand={isMainFeedVideo && i === currentImageIndex ? openMainFeedReel : undefined}
                    controls={false}
                    className={isMainFeedVideo ? 'feed-video-element' : 'block h-full w-full object-cover'}
                  />
                ) : (
                  <PostImagePreview
                    src={url}
                    alt=""
                    className={isMainFeedImage ? 'post-image' : 'block h-full w-full select-none object-contain'}
                  />
                )}
              </div>
            ))}
          </div>

          {urls.length > 1 && (
            <>
              <div className="absolute bottom-2 inset-x-0 flex justify-center pointer-events-auto">
                <div className="dots bg-black/50 backdrop-blur px-2 py-1 rounded-full">
                  {urls.map((_, i) => (
                    <button key={i} onClick={() => goToImage(i)} className={`dot ${i === currentImageIndex ? 'active' : ''}`} />
                  ))}
                </div>
              </div>
              <div className="absolute top-2 left-2 text-[10px] bg-black/60 text-white px-2 py-0.5 rounded-full backdrop-blur">
                {currentImageIndex + 1}/{urls.length}
              </div>
            </>
          )}
        </div>
      )}

      {post.content && !isMainFeedVideo && (
        <ExpandablePostText
          text={post.content}
          maxLines={post.type === 'text' ? 7 : 2}
          className="post-content text-sm text-zinc-200 mt-2.5 leading-relaxed"
        />
      )}
      {!isMainFeedVideo && <PostMetadataChips tags={post.post_metadata || []} className="mt-2.5" />}

      {/* شريط الأزرار المتجمع جهة اليمين */}
      <footer className={`border-t border-zinc-800/80 pt-2.5 mt-3 ${isMainFeedVideo ? 'video-post-footer' : ''}`}>
        <div className="post-actions-right flex flex-nowrap items-center gap-4 justify-start w-full overflow-x-auto">
          {/* 1. الإعجاب */}
          <div className={`post-action-btn ${liked ? 'liked text-rose-500 font-bold' : 'text-muted-foreground'}`}>
            <button
              type="button"
              onClick={toggleLike}
              aria-pressed={liked}
              aria-label={liked ? 'إلغاء الإعجاب' : 'إعجاب'}
              className="inline-flex items-center justify-center border-0 bg-transparent p-0 text-inherit"
            >
              <Heart
                size={18}
                fill={liked ? 'currentColor' : 'none'}
                className={`transition-transform ${isAnimating ? 'animate-heart-pulse' : ''}`}
              />
            </button>
            {likesVisible && (post.hide_likes ? (
              <span className="cursor-default text-xs">{likesCount}</span>
            ) : (
              <button
                type="button"
                onClick={() => setShowLikesSheet(true)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-inherit"
                aria-label="عرض قائمة الإعجابات"
              >
                {likesCount}
              </button>
            ))}
          </div>

          {/* 2. التعليقات */}
          {commentsVisible && (
            <button type="button" className="post-action-btn flex items-center gap-1.5 text-muted-foreground hover:text-blue-400 transition" onClick={loadComments}>
              <MessageSquare size={18} />
              <span className="text-xs">{commentsCount}</span>
            </button>
          )}

          {/* 3. إعادة النشر */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${reposted ? 'text-[#FF0000]' : 'text-muted-foreground hover:text-foreground'}`} onClick={toggleRepost} aria-pressed={reposted} aria-label={reposted ? 'إلغاء إعادة النشر' : 'إعادة النشر'}>
            <RepostIcon active={reposted} size={18} />
            <span className="text-xs">{repostsCount}</span>
          </button>

          {/* 4. المشاركة */}
          <button type="button" className="post-action-btn flex items-center gap-1.5 text-muted-foreground transition hover:text-purple-400" onClick={() => setShowShareSheet(true)} aria-label="مشاركة المنشور">
            <Send size={18} />
            <span className="text-xs">{sharesCount}</span>
          </button>

          {/* 5. الحفظ */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${bookmarked ? 'saved text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`} onClick={toggleBookmark} aria-label={bookmarked ? 'إزالة من المحفوظات' : 'حفظ المنشور'}>
            <Bookmark size={18} fill={bookmarked ? 'currentColor' : 'none'} />
          </button>

        </div>

        {comments && (
          <div className="comments-list mt-3 border-t border-border/60 pt-2 w-full">
            {busy && <p className="muted text-xs text-muted-foreground">جاري تحميل التعليقات...</p>}
            {comments.map(c => (
              <p key={c.id} className="text-xs mb-1.5 text-foreground/90 break-words">
                <b className="text-foreground ml-1">{displayName(c.author)}:</b> {c.content}
              </p>
            ))}
            <form className="comment-form flex gap-1.5 mt-2 w-full" onSubmit={addComment}>
              <input className="bg-muted/40 border border-input rounded-lg px-2.5 py-1 text-xs text-foreground w-full outline-none" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="إضافة تعليق..." />
              <button className="button-primary text-xs px-3 py-1 shrink-0" type="submit" disabled={busy || !commentText.trim()}>نشر</button>
            </form>
          </div>
        )}

        {isMainFeedVideo && post.content && (
          <div className="video-post-caption">
            <ExpandablePostText
              text={post.content}
              maxLines={2}
              className="post-content video-post-caption-text"
            />
          </div>
        )}
        {isMainFeedVideo && <PostMetadataChips tags={post.post_metadata || []} className="video-post-metadata" />}
      </footer>

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

      {!post.hide_likes && (
        <LikesListSheet
          postId={post.id}
          currentUserId={currentUserId}
          open={showLikesSheet}
          onClose={() => setShowLikesSheet(false)}
        />
      )}

      {showMainFeedReel && createPortal(
        <FeedReelViewer
          posts={feedVideoPosts?.length
            ? feedVideoPosts.map(videoPost => videoPost.id === post.id ? fullScreenPost : videoPost)
            : [fullScreenPost]}
          initialIndex={initialVideoIndex}
          initialPostId={post.id}
          initialPlaybackTime={mainFeedReelStartTime}
          onPlaybackTimeChange={time => {
            mainFeedReelTimeRef.current = time;
          }}
          currentUserId={currentUserId}
          onOpenComments={postId => {
            if (onOpenComments) onOpenComments(postId);
            else if (postId === post.id) void loadComments();
          }}
          onRefresh={onRefresh}
          onClose={closeMainFeedReel}
        />,
        document.body,
      )}
    </article>
  );
}
