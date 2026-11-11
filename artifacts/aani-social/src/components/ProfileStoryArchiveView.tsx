import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Heart, Play, Repeat2 } from 'lucide-react';
import { toast } from 'sonner';

import StoryHeader from '@/components/story/StoryHeader';
import StoryMediaStage from '@/components/story/StoryMediaStage';
import StoryProgressBar from '@/components/story/StoryProgressBar';
import { normalizeStoryAuthor, normalizeStoryRow, type StoryRow } from '@/components/stories/types';
import type { ProfileHighlight, ProfileHighlightCollectionSummary } from '@/components/ProfileHighlightsManager';
import { decodeStoryFilterKey, getStoryFilterOverlay } from '@/lib/storyFilters';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { GridSkeleton, ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';

type HighlightCollectionOption = Pick<ProfileHighlightCollectionSummary, 'id' | 'title'>;

type ProfileStoryArchiveViewProps = {
  userId: string;
  onHighlightAdded: (collection: ProfileHighlightCollectionSummary, highlight: ProfileHighlight) => void;
};

export default function ProfileStoryArchiveView({ userId, onHighlightAdded }: ProfileStoryArchiveViewProps) {
  const [stories, setStories] = useState<StoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStory, setSelectedStory] = useState<StoryRow | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [isPaused, setIsPaused] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [deletingStory, setDeletingStory] = useState(false);
  const [highlightPickerOpen, setHighlightPickerOpen] = useState(false);
  const [highlightCollections, setHighlightCollections] = useState<HighlightCollectionOption[]>([]);
  const [highlightCollectionsLoading, setHighlightCollectionsLoading] = useState(false);
  const [highlightSaving, setHighlightSaving] = useState(false);
  const requestIdRef = useRef(0);
  const storyVideoRef = useRef<HTMLVideoElement | null>(null);
  const elapsedMsRef = useRef(0);
  const pausedBeforeHighlightPickerRef = useRef(false);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!supabaseConfigured || !userId) {
      setStories([]);
      setError('اتصال قاعدة البيانات غير متاح.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const archivedStories: StoryRow[] = [];
      let offset = 0;
      const pageSize = 100;
      while (true) {
        const { data, error: archiveError } = await supabase.rpc('aani_get_my_story_archive', {
          p_limit: pageSize,
          p_offset: offset,
        });
        if (requestId !== requestIdRef.current) return;
        if (archiveError) throw archiveError;

        const page = (data ?? []) as unknown[];
        archivedStories.push(...page
          .map(normalizeStoryRow)
          .filter((story): story is StoryRow => story !== null && story.user_id === userId));
        if (page.length < pageSize) break;
        offset += page.length;
      }

      const { data: author, error: authorError } = archivedStories.length
        ? await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url').eq('id', userId).maybeSingle()
        : { data: null, error: null };
      if (requestId !== requestIdRef.current) return;
      if (authorError) console.warn('[profile archive] تعذر تحميل ملف صاحب القصص المؤرشفة:', authorError);
      const storyAuthor = normalizeStoryAuthor(author);
      setStories(archivedStories.map(story => ({ ...story, author: storyAuthor })));
    } catch (fetchError) {
      if (requestId !== requestIdRef.current) return;
      console.error('[profile archive] تعذر تحميل أرشيف القصص:', fetchError);
      setStories([]);
      setError(fetchError instanceof Error ? fetchError.message : 'تعذر تحميل أرشيف القصص.');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
    return () => { requestIdRef.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (!selectedStory) return;
    const duration = Math.min(120, Math.max(5, Number(selectedStory.duration_seconds) || 5));
    elapsedMsRef.current = 0;
    setProgress(0);
    setCurrentTimeSec(0);
    setDurationSeconds(duration);
    setIsPaused(false);
    setShowMenu(false);
  }, [selectedStory?.id]);

  const goToNextStory = useCallback(() => {
    if (!selectedStory) return;
    const index = stories.findIndex(story => story.id === selectedStory.id);
    const nextStory = stories[index + 1];
    if (nextStory) setSelectedStory(nextStory);
    else setSelectedStory(null);
  }, [selectedStory, stories]);

  const goToPreviousStory = useCallback(() => {
    if (!selectedStory) return;
    const index = stories.findIndex(story => story.id === selectedStory.id);
    const previousStory = stories[index - 1];
    if (previousStory) setSelectedStory(previousStory);
  }, [selectedStory, stories]);

  useEffect(() => {
    if (!selectedStory || selectedStory.media_type === 'video' || isPaused) return;
    let lastTick = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      elapsedMsRef.current += now - lastTick;
      lastTick = now;
      const elapsed = Math.min(durationSeconds, elapsedMsRef.current / 1000);
      setCurrentTimeSec(elapsed);
      setProgress(Math.min(100, (elapsed / durationSeconds) * 100));
      if (elapsed >= durationSeconds) goToNextStory();
    }, 50);
    return () => window.clearInterval(timer);
  }, [selectedStory?.id, selectedStory?.media_type, durationSeconds, isPaused, goToNextStory]);

  const handleVideoTimeUpdate = (storyId: string, currentTime: number, videoDuration: number) => {
    if (selectedStory?.id !== storyId || !Number.isFinite(currentTime)) return;
    const safeDuration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : durationSeconds;
    setDurationSeconds(safeDuration);
    setCurrentTimeSec(currentTime);
    setProgress(Math.min(100, (currentTime / safeDuration) * 100));
  };

  const handleDeleteStory = async () => {
    if (!selectedStory || deletingStory || selectedStory.user_id !== userId) return;
    if (!window.confirm('هل أنت متأكد من رغبتك في حذف هذه الستوري؟')) return;
    const storyToDelete = selectedStory;
    const deletedIndex = stories.findIndex(story => story.id === storyToDelete.id);
    setDeletingStory(true);
    try {
      const { error: deleteError } = await supabase
        .from('stories')
        .delete()
        .eq('id', storyToDelete.id)
        .eq('user_id', userId);
      if (deleteError) throw deleteError;

      const remainingStories = stories.filter(story => story.id !== storyToDelete.id);
      setStories(remainingStories);
      setShowMenu(false);
      setSelectedStory(remainingStories.length ? remainingStories[Math.min(deletedIndex, remainingStories.length - 1)] : null);
      toast.success('تم حذف الستوري.');
    } catch (deleteError) {
      console.error('[profile archive] تعذر حذف الستوري:', deleteError);
      toast.error('تعذر حذف الستوري. حاول مرة أخرى.');
    } finally {
      setDeletingStory(false);
    }
  };

  const openHighlightsPicker = async () => {
    if (!supabaseConfigured || !selectedStory || highlightCollectionsLoading) return;
    pausedBeforeHighlightPickerRef.current = isPaused;
    setIsPaused(true);
    setHighlightPickerOpen(true);
    setHighlightCollectionsLoading(true);
    try {
      const { data, error: collectionsError } = await supabase
        .from('profile_highlight_collections')
        .select('id, title')
        .eq('user_id', userId);
      if (collectionsError) throw collectionsError;
      setHighlightCollections((data || []) as HighlightCollectionOption[]);
    } catch (collectionsError) {
      console.error('[profile archive] تعذر تحميل مجموعات أبرز القصص:', collectionsError);
      toast.error('تعذر تحميل مجموعات أبرز القصص. يمكنك المحاولة مجدداً.');
      setHighlightCollections([]);
    } finally {
      setHighlightCollectionsLoading(false);
    }
  };

  const closeHighlightsPicker = () => {
    setHighlightPickerOpen(false);
    setIsPaused(pausedBeforeHighlightPickerRef.current);
  };

  const addToHighlights = async (collectionId: string | null, title = 'أبرز القصص') => {
    if (!selectedStory || highlightSaving) return;
    setHighlightSaving(true);
    try {
      const { data, error: addError } = await supabase.rpc('aani_add_profile_highlight', {
        p_collection_id: collectionId,
        p_collection_title: collectionId ? null : title,
        p_media_url: selectedStory.media_url,
        p_media_type: selectedStory.media_type === 'video' ? 'video' : selectedStory.media_type === 'text' ? 'text' : 'image',
        p_caption: selectedStory.caption,
        p_source_story_id: selectedStory.id,
      });
      if (addError) throw addError;
      const result = data as { collection?: ProfileHighlightCollectionSummary; highlight?: ProfileHighlight } | null;
      if (!result?.collection?.id || !result.highlight?.id) throw new Error('لم تُرجع قاعدة البيانات القصة المحفوظة.');
      onHighlightAdded(result.collection, result.highlight);
      toast.success('تمت إضافة القصة إلى أبرز القصص.');
      closeHighlightsPicker();
    } catch (addError) {
      console.error('[profile archive] تعذر إضافة القصة إلى أبرز القصص:', addError);
      toast.error(addError && typeof addError === 'object' && 'code' in addError && addError.code === '23505'
        ? 'هذه القصة موجودة بالفعل في هذه المجموعة.'
        : 'تعذر إضافة القصة إلى أبرز القصص. حاول مرة أخرى.');
    } finally {
      setHighlightSaving(false);
    }
  };

  const handleReshare = () => {
    if (!selectedStory) return;
    window.dispatchEvent(new CustomEvent<StoryRow>('aani:reshare-archived-story', { detail: selectedStory }));
    setSelectedStory(null);
  };

  const activeFilter = selectedStory ? decodeStoryFilterKey(selectedStory.filter_key) : null;

  return (
    <div dir="rtl">
      {error ? (
        <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-sm text-red-300">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()} className="mt-3 rounded-full bg-white px-4 py-2 text-xs font-bold text-black">إعادة المحاولة</button>
        </div>
      ) : loading && stories.length === 0 ? (
        <GridSkeleton count={9} className="px-2 py-6" />
      ) : stories.length === 0 ? (
        <EmptyState className="rounded-2xl border border-[#242424] bg-[#0a0a0a] px-5 py-12" />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {stories.map(story => (
            <button
              key={story.id}
              type="button"
              aria-label={`فتح القصة المؤرشفة بتاريخ ${new Date(story.created_at).toLocaleDateString('ar')}`}
              onClick={() => setSelectedStory(story)}
              className="relative aspect-[3/4] overflow-hidden rounded-xl border border-[#262626] bg-[#171717] text-right"
            >
              {story.media_url && story.media_type !== 'text' ? story.media_type === 'video' ? (
                <video src={story.media_url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
              ) : (
                <img src={story.media_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs leading-5 text-white">
                  {story.caption || 'قصة نصية'}
                </span>
              )}
              {story.media_type === 'video' && <span className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white"><Play size={13} fill="currentColor" /></span>}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-6 text-center text-[10px] font-medium text-white/90">
                {new Date(story.created_at).toLocaleDateString('ar')}
              </span>
            </button>
          ))}
        </div>
      )}

      {selectedStory && activeFilter && (
        <div className="fixed inset-0 z-[1100] h-[100dvh] w-screen overflow-hidden bg-[#0d0d0d] text-white" role="dialog" aria-modal="true" aria-label="عرض قصة مؤرشفة">
          <div className="relative h-full w-full overflow-hidden bg-black select-none">
            <StoryProgressBar activeStories={[selectedStory]} activeStoryIndex={0} progress={progress} />
            <StoryHeader
              currentStory={selectedStory}
              originalStoryAuthor={null}
              userId={userId}
              showUI
              showMenu={showMenu}
              onMenuChange={setShowMenu}
              onReportStory={() => {}}
              onDeleteStory={() => void handleDeleteStory()}
              onCloseViewer={() => setSelectedStory(null)}
            />
            <StoryMediaStage
              currentStory={selectedStory}
              currentStoryFilter={activeFilter}
              currentStoryFilterOverlay={getStoryFilterOverlay(activeFilter.id)}
              storyVideoRef={storyVideoRef}
              currentTimeSec={currentTimeSec}
              isStoryOwner
              replyKeyboardInset={0}
              onNextStory={goToNextStory}
              onPreviousStory={goToPreviousStory}
              onToggleShowUI={() => {}}
              onPauseChange={setIsPaused}
              isPaused={isPaused}
              showUI
              onVideoMetadata={(storyId, videoDuration) => {
                if (storyId !== selectedStory.id || !Number.isFinite(videoDuration) || videoDuration <= 0) return;
                setDurationSeconds(videoDuration);
                setCurrentTimeSec(0);
                setProgress(0);
              }}
              onVideoTimeUpdate={handleVideoTimeUpdate}
              onVideoEnded={goToNextStory}
            />
            <div dir="ltr" className="absolute inset-x-0 z-30 flex justify-center gap-2 px-3" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
              <button type="button" dir="rtl" onClick={() => void openHighlightsPicker()} className="flex h-9 items-center gap-1.5 rounded-full border border-white/30 bg-black/60 px-3 text-[11px] font-semibold text-white shadow-lg backdrop-blur-md">
                <Heart size={14} /> إضافة إلى أبرز القصص
              </button>
              <button type="button" dir="rtl" onClick={handleReshare} className="flex h-9 items-center gap-1.5 rounded-full border border-white/30 bg-black/60 px-3 text-[11px] font-semibold text-white shadow-lg backdrop-blur-md">
                <Repeat2 size={14} /> إضافة إلى القصة
              </button>
            </div>

            {highlightPickerOpen && (
              <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-black/70" role="presentation" onClick={event => { if (event.target === event.currentTarget && !highlightSaving) closeHighlightsPicker(); }}>
                <section className="max-h-[55dvh] min-h-[230px] w-full max-w-[600px] rounded-t-3xl border border-white/10 bg-[#17171b] px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-4 text-white shadow-2xl" role="dialog" aria-modal="true" aria-label="اختيار مجموعة أبرز القصص">
                  <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/25" />
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-bold">إضافة إلى أبرز القصص</h2>
                      <p className="mt-1 text-xs text-zinc-400">اختر مجموعة أو أنشئ مجموعة جديدة.</p>
                    </div>
                    <button type="button" onClick={closeHighlightsPicker} disabled={highlightSaving} className="rounded-full px-3 py-2 text-xs text-zinc-300 disabled:opacity-50">إغلاق</button>
                  </div>
                  {highlightCollectionsLoading ? (
                    <ListSkeleton count={3} />
                  ) : (
                    <div className="max-h-[32dvh] space-y-2 overflow-y-auto">
                      {highlightCollections.map(collection => (
                        <button key={collection.id} type="button" disabled={highlightSaving} onClick={() => void addToHighlights(collection.id)} className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-right text-sm font-semibold disabled:opacity-50">
                          <span>{collection.title}</span>
                          <Heart size={15} className="text-zinc-400" />
                        </button>
                      ))}
                      <button type="button" disabled={highlightSaving} onClick={() => void addToHighlights(null)} className="flex w-full items-center justify-between rounded-xl bg-white px-4 py-3 text-right text-sm font-bold text-black disabled:opacity-50">
                        <span>{highlightSaving ? 'جارٍ الإضافة...' : 'إنشاء مجموعة «أبرز القصص»'}</span>
                        <Heart size={15} />
                      </button>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
