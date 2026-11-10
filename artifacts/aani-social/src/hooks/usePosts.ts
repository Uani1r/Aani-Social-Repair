import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { decoratePost, hydratePostRows, useInteractionsVersion } from '@/lib/interactions';
import { handleAppError } from '@/lib/appErrors';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePostMetadata, type Post, type PostRow, type Profile } from '@/lib/types';
import { registerContentRefreshRequest } from '@/lib/contentRefresh';

// ذاكرة مؤقتة على مستوى الوحدة (بديل Keep-Alive/staleTime):
// عند التنقل بين التبويبات (الرئيسية/الريلز/الملف الشخصي) تُركَّب
// الشاشة من جديد لكنها تُهيَّأ فوراً من هذه الذاكرة بلا شاشة
// Skeleton، مع تحديث صامت في الخلفية. الشاشة لا تُصفَّر إلا عند
// السحب للتحديث القسري (Pull to Refresh) أو عند النشر/الريبوست.
const postsCache = new Map<string, Post[]>();

interface RepostRow {
  post_id: string;
  user_id: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPostsPermissionError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  return code === '42501' || /permission denied for table posts|row-level security.*posts|posts.*row-level security/i.test(message);
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
    display_order: typeof value.display_order === 'number' ? value.display_order : 0,
    destination: value.destination === 'reels' ? 'reels' : 'feed',
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
    return [{
      post_id: item.post_id,
      user_id: typeof item.user_id === 'string' ? item.user_id : '',
      created_at: item.created_at,
    }];
  });
}

function normalizePostProfile(value: unknown): Profile | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;

  return {
    id: value.id,
    username: typeof value.username === 'string' ? value.username : '',
    full_name: typeof value.full_name === 'string' ? value.full_name : '',
    display_name: typeof value.display_name === 'string' || value.display_name === null
      ? value.display_name
      : undefined,
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
  return { id, username: '', full_name: fullName, avatar_url: null, bio: '' };
}

