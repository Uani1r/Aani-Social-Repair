import { useCallback, useEffect, useState } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Post } from '@/lib/types';

export async function hydratePostInteractions(posts: Post[], currentUserId: string): Promise<Post[]> {
  if (!supabaseConfigured || posts.length === 0) return posts;

  const postIds = posts.map(post => post.id);
  const { data, error } = await supabase.rpc('get_post_interactions', { p_post_ids: postIds });
  if (error) {
    // فشل الـ RPC: نحسب جميع العدّادات مباشرة من الجداول
    // (تعليقات، إعادات نشر، مشاركات، إعجابات) حتى لا تبقى الأرقام صفرًا
    const [likesRes, commentsRes, repostsRes, sharesRes, feedbackRes] = await Promise.all([
      supabase.from('likes').select('post_id,user_id').in('post_id', postIds).limit(20000),
      supabase.from('comments').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('reposts').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_shares').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_feedback').select('post_id,feedback').eq('user_id', currentUserId).in('post_id', postIds),
    ]);

    const countByPostDirect = (rows: any[] | null): Map<string, number> => {
      const counts = new Map<string, number>();
      (rows || []).forEach(row => counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1));
      return counts;
    };

    const likeCounts = countByPostDirect(likesRes.data);
    const commentCounts = countByPostDirect(commentsRes.data);
    const repostCounts = countByPostDirect(repostsRes.data);
    const shareCounts = countByPostDirect(sharesRes.data);
    const likesRows = (likesRes.data || []) as Array<{ post_id: string; user_id: string }>;
    const feedbackByPost = new Map(((feedbackRes.data || []) as any[]).map(row => [row.post_id, row.feedback]));

    return posts.map(post => ({
      ...post,
      likes_count: likeCounts.get(post.id) ?? post.likes_count ?? 0,
      comments_count: commentCounts.get(post.id) ?? post.comments_count ?? 0,
      reposts_count: repostCounts.get(post.id) ?? post.reposts_count ?? 0,
      shares_count: shareCounts.get(post.id) ?? (post as any).shares_count ?? 0,
      liked_by_me: likesRows.some(l => l.post_id === post.id && l.user_id === currentUserId),
      reposted_by_me: Boolean(post.reposted_by_me),
      saved_by_me: Boolean(post.saved_by_me),
      feedback_by_me: (feedbackByPost.get(post.id) as Post['feedback_by_me']) || null,
    }));
  }
  const interactionRows = (data || []) as Array<{
    post_id: string;
    likes_count: number;
    comments_count: number;
    reposts_count: number;
    liked_by_me: boolean;
    reposted_by_me: boolean;
    saved_by_me: boolean;
    feedback_by_me: string | null;
  }>;
  const interactionByPost = new Map(interactionRows.map(row => [row.post_id, row]));

  return posts.map(post => {
    const interaction = interactionByPost.get(post.id);
    return {
      ...post,
      likes_count: Number(interaction?.likes_count || 0),
      comments_count: Number(interaction?.comments_count || 0),
      reposts_count: Number(interaction?.reposts_count || 0),
      liked_by_me: Boolean(interaction?.liked_by_me),
      reposted_by_me: Boolean(interaction?.reposted_by_me),
      saved_by_me: Boolean(interaction?.saved_by_me),
      feedback_by_me: (interaction?.feedback_by_me as Post['feedback_by_me']) || null,
    };
  });
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

  // مزامنة العدّادات في الوقت الفعلي — تُقرأ من الصفوف الحقيقية (RPC) لا من أعمدة قد تتأخر
  useEffect(() => {
    if (!supabaseConfigured) return;

    const timers = new Map<string, number>();

    const reconcileCounters = async (postId: string) => {
      try {
        const { data, error } = await supabase.rpc('get_post_interactions', { p_post_ids: [postId] });
        if (error) return;

        const row = (data || [])[0] as
          | { likes_count?: number | string; comments_count?: number | string; reposts_count?: number | string }
          | undefined;
        if (!row) return;

        setPosts(current =>
          current.map(post =>
            post.id === postId
              ? {
                  ...post,
                  likes_count: Number(row.likes_count ?? post.likes_count ?? 0),
                  comments_count: Number(row.comments_count ?? post.comments_count ?? 0),
                  reposts_count: Number(row.reposts_count ?? post.reposts_count ?? 0),
                }
              : post,
          ),
        );
      } catch {
        /* تعذر الاتصال: نُبقي القيم الحالية دون إرباك الواجهة */
      }
    };

    const channel = supabase
      .channel('aani-post-counters')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts' },
        payload => {
          const row = payload.new as { id?: string };
          if (!row?.id) return;

          const existing = timers.get(row.id);
          if (existing) window.clearTimeout(existing);

          timers.set(
            row.id,
            window.setTimeout(() => {
              timers.delete(row.id);
              void reconcileCounters(row.id as string);
            }, 350),
          );
        },
      )
      .subscribe();

    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      timers.clear();
      void supabase.removeChannel(channel);
    };
  }, []);

  return { posts, loading, refresh };
}
