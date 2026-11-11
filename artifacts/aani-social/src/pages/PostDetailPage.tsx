import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';

import FeedPostCard from '@/components/FeedPostCard';
import { FeedSkeleton } from '@/components/Skeletons';
import { hydratePostInteractions } from '@/hooks/usePosts';
import { decoratePost, useInteractionsVersion } from '@/lib/interactions';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePostMetadata, type Post } from '@/lib/types';

export default function PostDetailPage({ postId, currentUserId, onOpenComments }: { postId: string; currentUserId: string; onOpenComments: (postId: string, commentId?: string) => void }) {
  const [location] = useLocation();
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const interactionVersion = useInteractionsVersion();
  const visiblePost = useMemo(
    () => (post ? decoratePost(post, currentUserId) : null),
    [post, currentUserId, interactionVersion],
  );

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) {
      setPost(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const loadPost = (includeDestination: boolean) => supabase.from('posts')
        .select(includeDestination
          ? 'id, user_id, content, post_metadata, media_url, media_urls, type, destination, created_at, audio_url, audio_title, sound_id, sound_trim_start, sound_trim_end, trim_start, trim_end'
          : '*')
        .eq('id', postId)
        .maybeSingle();
      let postResult = await loadPost(true);
      if (postResult.error?.code === '42703' || postResult.error?.code === 'PGRST204') {
        postResult = await loadPost(false);
      }
      const { data, error } = postResult;
      if (error || !data) {
        setPost(null);
        return;
      }
      const { data: author } = await supabase.from('profiles')
        .select('id, username, full_name, display_name, avatar_url, gender')
        .eq('id', data.user_id)
        .maybeSingle();
      let postSettings: Pick<Post, 'visibility' | 'hide_likes' | 'hide_comments' | 'comment_privacy'> = {
        visibility: 'public',
        hide_likes: false,
        hide_comments: false,
        comment_privacy: 'public',
      };
      try {
        const { data: settingsRow, error: settingsError } = await supabase.from('posts')
          .select('visibility, hide_likes, hide_comments, comment_privacy')
          .eq('id', postId)
          .maybeSingle();
        if (!settingsError && settingsRow) {
          postSettings = {
            visibility: settingsRow.visibility === 'private' ? 'private' : 'public',
            hide_likes: settingsRow.hide_likes === true,
            hide_comments: settingsRow.hide_comments === true,
            comment_privacy: settingsRow.comment_privacy === 'followers' || settingsRow.comment_privacy === 'custom'
              ? settingsRow.comment_privacy
              : 'public',
          };
        }
      } catch {
        // The post remains viewable when optional privacy migrations are unavailable.
      }
      const hydrated = await hydratePostInteractions([{
        ...data,
        ...postSettings,
        post_metadata: normalizePostMetadata(data.post_metadata),
        author: author || { id: data.user_id, username: '', full_name: '' },
      } as unknown as Post], currentUserId);
      setPost(hydrated[0] || null);
    } catch {
      setPost(null);
    } finally {
      setLoading(false);
    }
  }, [postId, currentUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const commentId = search.get('commentId');
    if (commentId || search.get('showComments') === '1') onOpenComments(postId, commentId || undefined);
  }, [location, onOpenComments, postId]);

  return (
    <section className="new-view mx-auto w-full max-w-lg">
      {loading && <FeedSkeleton count={1} />}
      {!loading && !post && <p className="py-8 text-center text-sm text-zinc-400">هذا المنشور غير متاح.</p>}
      {visiblePost && <FeedPostCard post={visiblePost} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />}
    </section>
  );
}
