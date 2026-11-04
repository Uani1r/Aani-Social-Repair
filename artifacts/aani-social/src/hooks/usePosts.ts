import { useCallback, useEffect, useMemo, useState } from 'react';

import { decoratePost, hydratePostRows, useInteractionsVersion } from '@/lib/interactions';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePostMetadata, type Post, type PostRow, type Profile } from '@/lib/types';

interface RepostRow {
  post_id: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePostRow(value: unknown): PostRow | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.user_id !== 'string'
    || typeof value.created_at !== 'string') {
    return null;
  }

  const mediaUrls = Array.isArray(value.media_urls)
    ? (value.media_urls as unknown[]).filter((url: unknown): url is string => typeof url === 'string')
    : null;

  return {
    id: value.id,
    user_id: value.user_id,
    content: typeof value.content === 'string' ? value.content : '',
    post_metadata: normalizePostMetadata(value.post_metadata),
    media_url: typeof value.media_url === 'string' ? value.media_url : null,
    media_urls: mediaUrls,
    type: value.type === 'photo' || value.type === 'reel' ? value.type : 'text',
    visibility: value.visibility === 'private' ? 'private' : 'public',
    hide_likes: value.hide_likes === true,
    hide_comments: value.hide_comments === true,
    comment_privacy: value.comment_privacy === 'followers' || value.comment_privacy === 'custom'
      ? value.comment_privacy
      : 'public',
    created_at: value.created_at,
    ...(typeof value.reposter_id === 'string' || value.reposter_id === null
      ? { reposter_id: value.reposter_id }
      : {}),
  };
}

function normalizePostRows(value: unknown): PostRow[] {
  if (!Array.isArray(value)) return [];

  return (value as unknown[])
    .map(normalizePostRow)
    .filter((post): post is PostRow => post !== null);
}

async function normalizePostRowsWithVisibility(value: unknown): Promise<PostRow[]> {
  const posts = normalizePostRows(value);
  if (posts.length === 0) return posts;

  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id, visibility, hide_likes, hide_comments, comment_privacy')
      .in('id', posts.map(post => post.id));
    if (error || !Array.isArray(data)) return posts;

    const settingsById = new Map<string, Partial<PostRow>>();
    (data as unknown[]).forEach((row: unknown) => {
      if (!isRecord(row) || typeof row.id !== 'string') return;
      settingsById.set(row.id, {
        visibility: row.visibility === 'private' ? 'private' : 'public',
        hide_likes: row.hide_likes === true,
        hide_comments: row.hide_comments === true,
        comment_privacy: row.comment_privacy === 'followers' || row.comment_privacy === 'custom'
          ? row.comment_privacy
          : 'public',
      });
    });

    return posts.map(post => ({
      ...post,
      ...settingsById.get(post.id),
    }));
  } catch {
    // Keep the feed usable when the visibility migration has not been applied yet.
    return posts;
  }
}

function normalizeRepostRows(value: unknown): RepostRow[] {
  if (!Array.isArray(value)) return [];

  return (value as unknown[]).flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.post_id !== 'string' || typeof item.created_at !== 'string') return [];
    return [{ post_id: item.post_id, created_at: item.created_at }];
  });
}

function normalizePostProfile(value: unknown): Profile | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;

  return {
    id: value.id,
    username: typeof value.username === 'string' ? value.username : 'user',
    full_name: typeof value.full_name === 'string' ? value.full_name : 'مستخدم',
    avatar_url: typeof value.avatar_url === 'string' ? value.avatar_url : null,
    bio: typeof value.bio === 'string' ? value.bio : '',
  };
}

function profileMap(value: unknown): Map<string, Profile> {
  const profiles = new Map<string, Profile>();
  if (!Array.isArray(value)) return profiles;

  (value as unknown[]).forEach((item: unknown) => {
    const profile = normalizePostProfile(item);
    if (profile) profiles.set(profile.id, profile);
  });
  return profiles;
}

function fallbackProfile(id: string, fullName: string): Profile {
  return { id, username: 'user', full_name: fullName, avatar_url: null, bio: '' };
}

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
        const { data: postData, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, created_at')
          .in('type', ['text', 'photo', 'reel'])
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        const rawPosts = await normalizePostRowsWithVisibility(postData);
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = profileMap(profileData);

          const formatted: Post[] = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, 'مستخدم آني'),
            likes: [],
            comments: [],
          }));
          setPosts(await hydratePostInteractions(formatted, currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'profile' && targetUserId) {
        const { data: postData, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false });

        if (postsErr) throw postsErr;

        const rawPosts = await normalizePostRowsWithVisibility(postData);

        // جلب المنشورات التي أعاد المستخدم نشرها لعرضها في ملفه الشخصي
        const { data: repostData } = await supabase
          .from('reposts')
          .select('post_id, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(50);

        const repostRows = normalizeRepostRows(repostData);
        const repostPostIds = repostRows
          .map(row => row.post_id)
          .filter(id => !rawPosts.some(post => post.id === id));

        let repostedRaw: Array<PostRow & { reposter_id: string }> = [];
        const repostedAtById = new Map<string, string>();
        repostRows.forEach(row => repostedAtById.set(row.post_id, row.created_at));

        if (repostPostIds.length > 0) {
          const { data: originalPostData } = await supabase
            .from('posts')
            .select('id, user_id, content, post_metadata, media_url, media_urls, type, created_at')
            .in('id', repostPostIds);
          repostedRaw = (await normalizePostRowsWithVisibility(originalPostData)).map(post => ({ ...post, reposter_id: targetUserId }));
        }

        const allRaw: PostRow[] = [...rawPosts, ...repostedRaw];

        if (allRaw.length > 0) {
          const authorIds = [...new Set(allRaw.map(post => post.user_id))];
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .in('id', authorIds);
          const { data: reposterProfileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .eq('id', targetUserId)
            .maybeSingle();

          const profMap = profileMap(profileData);
          const reposterProfile = normalizePostProfile(reposterProfileData)
            || fallbackProfile(targetUserId, 'مستخدم');

          const formattedPosts: Post[] = allRaw
            .map((post): Post => ({
              ...post,
              author: profMap.get(post.user_id) || fallbackProfile(post.user_id, 'مستخدم'),
              repost_attribution: post.reposter_id ? reposterProfile : null,
              likes: [],
              comments: [],
            }))
            .sort((a, b) => {
              const aTime = repostedAtById.get(a.id) || a.created_at;
              const bTime = repostedAtById.get(b.id) || b.created_at;
              return new Date(bTime).getTime() - new Date(aTime).getTime();
            });

          setPosts(await hydratePostInteractions(formattedPosts, currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'reel') {
        const { data: postData, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, created_at')
          .eq('type', 'reel')
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        const rawPosts = await normalizePostRowsWithVisibility(postData);
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = profileMap(profileData);

          const formatted: Post[] = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, 'مستخدم آني'),
            likes: [],
            comments: [],
          }));
          setPosts(await hydratePostInteractions(formatted, currentUserId));
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
