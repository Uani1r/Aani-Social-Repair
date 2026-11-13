import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  type StoryViewerEntry,
  type StoryViewerProfile,
} from '@/lib/appShared';
import { supabase } from '@/lib/supabase';
import type { StoryRow } from './types';

interface UseStoryViewerDataOptions {
  userId: string;
  currentStory: StoryRow | null;
  storyViewsRequestRef: MutableRefObject<number>;
  setStoryViewers: Dispatch<SetStateAction<StoryViewerEntry[]>>;
  setStoryViewsCount: Dispatch<SetStateAction<number>>;
}

export function useStoryViewerData({
  userId,
  currentStory,
  storyViewsRequestRef,
  setStoryViewers,
  setStoryViewsCount,
}: UseStoryViewerDataOptions) {
  const loadStoryViewerEntries = useCallback(async (storyId: string, requestId: number) => {
    // story_views الفعلي أعمدته (viewer_id, created_at) — نقرأ عبر منظر
    // story_viewer_entries الذي يعرض user_id/viewed_at بأسمائها المتوقعة.
    // بلا ضميمة مضمّنة: الملفات الشخصية تُجلب بطلب ثانٍ آمن لكل المشاهدين
    // والإعجاب معاً — تجنباً لأي PGRST200 على علاقات PostgREST.
    const [viewsResult, likesResult] = await Promise.all([
      supabase
        .from('story_viewer_entries')
        .select('user_id, viewed_at')
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

    // جلب ملفات كل المشاهدين والأعجاب في طلب واحد آمن (عبر profiles مباشرة)
    const viewerProfiles = new Map<string, StoryViewerProfile>();
    if (viewerIds.length > 0) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, gender, is_private')
        .in('id', viewerIds);
      if (error) {
        console.warn('[story views] تعذر تحميل ملفات المشاهدين والأعجاب:', error);
      } else {
        ((data || []) as StoryViewerProfile[]).forEach(profile => viewerProfiles.set(String(profile.id), profile));
      }
    }
    const profileFor = (id: string): StoryViewerProfile | null => viewerProfiles.get(id) ?? null;

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
        viewer: profileFor(String(item.user_id)),
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
          viewer: profileFor(String(item.user_id)),
          is_liked: true,
          is_following: followedIds.has(String(item.user_id)),
          follow_request_pending: pendingIds.has(String(item.user_id)),
        })),
    ] as StoryViewerEntry[];
    setStoryViewers(rows);
    // عداد العين = كل من فتح القصة + كل من أعجب بها (بدون تكرار) —
    // لا نعتمد على count الجدول وحده حتى لا يفقد إعجابًا بلا سجل مشاهدة.
    setStoryViewsCount(viewerIds.length);
    return rows;
  }, [currentStory?.id, setStoryViewers, setStoryViewsCount, storyViewsRequestRef, userId]);

  return { loadStoryViewerEntries };
}
