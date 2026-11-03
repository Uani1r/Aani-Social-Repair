import { useEffect, useRef, useState } from 'react';
import {
  Bookmark, EyeOff, Flag, Heart, MessageSquare, MoreVertical, Play, Repeat, Send, ThumbsUp,
} from 'lucide-react';

import Avatar from '@/components/Avatar';
import ShareSheet from '@/components/ShareSheet';
import UserIdentity from '@/components/UserIdentity';
import { recordShare } from '@/lib/interactions';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Post } from '@/lib/types';

export default function ReelSlide({ post, currentUserId, onOpenComments }: { post: Post; currentUserId: string; onOpenComments: (postId: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const likeBusyRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [liked, setLiked] = useState(post.liked_by_me ?? (post.likes || []).some(l => l.user_id === currentUserId));
  const [likesCount, setLikesCount] = useState(post.likes_count ?? post.likes?.length ?? 0);
  const [saved, setSaved] = useState(post.saved_by_me ?? false);
  const [reposted, setReposted] = useState(post.reposted_by_me ?? false);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  // مزامنة أعلام التفاعل فقط عند تغيّرها فعليًا (وليس مع كل تحديث للعدّادات)
  useEffect(() => {
    setLiked(post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId));
    setSaved(post.saved_by_me ?? false);
    setReposted(post.reposted_by_me ?? false);
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.liked_by_me, post.reposted_by_me, post.saved_by_me, post.feedback_by_me, currentUserId]);

  // عدّاد الإعجاب من قاعدة البيانات، مع عدم إرباك الضغطة أثناء تنفيذ الطلب
  useEffect(() => {
    if (!likeBusyRef.current) {
      setLikesCount(post.likes_count ?? post.likes?.length ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.likes_count]);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          } else {
            video.pause();
            setPlaying(false);
          }
        });
      },
      { threshold: 0.6 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const toggleLike = async () => {
    // حماية من الضغطات السريعة المتتالية
    if (likeBusyRef.current) return;

    const prevLiked = liked;
    const prevCount = likesCount;
    likeBusyRef.current = true;
    setLiked(!prevLiked);
    setLikesCount(Math.max(0, prevLiked ? prevCount - 1 : prevCount + 1));

    if (!supabaseConfigured) {
      likeBusyRef.current = false;
      return;
    }

    try {
      if (prevLiked) {
        const { error } = await supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        // لا يوجد صف إعجاب = الحالة المطلوبة أصلًا
        if (error && error.code !== 'PGRST116') throw error;
      } else {
        const { error } = await supabase.from('likes').insert({ post_id: post.id, user_id: currentUserId });
        // إعجاب مسجّل مسبقًا = الحالة المطلوبة أصلًا (لا تراجع عن الواجهة)
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    } finally {
      likeBusyRef.current = false;
    }
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

  return (
    <section ref={containerRef} className="reel-slide relative w-full h-screen overflow-hidden bg-black">
      <video
        ref={videoRef}
        src={post.media_url || ''}
        loop
        playsInline
        onClick={togglePlay}
        className="w-full h-full object-cover cursor-pointer"
      />

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
            {post.content && <p className="text-sm leading-snug line-clamp-3">{post.content}</p>}
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
          <span className="text-[11px] font-semibold">{likesCount}</span>
        </button>

        {/* 2. التعليقات */}
        <button onClick={() => onOpenComments(post.id)} className="flex flex-col items-center gap-1 text-white">
          <span className="p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md">
            <MessageSquare size={22} />
          </span>
          <span className="text-[11px] font-bold">
            {post.comments_count ?? post.comments?.length ?? 0}
          </span>
        </button>

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

        {/* 6. النقاط الثلاثة خيارات إضافية */}
        <div className="relative">
          <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 rounded-full bg-black/40 border border-white/20 backdrop-blur-md text-white">
            <MoreVertical size={18} />
          </button>

          {menuOpen && (
            <div className="absolute right-10 bottom-0 bg-zinc-900 border border-zinc-800 rounded-xl p-2 w-48 text-xs text-white shadow-2xl z-40">
              <button onClick={() => { void reportPost(); setMenuOpen(false); }} className="flex items-center gap-2 w-full text-red-400 p-2 hover:bg-zinc-800 rounded-lg">
                <Flag size={14} /> إبلاغ عن الريل
              </button>
              <button onClick={() => { void saveFeedback('interested'); setMenuOpen(false); }} className={`flex items-center gap-2 w-full p-2 hover:bg-zinc-800 rounded-lg ${feedback === 'interested' ? 'text-cyan-300' : 'text-zinc-300'}`}>
                <ThumbsUp size={14} /> {feedback === 'interested' ? 'إلغاء مهتم' : 'مهتم'}
              </button>
              <button onClick={() => { void saveFeedback('not_interested'); setMenuOpen(false); }} className={`flex items-center gap-2 w-full p-2 hover:bg-zinc-800 rounded-lg ${feedback === 'not_interested' ? 'text-zinc-100' : 'text-zinc-300'}`}>
                <EyeOff size={14} /> {feedback === 'not_interested' ? 'إلغاء غير مهتم' : 'غير مهتم'}
              </button>
            </div>
          )}
        </div>
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
    </section>
  );
}