async function fetchGlobalReposts(destination: 'feed' | 'reels'): Promise<Post[]> {
  try {
    const { data: repostData, error: repostError } = await supabase
      .from('reposts')
      .select('post_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (repostError) return [];

    const repostRows = normalizeRepostRows(repostData).filter(row => row.user_id);
    if (repostRows.length === 0) return [];

    const postIds = Array.from(new Set(repostRows.map(row => row.post_id)));
    const { data: postData, error: postsError } = await supabase
      .from('posts')
      .select('id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, comments_disabled, audio_url, audio_title, hide_likes, hide_comments, comment_privacy')
      .in('id', postIds);
    if (postsError) return [];

    const originalPosts = (await normalizePostRowsWithVisibility(postData)).filter(post =>
      post.visibility === 'public'
      && post.destination === destination
      && (destination !== 'reels' || post.type === 'reel'),
    );
    const postsById = new Map(originalPosts.map(post => [post.id, post] as const));
    const visibleReposts = repostRows.filter(row => postsById.has(row.post_id));
    if (visibleReposts.length === 0) return [];

    const profileIds = Array.from(new Set([
      ...originalPosts.map(post => post.user_id),
      ...visibleReposts.map(repost => repost.user_id),
    ]));
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, username, full_name, display_name, avatar_url')
      .in('id', profileIds);
    const profiles = profileMap(profileData);

    return visibleReposts.flatMap((repost): Post[] => {
      const post = postsById.get(repost.post_id);
      if (!post) return [];
      return [{
        ...post,
        author: profiles.get(post.user_id) || fallbackProfile(post.user_id, ''),
        reposter_id: repost.user_id,
        reposted_at: repost.created_at,
        repost_attribution: profiles.get(repost.user_id) || fallbackProfile(repost.user_id, ''),
        likes: [],
        comments: [],
      }];
    });
  } catch {
    return [];
  }
}

export async function hydratePostInteractions(
  posts: Post[],
  currentUserId: string,
): Promise<Post[]> {
  return hydratePostRows(posts, currentUserId);
}

export function usePosts(query: 'feed' | 'reel' | 'profile', targetUserId?: string, currentUserId = '') {
  const cacheKey = `${query}:${targetUserId || ''}`;
  const hadCachedPosts = postsCache.has(cacheKey);
  const [posts, setPostsState] = useState<Post[]>(() => postsCache.get(cacheKey) || []);
  const [loading, setLoading] = useState(!hadCachedPosts);
  const [error, setError] = useState('');
  const hadCachedPostsRef = useRef(hadCachedPosts);

  // كل نجاح جلب يُخزَّن في الذاكرة المؤقتة ليُعاد استخدامه عند
  // العودة إلى الشاشة بدون شاشة تحميل.
  const setPosts = useCallback((value: Post[]) => {
    postsCache.set(cacheKey, value);
    setPostsState(value);
  }, [cacheKey]);

  const refresh = useCallback(async (silent = false) => {
    if (!supabaseConfigured) {
      setPosts([]);
      setError('تعذر الاتصال بقاعدة البيانات. تحقق من إعدادات Supabase.');
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    if (query === 'feed' && !silent) setPosts([]);
    try {
      const fetchPostRows = async (
        kind: 'feed' | 'reel' | 'profile',
        profileId?: string,
        postIds?: string[],
        includeProfileOrder = true,
      ) => {
        const selectColumns = kind === 'profile' && includeProfileOrder
          ? 'id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, display_order, likes_count, comments_count, reposts_count, shares_count, comments_disabled, audio_url, audio_title, hide_likes, hide_comments, comment_privacy'
          : 'id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, comments_disabled, audio_url, audio_title, hide_likes, hide_comments, comment_privacy';
        const request = supabase.from('posts').select(selectColumns);
        if (kind === 'profile' && postIds) {
          return request.in('id', postIds).order('created_at', { ascending: false });
        }
        if (kind === 'profile' && includeProfileOrder) {
          return request.eq('user_id', profileId || '')
            .order('display_order', { ascending: true })
            .order('created_at', { ascending: false });
        }
        if (kind === 'profile') {
          return request.eq('user_id', profileId || '').order('created_at', { ascending: false });
        }
        return request.order('created_at', { ascending: false });
      };

      if (query === 'feed') {
        const { data: postData, error: postsErr } = await fetchPostRows('feed');

        if (postsErr) throw postsErr;

        const rawPosts = (await normalizePostRowsWithVisibility(postData))
          .filter(post => post.destination === 'feed');
        let formatted: Post[] = [];
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url').in('id', uIds);
          const profMap = profileMap(profileData);

          formatted = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
            likes: [],
            comments: [],
          }));
        }

        const repostedPosts = await fetchGlobalReposts('feed');
        const feedPosts = [...repostedPosts, ...formatted].sort((first, second) =>
          Date.parse(second.reposted_at || second.created_at) - Date.parse(first.reposted_at || first.created_at),
        );
        setPosts(await hydratePostInteractions(feedPosts, currentUserId));
      } else if (query === 'profile' && targetUserId) {
        let profileRowsResult = await fetchPostRows('profile', targetUserId);
        if (profileRowsResult.error && (/display_order/i.test(profileRowsResult.error.message) || isPostsPermissionError(profileRowsResult.error))) {
          profileRowsResult = await fetchPostRows('profile', targetUserId, undefined, false);
        }
        const { data: postData, error: postsErr } = profileRowsResult;

        if (postsErr) throw postsErr;

        const rawPosts = await normalizePostRowsWithVisibility(postData);

        // جلب المنشورات التي أعاد المستخدم نشرها لعرضها في ملفه الشخصي
        const { data: repostData } = await supabase
          .from('reposts')
          .select('post_id, user_id, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(100);

        const repostRows = normalizeRepostRows(repostData);
        const repostPostIds = repostRows
          .map(row => row.post_id)
          .filter(id => !rawPosts.some(post => post.id === id));

        let repostedRaw: Array<PostRow & { reposter_id: string }> = [];
        const repostedAtById = new Map<string, string>();
        repostRows.forEach(row => repostedAtById.set(row.post_id, row.created_at));

        if (repostPostIds.length > 0) {
          let repostRowsResult = await fetchPostRows('profile', undefined, repostPostIds);
          if (repostRowsResult.error && (/display_order/i.test(repostRowsResult.error.message) || isPostsPermissionError(repostRowsResult.error))) {
            repostRowsResult = await fetchPostRows('profile', undefined, repostPostIds, false);
          }
          repostedRaw = (await normalizePostRowsWithVisibility(repostRowsResult.data)).map(post => ({ ...post, reposter_id: targetUserId }));
        }

        const allRaw: PostRow[] = [...rawPosts, ...repostedRaw];

        if (allRaw.length > 0) {
          const authorIds = [...new Set(allRaw.map(post => post.user_id))];
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url')
            .in('id', authorIds);
          const { data: reposterProfileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url')
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

          const orderedOwnedPosts = formattedPosts
            .filter(post => post.user_id === targetUserId && !post.reposter_id)
            .sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER));
          let ownedPostIndex = 0;
          const postsWithProfileOrder = formattedPosts.map(post => (
            post.user_id === targetUserId && !post.reposter_id
              ? orderedOwnedPosts[ownedPostIndex++] || post
              : post
          ));

          setPosts(await hydratePostInteractions(postsWithProfileOrder, currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'reel') {
        const { data: postData, error: postsErr } = await fetchPostRows('reel');

        if (postsErr) throw postsErr;

        const rawPosts = (await normalizePostRowsWithVisibility(postData))
          .filter(post => post.type === 'reel' && post.destination === 'reels');
        let formatted: Post[] = [];
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url').in('id', uIds);
          const profMap = profileMap(profileData);

          formatted = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
            likes: [],
            comments: [],
          }));
        }

        const repostedPosts = await fetchGlobalReposts('reels');
        const reelPosts = [...repostedPosts, ...formatted].sort((first, second) =>
          Date.parse(second.reposted_at || second.created_at) - Date.parse(first.reposted_at || first.created_at),
        );
        setPosts(await hydratePostInteractions(reelPosts, currentUserId));
      }
    } catch (caughtError) {
      if (!silent) {
        setPostsState([]);
        setError(isPostsPermissionError(caughtError)
          ? 'تعذر قراءة المنشورات بسبب صلاحيات جدول posts. راجع GRANT وسياسات RLS في Supabase لدور authenticated.'
          : 'تعذر تحميل المنشورات. أعد المحاولة بعد لحظات.');
      }
      handleAppError(
        'فشل تحميل المنشورات',
        caughtError,
        'تعذر تحميل المنشورات. راجع التفاصيل التشخيصية ثم أعد المحاولة.',
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }, [query, targetUserId, currentUserId, setPosts]);

  useEffect(() => {
    // عند وجود محتوى محفوظ: تحديث صامت في الخلفية بلا شاشة تحميل؛
    // وإلا جلب عادي أول مرة يظهر فيه السكلتون.
    void refresh(hadCachedPostsRef.current);
    let repostRefreshTimer: number | null = null;
    const onPostCreated = () => void refresh();
    const onRepostChanged = () => {
      if (repostRefreshTimer !== null) window.clearTimeout(repostRefreshTimer);
      repostRefreshTimer = window.setTimeout(() => {
        repostRefreshTimer = null;
        void refresh(true);
      }, 80);
    };
    const onContentRefresh = (event: Event) => {
      if (query !== 'feed' && query !== 'reel') return;
      registerContentRefreshRequest(event, refresh(true));
    };
    window.addEventListener('aani:post-created', onPostCreated);
    window.addEventListener('aani:repost-changed', onRepostChanged);
    window.addEventListener('aani:content-refresh', onContentRefresh);
    return () => {
      if (repostRefreshTimer !== null) window.clearTimeout(repostRefreshTimer);
      window.removeEventListener('aani:post-created', onPostCreated);
      window.removeEventListener('aani:repost-changed', onRepostChanged);
      window.removeEventListener('aani:content-refresh', onContentRefresh);
    };
  }, [refresh]);

  const interactionVersion = useInteractionsVersion();
  const currentPosts = useMemo(
    () => posts.map((post) => decoratePost(post, currentUserId)),
    [posts, currentUserId, interactionVersion],
  );

  return { posts: currentPosts, loading, error, refresh };
}
