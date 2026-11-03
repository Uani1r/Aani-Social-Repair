import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import {
  normalizeStoryAuthor,
  normalizeStoryRow,
  type StoriesByUser,
  type StoryAuthor,
  type StoryRow,
} from './types';

interface UseStoriesDataOptions {
  userId: string;
  pendingProfileStoryOwnerId: string | null;
  onProfileStoryHandled: () => void;
  setGroupedStories: Dispatch<SetStateAction<StoriesByUser>>;
  setProfileStoryOwnerId: Dispatch<SetStateAction<string | null>>;
  setProfilePreviewStories: Dispatch<SetStateAction<StoryRow[]>>;
  setActiveUserGroup: Dispatch<SetStateAction<string | null>>;
  setActiveStoryIndex: Dispatch<SetStateAction<number>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setCurrentTimeSec: Dispatch<SetStateAction<number>>;
}

export function useStoriesData({
  userId,
  pendingProfileStoryOwnerId,
  onProfileStoryHandled,
  setGroupedStories,
  setProfileStoryOwnerId,
  setProfilePreviewStories,
  setActiveUserGroup,
  setActiveStoryIndex,
  setProgress,
  setCurrentTimeSec,
}: UseStoriesDataOptions) {
  const fetchStories = useCallback(async () => {
    if (!supabaseConfigured || !userId) return;

    const { data: followings, error: followingsError } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', userId);
    if (followingsError) console.warn('[stories] تعذر تحميل قائمة المتابَعين:', followingsError);

    const followedIds = (followings || []).map(f => f.following_id);
    const allowedUserIds = [userId, ...followedIds];

    // صلاحية القصة ووقت انتهائها يتحقق منهما RLS بساعة قاعدة البيانات، لا ساعة الجهاز.
    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .in('user_id', allowedUserIds)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[stories] تعذر جلب القصص:', error);
      setGroupedStories({});
      toast.error(`تعذر تحميل القصص من قاعدة البيانات: ${error.message}`);
      return;
    }

    const storyRows = ((data ?? []) as unknown[])
      .map(normalizeStoryRow)
      .filter((story): story is StoryRow => story !== null);
    const authorIds = [...new Set(storyRows.map(story => story.user_id))];
    const { data: authors, error: authorsError } = authorIds.length
      ? await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', authorIds)
      : { data: [], error: null };
    if (authorsError) console.warn('[stories] تعذر تحميل ملفات أصحاب القصص:', authorsError);

    const authorById = new Map<string, StoryAuthor>();
    ((authors ?? []) as unknown[]).forEach((value: unknown) => {
      const author = normalizeStoryAuthor(value);
      if (author) authorById.set(author.id, author);
    });
    const groups: StoriesByUser = {};
    storyRows.forEach(story => {
      const authorId = story.user_id;
      if (!groups[authorId]) groups[authorId] = [];
      groups[authorId].push({ ...story, author: authorById.get(authorId) ?? null });
    });
    setGroupedStories(groups);
  }, [setGroupedStories, userId]);

  useEffect(() => { void fetchStories(); }, [fetchStories]);

  useEffect(() => {
    if (!pendingProfileStoryOwnerId) return;
    if (!supabaseConfigured) {
      toast.error('تعذر تحميل قصص هذا الحساب');
      onProfileStoryHandled();
      return;
    }

    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('stories')
          .select('*')
          .eq('user_id', pendingProfileStoryOwnerId)
          .order('created_at', { ascending: true });
        if (!active) return;
        if (error) {
          console.error('[stories] تعذر تحميل قصص الملف الشخصي:', error);
          toast.error(`تعذر تحميل القصص من قاعدة البيانات: ${error.message}`);
          onProfileStoryHandled();
          return;
        }
        const storyRows = ((data ?? []) as unknown[])
          .map(normalizeStoryRow)
          .filter((story): story is StoryRow => story !== null);
        if (storyRows.length === 0) {
          toast.info('لا توجد قصص متاحة لهذا الحساب');
          onProfileStoryHandled();
          return;
        }

        const { data: author, error: authorError } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .eq('id', pendingProfileStoryOwnerId)
          .maybeSingle();
        if (!active) return;
        if (authorError) console.warn('[stories] تعذر تحميل ملف صاحب القصة:', authorError);
        const storyAuthor = normalizeStoryAuthor(author);
        const storiesWithAuthor = storyRows.map(story => ({ ...story, author: storyAuthor }));

        setProfileStoryOwnerId(pendingProfileStoryOwnerId);
        setProfilePreviewStories(storiesWithAuthor);
        setActiveUserGroup(pendingProfileStoryOwnerId);
        setActiveStoryIndex(0);
        setProgress(0);
        setCurrentTimeSec(0);
        onProfileStoryHandled();
      } catch (error) {
        if (!active) return;
        console.error('[stories] فشل طلب قصص الملف الشخصي:', error);
        toast.error('تعذر تحميل القصص. تحقق من الاتصال ثم أعد المحاولة.');
        onProfileStoryHandled();
      }
    })();

    return () => {
      active = false;
    };
  }, [
    onProfileStoryHandled,
    pendingProfileStoryOwnerId,
    setActiveStoryIndex,
    setActiveUserGroup,
    setCurrentTimeSec,
    setProgress,
    setProfilePreviewStories,
    setProfileStoryOwnerId,
  ]);

  return { fetchStories };
}
