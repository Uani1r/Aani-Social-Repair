import { useCallback, useEffect, useMemo, useState } from 'react';

import { decoratePost, hydratePostRows, useInteractionsVersion } from '@/lib/interactions';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Post } from '@/lib/types';

export async function hydratePostInteractions(
  posts: Post[],
  currentUserId: string,
): Promise<Post[]> {
  return hydratePostRows(posts, currentUserId);
}

export function usePosts(query: 'feed' | 'reel' | 'profile', targetUserId?: string, currentUserId = '') {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) { setPosts([]); setLoading(false); return; }
    setLoading(true);
    if (query === 'feed') setPosts([]);
    try {
      if (query === 'feed') {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .in('type', ['text', 'photo'])
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        if (rawPosts && rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(p => p.user_id))];
          const { data: profs } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formatted = rawPosts.map(p => ({
            ...p,
            author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم آني' },
            likes: [],
            comments: []
          }));
          setPosts(await hydratePostInteractions(formatted as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'profile' && targetUserId) {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false });

        if (postsErr) throw postsErr;

        // جلب المنشورات التي أعاد المستخدم نشرها لعرضها في ملفه الشخصي
        const { data: repostRows } = await supabase
          .from('reposts')
          .select('post_id, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(50);

        const repostPostIds = (repostRows || []).map(r => r.post_id).filter((id: string) => !(rawPosts || []).some(p => p.id === id));

        let repostedRaw: any[] = [];
        const repostedAtById = new Map<string, string>();
        (repostRows || []).forEach(r => repostedAtById.set(r.post_id, r.created_at));

        if (repostPostIds.length > 0) {
          const { data: originalPosts } = await supabase
            .from('posts')
            .select('id, user_id, content, media_url, media_urls, type, created_at')
            .in('id', repostPostIds);
          repostedRaw = (originalPosts || []).map(p => ({ ...p, reposter_id: targetUserId }));
        }

        const allRaw = [...(rawPosts || []), ...repostedRaw];

        if (allRaw.length > 0) {
          const authorIds = [...new Set(allRaw.map(p => p.user_id))];
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .in('id', authorIds);
          const { data: reposterProf } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .eq('id', targetUserId)
            .maybeSingle();

          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formattedPosts = allRaw
            .map(p => ({
              ...p,
              author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم' },
              repost_attribution: p.reposter_id ? (reposterProf || { id: targetUserId, username: 'user', full_name: 'مستخدم' }) : null,
              likes: [],
              comments: []
            }))
            .sort((a, b) => {
              const aTime = repostedAtById.get(a.id) || a.created_at;
              const bTime = repostedAtById.get(b.id) || b.created_at;
              return new Date(bTime).getTime() - new Date(aTime).getTime();
            });

          setPosts(await hydratePostInteractions(formattedPosts as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'reel') {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .eq('type', 'reel')
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        if (rawPosts && rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(p => p.user_id))];
          const { data: profs } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formatted = rawPosts.map(p => ({
            ...p,
            author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم آني' },
            likes: [],
            comments: []
          }));
          setPosts(await hydratePostInteractions(formatted as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      }
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [query, targetUserId, currentUserId]);

  useEffect(() => {
    void refresh();
    const onPostCreated = () => void refresh();
    window.addEventListener('aani:post-created', onPostCreated);
    return () => window.removeEventListener('aani:post-created', onPostCreated);
  }, [refresh]);

  const interactionVersion = useInteractionsVersion();
  const currentPosts = useMemo(
    () => posts.map((post) => decoratePost(post, currentUserId)),
    [posts, currentUserId, interactionVersion],
  );

  return { posts: currentPosts, loading, refresh };
}
