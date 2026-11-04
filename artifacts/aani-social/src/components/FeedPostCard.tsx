import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Bookmark, EyeOff, Flag, Heart, MessageSquare, Repeat, Send, ThumbsUp, Trash2,
} from 'lucide-react';
import { Link } from 'wouter';

import Avatar from './Avatar';
import ShareSheet from './ShareSheet';
import UserIdentity from './UserIdentity';
import PostMetadataChips from './PostMetadataChips';
import ExpandablePostText from './ExpandablePostText';
import PostImagePreview from './PostImagePreview';
import PostOptionsSheet from './PostOptionsSheet';
import EditPostSheet from './EditPostSheet';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { recordShare, toggleLike as togglePostLike } from '@/lib/interactions';
import { displayName, formatDate, type Post, type Profile } from '@/lib/types';

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

export default function FeedPostCard({ post, currentUserId, onRefresh, onOpenComments }: {
  post: Post;
  currentUserId: string;
  onRefresh: () => void;
  onOpenComments?: (postId: string) => void;
}) {
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState<FeedPostComment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentsCount, setCommentsCount] = useState(post.comments_count || 0);
  const [repostsCount, setRepostsCount] = useState(post.reposts_count || 0);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [editContent, setEditContent] = useState(post.content || '');
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const repostBusyRef = useRef(false);
  const liked = post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId);
  const likesCount = post.likes_count ?? post.likes?.length ?? 0;

  // Optimistic UI states
  const [reposted, setReposted] = useState(post.reposted_by_me ?? false);
  const [bookmarked, setBookmarked] = useState(post.saved_by_me ?? false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [showOptionsSheet, setShowOptionsSheet] = useState(false);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [postVisibility, setPostVisibility] = useState(post.visibility ?? 'public');

  const urls = useMemo(() => {
    if (post.media_urls && post.media_urls.length > 0) return post.media_urls;
    if (post.media_url) return [post.media_url];
    return [];
  }, [post.media_urls, post.media_url]);

  // مزامنة أعلام التفاعل فقط عند تغيّرها فعليًا (وليس مع كل تحديث للعدّادات)
  useEffect(() => {
    setReposted(post.reposted_by_me ?? false);
    setBookmarked(post.saved_by_me ?? false);
    setFeedback(post.feedback_by_me || null);
    setPostVisibility(post.visibility ?? 'public');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.reposted_by_me, post.saved_by_me, post.feedback_by_me, post.visibility]);

  // Keep the non-like counters synchronized with the post data.
  useEffect(() => {
    if (!repostBusyRef.current) {
      setRepostsCount(post.reposts_count || 0);
    }
    setCommentsCount(post.comments_count || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.reposts_count, post.comments_count]);

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
    void togglePostLike(post, currentUserId);
  };

  const toggleRepost = async () => {
    if (repostBusyRef.current) return;

    const prevReposted = reposted;
    const prevCount = repostsCount;
    const nextReposted = !prevReposted;

    repostBusyRef.current = true;
    setReposted(nextReposted);
    setRepostsCount(Math.max(0, prevCount + (nextReposted ? 1 : -1)));

    if (!supabaseConfigured) {
      setReposted(prevReposted);
      setRepostsCount(prevCount);
      repostBusyRef.current = false;
      return;
    }

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
      setRepostsCount(prevCount);
    } finally {
      repostBusyRef.current = false;
    }
  };

  const toggleBookmark = async () => {
    const prevBookmarked = bookmarked;
    setBookmarked(!prevBookmarked);

    if (!supabaseConfigured) {
      setBookmarked(prevBookmarked);
      return;
    }
    try {
      if (prevBookmarked) {
        const { error } = await supabase.from('bookmarks').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('bookmarks').insert({ post_id: post.id, user_id: currentUserId });
        if (error) throw error;
      }
    } catch {
      setBookmarked(prevBookmarked);
    }
  };

  const loadComments = async () => {
    if (onOpenComments) {
      onOpenComments(post.id);
      return;
    }
    if (!supabaseConfigured) return;
    setBusy(true);
    const { data } = await supabase.from('comments').select('id,post_id,user_id,content,created_at,author:profiles(id,username,full_name,avatar_url)').eq('post_id', post.id).order('created_at', { ascending: true });
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
        const { error: uploadError } = await supabase.storage.from(storageBucket).upload(path, replacementFile, {
          upsert: true,
          contentType: replacementFile.type,
        });
        if (uploadError) throw uploadError;
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

  const handleTogglePostPrivacy = async () => {
    if (privacySaving) return;
    if (!supabaseConfigured) {
      alert('قاعدة البيانات غير مهيأة.');
      return;
    }
    const previousVisibility = postVisibility;
    const nextVisibility = previousVisibility === 'private' ? 'public' : 'private';
    setPostVisibility(nextVisibility);
    setPrivacySaving(true);
    try {
      const { error } = await supabase
        .from('posts')
        .update({ visibility: nextVisibility })
        .eq('id', post.id)
        .eq('user_id', currentUserId);
      if (error) throw error;
      onRefresh();
    } catch {
      setPostVisibility(previousVisibility);
      alert('تعذر تغيير خصوصية المنشور. تأكد من تطبيق ترحيل قاعدة البيانات ثم حاول مجددًا.');
    } finally {
      setPrivacySaving(false);
    }
  };

  const handlePromotePost = () => {
    alert('خدمة ترويج المنشورات غير متاحة بعد.');
  };

  return (
    <article className="post-card fade-up relative">
      {post.repost_attribution && (
        <div className="flex items-center gap-1.5 px-1 pt-2 text-[11px] text-zinc-500">
          <Repeat size={12} />
          <span>
            أعاد <strong className="font-bold text-zinc-400">{displayName(post.repost_attribution)}</strong> نشر هذا
          </span>
        </div>
      )}
      <header className="flex w-full items-start gap-4">
        <Avatar profile={post.author} large />
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <UserIdentity
            name={<Link href={`/profile/${post.user_id}`} className="hover:underline">{displayName(post.author)}</Link>}
            username={post.author?.username || 'user'}
            className="min-w-0 flex-1"
            nameClassName="text-sm font-bold text-white"
            usernameClassName="text-xs text-zinc-500"
          />
          <time className="shrink-0 translate-x-2 whitespace-nowrap text-xs text-zinc-500">{formatDate(post.created_at)}</time>
        </div>
        <PostOptionsSheet
          open={showOptionsSheet}
          onOpenChange={setShowOptionsSheet}
          isOwner={post.user_id === currentUserId}
          feedback={feedback}
          privacySaving={privacySaving}
          onEdit={() => {
            setEditContent(post.content || '');
            setReplacementFile(null);
            setShowEditSheet(true);
          }}
          onTogglePrivacy={() => void handleTogglePostPrivacy()}
          onPromote={handlePromotePost}
          onDelete={() => void handleDeletePost()}
          onReport={() => void reportPost()}
          onFeedback={value => void saveFeedback(value)}
        />
      </header>

      {post.content && (
        <ExpandablePostText
          text={post.content}
          className="post-content text-sm text-zinc-200 mt-2.5 leading-relaxed"
        />
      )}
      <PostMetadataChips tags={post.post_metadata || []} className="mt-2.5" />

      {/* معرض الصور التمريري (Carousel Slider) */}
      {urls.length > 0 && (
        <div className="relative mt-3 rounded-xl overflow-hidden border border-zinc-800">
          <div ref={trackRef} onScroll={handleScroll} className="carousel-track">
            {urls.map((url, i) => (
              <div key={i} className="carousel-slide">
                {post.type === 'reel' ? (
                  <video src={url} controls className="w-full max-h-[28rem] object-cover" />
                ) : (
                  <PostImagePreview src={url} alt="" className="w-full max-h-[28rem] object-cover select-none" />
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

      {/* شريط الأزرار المتجمع جهة اليمين */}
      <footer className="border-t border-zinc-800/80 pt-2.5 mt-3">
        <div className="post-actions-right flex flex-nowrap items-center gap-4 justify-start w-full overflow-x-auto">
          {/* 1. الإعجاب */}
          <button
            type="button"
            className={`post-action-btn flex items-center gap-1.5 ${liked ? 'liked text-rose-500 font-bold' : 'text-zinc-400'}`}
            onClick={toggleLike}
            aria-pressed={liked}
            aria-label={liked ? 'إلغاء الإعجاب' : 'إعجاب'}
          >
            <Heart
              size={18}
              fill={liked ? 'currentColor' : 'none'}
              className={`transition-transform ${isAnimating ? 'animate-heart-pulse' : ''}`}
            />
            <span className="text-xs">{likesCount}</span>
          </button>

          {/* 2. التعليقات */}
          <button type="button" className="post-action-btn flex items-center gap-1.5 text-zinc-400 hover:text-blue-400 transition" onClick={loadComments}>
            <MessageSquare size={18} />
            <span className="text-xs">{commentsCount}</span>
          </button>

          {/* 3. إعادة النشر */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${reposted ? 'text-[#E53E3E] font-bold' : 'text-zinc-400 hover:text-[#E53E3E]'}`} onClick={toggleRepost} aria-pressed={reposted} aria-label={reposted ? 'إلغاء إعادة النشر' : 'إعادة النشر'}>
            <Repeat size={18} />
            <span className="text-xs">{repostsCount}</span>
          </button>

          {/* 4. المشاركة */}
          <button type="button" className="post-action-btn flex items-center gap-1.5 text-zinc-400 hover:text-purple-400 transition" onClick={() => setShowShareSheet(true)}>
            <Send size={18} />
          </button>

          {/* 5. الحفظ */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${bookmarked ? 'saved text-amber-400' : 'text-zinc-400 hover:text-amber-400'}`} onClick={toggleBookmark}>
            <Bookmark size={18} fill={bookmarked ? 'currentColor' : 'none'} />
          </button>

        </div>

        {comments && (
          <div className="comments-list mt-3 border-t border-zinc-800/40 pt-2 w-full">
            {busy && <p className="muted text-xs text-zinc-500">جاري تحميل التعليقات...</p>}
            {comments.map(c => (
              <p key={c.id} className="text-xs mb-1.5 text-zinc-300 break-words">
                <b className="text-white ml-1">{displayName(c.author)}:</b> {c.content}
              </p>
            ))}
            <form className="comment-form flex gap-1.5 mt-2 w-full" onSubmit={addComment}>
              <input className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-white w-full outline-none" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="إضافة تعليق..." />
              <button className="button-primary text-xs px-3 py-1 shrink-0" type="submit" disabled={busy || !commentText.trim()}>نشر</button>
            </form>
          </div>
        )}
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
    </article>
  );
}
