import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bookmark, Clapperboard, FileText, Image as ImageIcon, Layers, X,
} from 'lucide-react';

import FeedPostCard from './FeedPostCard';
import { useSavedPosts } from '../lib/interactions';
import { displayName, type Post } from '../lib/types';
import { stripVideoEditFragment } from '../lib/videoMedia';

interface SavedPostsViewProps {
  currentUserId: string;
  onOpenComments?: (postId: string, initialCount?: number) => void;
}

type SavedCategory = 'all' | Post['type'];

const categories: { id: SavedCategory; label: string; icon: typeof Layers }[] = [
  { id: 'all', label: 'الكل', icon: Layers },
  { id: 'text', label: 'المنشورات', icon: FileText },
  { id: 'photo', label: 'الصور', icon: ImageIcon },
  { id: 'reel', label: 'الريلز', icon: Clapperboard },
];

function getPostMedia(post: Post) {
  const mediaUrls = (post.media_urls || []).filter(Boolean);
  if (mediaUrls.length === 0 && post.media_url) mediaUrls.push(post.media_url);
  return mediaUrls;
}

function SavedPostTile({ post, onOpen }: { post: Post; onOpen: (post: Post) => void }) {
  const mediaUrls = getPostMedia(post);
  const mediaUrl = mediaUrls[0];
  const caption = post.content?.trim();
  const textWords = caption?.split(/\s+/).filter(Boolean) ?? [];
  const textPreview = textWords.slice(0, 2).join(' ');
  const authorName = displayName(post.author);

  return (
    <button
      type="button"
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(post);
      }}
      aria-label={`فتح منشور ${authorName}`}
      className="group relative aspect-[4/5] w-full min-w-0 overflow-hidden rounded-xl border border-white/[0.08] bg-[#17171b] p-0 text-right shadow-sm transition duration-200 hover:border-white/20 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f1a17f]"
    >
      {post.type === 'text' ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-[#30231e] via-[#1b1a20] to-[#17171b] p-3 text-center sm:p-4">
          <FileText size={18} className="mb-2 shrink-0 text-[#f1a17f]" aria-hidden="true" />
          <span className="line-clamp-2 w-full break-words text-[11px] leading-5 text-zinc-100 sm:text-sm sm:leading-6">
            {textPreview ? `${textPreview}${textWords.length > 2 ? '…' : ''}` : 'منشور نصي'}
          </span>
        </span>
      ) : mediaUrl && post.type === 'photo' ? (
        <img
          src={mediaUrl}
          alt={caption ? `صورة من منشور ${authorName}` : 'صورة منشورة'}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
        />
      ) : mediaUrl && post.type === 'reel' ? (
        <>
          <video
            src={stripVideoEditFragment(mediaUrl)}
            muted
            playsInline
            preload="metadata"
            aria-label="معاينة ريل محفوظ"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
          <span className="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-black/45 text-white backdrop-blur-sm">
            <Clapperboard size={15} aria-hidden="true" />
          </span>
        </>
      ) : (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-800 to-zinc-950 text-zinc-400">
          {post.type === 'reel' ? <Clapperboard size={23} /> : <ImageIcon size={23} />}
          <span className="text-[10px]">{post.type === 'reel' ? 'ريل محفوظ' : 'صورة محفوظة'}</span>
        </span>
      )}

      {mediaUrls.length > 1 && (
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-white/15 bg-black/55 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm">
          <Layers size={12} aria-hidden="true" />
          {mediaUrls.length}
        </span>
      )}
    </button>
  );
}

