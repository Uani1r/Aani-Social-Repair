import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  STORY_VIEWER_PREVIEW_LIMIT,
  STORY_VIEWER_PREVIEW_TTL_MS,
  type StoryViewerEntry,
  type StoryViewerProfile,
  type StoryViewerPreviewSession,
  type StoryViewerPreviewState,
} from '@/lib/appShared';
import { supabase } from '@/lib/supabase';
import type { StoryRow } from './types';

interface UseStoryViewerDataOptions {
  userId: string;
  currentStory: StoryRow | null;
  storyViewsRequestRef: MutableRefObject<number>;
  setStoryViewers: Dispatch<SetStateAction<StoryViewerEntry[]>>;
  setStoryViewsCount: Dispatch<SetStateAction<number>>;
  setStoryViewerPreview: Dispatch<SetStateAction<StoryViewerPreviewState | null>>;
}

export function useStoryViewerData({
  userId,
  currentStory,
  storyViewsRequestRef,
  setStoryViewers,
  setStoryViewsCount,
  setStoryViewerPreview,
}: UseStoryViewerDataOptions) {
  const loadStoryViewerEntries = useCallback(async (storyId: string, requestId: number) => {
    const [viewsResult, likesResult] = await Promise.all([
      supabase
        .from('story_views')
        .select('user_id, viewed_at, viewer:profiles(id, username, full_name, display_name, avatar_url, is_private)', { count: 'exact' })
        .eq('story_id', storyId)
        .order('viewed_at', { ascending: true }),
      supabase
        .from('story_likes')
        .select('user_id, created_at')
        .eq('story_id', storyId),
    ]);
    if (viewsResult.error) throw viewsResult.error;
    if (likesResult.error) throw likesResult.error;
    if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return null;

    const viewItems = viewsResult.data || [];
    const likeItems = likesResult.data || [];
    const viewedUserIds = new Set(viewItems.map(item => String(item.user_id)));
    const likedUserIds = new Set(likeItems.map(item => String(item.user_id)));
    const viewerIds = [...new Set([
      ...viewItems.map(item => String(item.user_id)),
      ...likeItems.map(item => String(item.user_id)),
    ])];
    const likeOnlyIds = viewerIds.filter(id => !viewedUserIds.has(id));
    const likeOnlyProfiles = new Map<string, StoryViewerProfile>();
    if (likeOnlyIds.length > 0) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, gender, is_private')
        .in('id', likeOnlyIds);
      if (error) {
        console.warn('[story views] تعذر تحميل ملفات من أعجبوا بالقصة:', error);
      } else {
        ((data || []) as StoryViewerProfile[]).forEach(profile => likeOnlyProfiles.set(String(profile.id), profile));
      }
    }
    let followedIds = new Set<string>();
    let pendingIds = new Set<string>();
    if (userId && viewerIds.length > 0) {
      const [followsResult, requestsResult] = await Promise.all([
        supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', userId)
          .in('following_id', viewerIds),
        supabase
          .from('follow_requests')
          .select('recipient_id')
          .eq('requester_id', userId)
          .in('recipient_id', viewerIds),
      ]);
      if (followsResult.error) {
        console.warn('[story views] تعذر تحميل حالات المتابعة:', followsResult.error);
      } else {
        followedIds = new Set((followsResult.data || []).map(item => String(item.following_id)));
      }
      if (requestsResult.error) {
        console.warn('[story views] تعذر تحميل طلبات المتابعة:', requestsResult.error);
      } else {
        pendingIds = new Set((requestsResult.data || []).map(item => String(item.recipient_id)));
      }
    }

    if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return null;
    const likedAtByUser = new Map<string, string>(
      likeItems.map(item => [String(item.user_id), String(item.created_at)] as [string, string]),
    );
    const rows = [
      ...viewItems.map(item => ({
        ...item,
        user_id: String(item.user_id),
        viewed_at: String(item.viewed_at),
        liked_at: likedAtByUser.get(String(item.user_id)) ?? null,
        is_viewer: true,
        is_liked: likedUserIds.has(String(item.user_id)),
        is_following: followedIds.has(String(item.user_id)),
        follow_request_pending: pendingIds.has(String(item.user_id)),
      })),
      ...likeItems
        .filter(item => !viewedUserIds.has(String(item.user_id)))
        .map(item => ({
          user_id: String(item.user_id),
          viewed_at: String(item.created_at),
          liked_at: String(item.created_at),
          is_viewer: false,
          viewer: likeOnlyProfiles.get(String(item.user_id)) ?? null,
          is_liked: true,
          is_following: followedIds.has(String(item.user_id)),
          follow_request_pending: pendingIds.has(String(item.user_id)),
        })),
    ] as StoryViewerEntry[];
    setStoryViewers(rows);
    setStoryViewsCount(viewsResult.count ?? viewItems.length);
    return rows;
  }, [currentStory?.id, setStoryViewers, setStoryViewsCount, storyViewsRequestRef, userId]);

  const loadStoryViewerPreview = useCallback(async (storyId: string, actualViewerIds: string[], requestId: number) => {
    if (!userId) return;
    const storageKey = `aani:story-viewer-preview:${userId}:session`;
    let session: StoryViewerPreviewSession | null = null;

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<StoryViewerPreviewSession>;
        if (
          Array.isArray(parsed.profileIds)
          && parsed.profileIds.every(id => typeof id === 'string')
          && Number.isFinite(parsed.createdAt)
          && Number.isFinite(parsed.expiresAt)
        ) {
          session = {
            profileIds: parsed.profileIds as string[],
            createdAt: parsed.createdAt as number,
            expiresAt: parsed.expiresAt as number,
            expired: parsed.expired === true,
          };
        }
      }
    } catch {
      session = null;
    }

    if (session && (session.expired || session.expiresAt <= Date.now())) {
      const expiredSession: StoryViewerPreviewSession = {
        ...session,
        profileIds: [],
        expired: true,
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(expiredSession));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      setStoryViewerPreview(null);
      return;
    }

    let profileRows: StoryViewerProfile[] = [];
    if (session?.profileIds.length) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, gender')
        .in('id', session.profileIds);
      if (error) throw error;
      const profileById = new Map<string, StoryViewerProfile>(
        ((data || []) as StoryViewerProfile[]).map(profile => [String(profile.id), profile] as [string, StoryViewerProfile]),
      );
      profileRows = session.profileIds
        .map(id => profileById.get(id))
        .filter((profile): profile is StoryViewerProfile => Boolean(profile));
    } else if (!session) {
      const actualIds = new Set(actualViewerIds);
      const pageSize = 100;
      let offset = 0;
      while (profileRows.length < STORY_VIEWER_PREVIEW_LIMIT) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, gender')
          .neq('id', userId)
          .order('created_at', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        const page = (data || []) as StoryViewerProfile[];
        profileRows.push(...page.filter(profile => profile.id !== userId && !actualIds.has(String(profile.id))));
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      profileRows = profileRows.slice(0, STORY_VIEWER_PREVIEW_LIMIT);
      const createdAt = Date.now();
      session = {
        profileIds: profileRows.map(profile => String(profile.id)),
        createdAt,
        expiresAt: createdAt + STORY_VIEWER_PREVIEW_TTL_MS,
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(session));
      } catch {
        /* ستبقى المعاينة مؤقتة لهذه الجلسة فقط */
      }
    }

    if (!session || requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;
    const actualIds = new Set(actualViewerIds);
    const previewRows = profileRows
      .filter(profile => !actualIds.has(String(profile.id)))
      .map((profile, index, profiles) => ({
        user_id: String(profile.id),
        viewed_at: new Date(session!.createdAt - (profiles.length - index) * 60_000).toISOString(),
        viewer: profile,
      }));

    setStoryViewerPreview({
      storyId,
      storageKey,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      rows: previewRows,
    });
  }, [currentStory?.id, setStoryViewerPreview, storyViewsRequestRef, userId]);

  return { loadStoryViewerEntries, loadStoryViewerPreview };
}
