import { Film as FilmIcon } from 'lucide-react';

import ReelSlide from '@/components/ReelSlide';
import { usePosts } from '@/hooks/usePosts';

export default function ReelsPage({ userId, onOpenComments }: { userId: string; onOpenComments: (postId: string) => void }) {
  const { posts, loading } = usePosts('reel', undefined, userId);

  return (
    <div className="reels-container">
      {loading && <div className="status-box text-white pt-20">جاري تحميل الريلز...</div>}
      {!loading && !posts.length && (
        <div className="empty-state text-center py-24 text-white">
          <FilmIcon size={36} className="mx-auto text-pink-500 mb-2" />
          <h2 className="font-bold text-lg">لا يوجد ريلز منشور حالياً</h2>
        </div>
      )}
      {!loading && posts.map(post => <ReelSlide key={post.id} post={post} currentUserId={userId} onOpenComments={onOpenComments} />)}
    </div>
  );
}