export default function SavedPostsView({
  currentUserId,
  onOpenComments,
}: SavedPostsViewProps) {
  const { posts, loading, error, refresh } = useSavedPosts(currentUserId);
  const [activeCategory, setActiveCategory] = useState<SavedCategory>('all');
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);

  const filteredPosts = useMemo(
    () => activeCategory === 'all' ? posts : posts.filter(post => post.type === activeCategory),
    [activeCategory, posts],
  );
  const selectedPostId = selectedPost?.id;

  useEffect(() => {
    if (!selectedPost) return;
    const currentPost = posts.find(post => post.id === selectedPost.id);
    if (!currentPost) {
      setSelectedPost(null);
    } else if (currentPost !== selectedPost) {
      setSelectedPost(currentPost);
    }
  }, [posts, selectedPost]);

  useEffect(() => {
    if (!selectedPostId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedPost(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedPostId]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4" dir="rtl">
      <nav aria-label="تصنيفات العناصر المحفوظة" className="-mx-1 overflow-x-auto border-b border-white/10 px-1">
        <div className="flex min-w-max items-stretch gap-1">
          {categories.map(({ id, label, icon: Icon }) => {
            const count = id === 'all' ? posts.length : posts.filter(post => post.type === id).length;
            const selected = activeCategory === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveCategory(id)}
                aria-pressed={selected}
                className={`relative flex min-h-12 items-center gap-2 px-3 text-sm font-semibold transition-colors sm:px-4 ${
                  selected ? 'text-white' : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <Icon size={16} className={selected ? 'text-[#f1a17f]' : ''} aria-hidden="true" />
                <span>{label}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${selected ? 'bg-[#f1a17f]/15 text-[#f1a17f]' : 'bg-white/[0.06] text-zinc-500'}`}>
                  {count.toLocaleString('ar-EG')}
                </span>
                {selected && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-gradient-to-l from-[#f1a17f] to-[#e87979]" />}
              </button>
            );
          })}
        </div>
      </nav>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-rose-500/20 bg-rose-950/20 p-4 text-sm text-rose-200">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()} className="shrink-0 rounded-full bg-rose-500/15 px-3 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-500/25">
            إعادة المحاولة
          </button>
        </div>
      )}

      {loading && posts.length === 0 ? (
        <div role="status" aria-label="جارٍ تحميل العناصر المحفوظة" className="grid grid-cols-3 gap-1.5 sm:gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="aspect-[4/5] animate-pulse rounded-xl border border-white/[0.06] bg-zinc-900" />
          ))}
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-10 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#f1a17f]/15 bg-[#f1a17f]/[0.08] text-[#f1a17f]">
            <Bookmark size={24} aria-hidden="true" />
          </span>
          <h3 className="text-base font-bold text-zinc-200">
            {posts.length === 0 ? 'لا توجد عناصر محفوظة بعد' : 'لا توجد عناصر في هذا التصنيف'}
          </h3>
          <p className="mt-2 max-w-xs text-xs leading-6 text-zinc-500">
            {posts.length === 0
              ? 'احفظ المنشورات التي تهمك لتجدها هنا بسهولة.'
              : 'ستظهر هنا العناصر المحفوظة من هذا النوع.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:gap-2" aria-label="شبكة العناصر المحفوظة">
          {filteredPosts.map(post => (
            <SavedPostTile key={post.id} post={post} onOpen={selected => setSelectedPost(selected)} />
          ))}
        </div>
      )}

      {selectedPost && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 p-0 backdrop-blur-sm sm:p-6"
          onClick={event => {
            if (event.currentTarget === event.target) setSelectedPost(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="عرض المنشور المحفوظ"
            className="relative max-h-[100dvh] w-full max-w-[450px] overflow-y-auto sm:max-h-[calc(100dvh-3rem)]"
          >
            <div className="sticky top-0 z-20 flex items-center justify-between bg-black/90 px-4 py-2.5 backdrop-blur">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                <Bookmark size={16} className="text-[#f1a17f]" aria-hidden="true" />
                <span>المنشور المحفوظ</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPost(null)}
                aria-label="إغلاق المنشور"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                <X size={19} />
              </button>
            </div>
            <FeedPostCard
              post={selectedPost}
              currentUserId={currentUserId}
              isMainFeed
              feedVideoPosts={selectedPost.type === 'reel' ? [selectedPost] : undefined}
              initialVideoIndex={0}
              onRefresh={() => void refresh()}
              onOpenComments={onOpenComments}
            />
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
