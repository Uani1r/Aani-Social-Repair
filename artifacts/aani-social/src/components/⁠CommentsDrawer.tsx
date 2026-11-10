import React, { useEffect, useState } from 'react';
import { Heart, MessageCircle } from 'lucide-react';
import CommentsDrawer from './CommentsDrawer';
import '@/index.css';

type Post = {
  id: string;
  content: string;
  created_at?: string;
  comments_count?: number;
  likes_count?: number;
  liked_by_me?: boolean;
  likes?: Array<{ user_id: string }>;
  author?: {
    full_name?: string;
    username?: string;
  };
};

function PostCard({
  post,
  currentUserId,
  onRefresh,
  onOpenComments,
}: {
  post: Post;
  currentUserId: string;
  onRefresh: () => void;
  onOpenComments?: (postId: string) => void;
}) {
  const [liked, setLiked] = useState(post.liked_by_me ?? (post.likes || []).some((like) => like.user_id === currentUserId));
  const [likesCount, setLikesCount] = useState(post.likes_count ?? post.likes?.length ?? 0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isLikePending, setIsLikePending] = useState(false);

  const toggleLike = async () => {
    if (isLikePending) return;

    const prevLiked = liked;
    const prevCount = likesCount;
    const nextLiked = !prevLiked;

    setIsLikePending(true);
    setLiked(nextLiked);
    setLikesCount(prevCount + (nextLiked ? 1 : -1));
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 450);

    try {
      // Supabase like action handled here
    } catch (error) {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    } finally {
      setIsLikePending(false);
    }
  };

  const handleOpenComments = () => {
    if (onOpenComments) {
      onOpenComments(post.id);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-white">
      <div className="flex items-center justify-between">
        <div className="font-semibold">{post.author?.full_name || ''}</div>
        <div className="text-xs text-zinc-400">
          {post.created_at ? new Date(post.created_at).toLocaleDateString() : ''}
        </div>
      </div>

      {post.content && <p className="mt-3 text-sm leading-6 text-zinc-200">{post.content}</p>}

      <div className="mt-4 flex items-center gap-3 text-zinc-300">
        <button
          type="button"
          onClick={toggleLike}
          disabled={isLikePending}
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition ${
            liked ? 'bg-pink-500/15 text-pink-300' : 'bg-zinc-800 text-zinc-300'
          }`}
        >
          <Heart size={15} fill={liked ? 'currentColor' : 'none'} className={isAnimating ? 'animate-pulse' : ''} />
          {likesCount}
        </button>

        <button
          type="button"
          onClick={handleOpenComments}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-700"
        >
          <MessageCircle size={15} />
          {post.comments_count ?? 0}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [selectedPostForComments, setSelectedPostForComments] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const currentUserId = "user-id-placeholder";

  return (
    <main className="min-h-screen bg-zinc-950 p-4 text-white dir-rtl">
      <div className="mx-auto max-w-3xl space-y-4">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            currentUserId={currentUserId}
            onRefresh={() => {}}
            onOpenComments={(postId) => setSelectedPostForComments(postId)}
          />
        ))}
      </div>

      {selectedPostForComments && (
        <CommentsDrawer
          postId={selectedPostForComments}
          currentUserId={currentUserId}
          isOpen={Boolean(selectedPostForComments)}
          onClose={() => setSelectedPostForComments(null)}
        />
      )}
    </main>
  );
}
