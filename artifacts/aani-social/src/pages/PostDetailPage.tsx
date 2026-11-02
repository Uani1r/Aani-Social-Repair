import { useCallback, useEffect, useState } from 'react';

import FeedPostCard from '@/components/FeedPostCard';
import { hydratePostInteractions } from '@/hooks/usePosts';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Post } from '@/lib/types';

export default function PostDetailPage({ postId, currentUserId, onOpenComments }: { postId: string; currentUserId: string; onOpenComments: (postId: string) => void }) {
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) {
      setPost(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.from('posts')
        .select('id, user_id, content, media_url, media_urls, type, created_at')
        .eq('id', postId)
        .maybeSingle();
      if (error || !data) {
        setPost(null);
        return;
      }
      const { data: author } = await supabase.from('profiles')
        .select('id, username, full_name, avatar_url')
        .eq('id', data.user_id)
        .maybeSingle();
      const hydrated = await hydratePostInteractions([{
        ...data,
        author: author || { id: data.user_id, username: 'user', full_name: 'مستخدم آني' },
      } as unknown as Post], currentUserId);
      setPost(hydrated[0] || null);
    } catch {
      setPost(null);
    } finally {
      setLoading(false);
    }
  }, [postId, currentUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="new-view mx-auto w-full max-w-lg">
      {loading && <p className="py-8 text-center text-sm text-zinc-400">جارٍ تحميل المنشور...</p>}
      {!loading && !post && <p className="py-8 text-center text-sm text-zinc-400">هذا المنشور غير متاح.</p>}
      {post && <FeedPostCard post={post} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />}
    </section>
  );
}
