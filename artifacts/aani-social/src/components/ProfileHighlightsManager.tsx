import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Check, Heart, ImagePlus, Loader2, Plus, SendHorizontal, Upload, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { formatDate } from '@/lib/types';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';

type HighlightMediaType = 'image' | 'video' | 'text';

type ArchiveStory = {
  id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
  is_close_friends: boolean;
  duration_seconds?: number | null;
  created_at: string;
};

export interface ProfileHighlight {
  id: string;
  user_id: string;
  collection_id: string;
  position: number;
  media_url: string | null;
  media_type: HighlightMediaType;
  caption: string | null;
  source_story_id: string | null;
  is_close_friends: boolean;
  created_at: string;
  duration?: number | null;
  duration_seconds?: number | null;
}

export type ProfileHighlightCollectionSummary = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
};

export interface ProfileHighlightCollection extends ProfileHighlightCollectionSummary {
  stories: ProfileHighlight[];
}

function normalizeMediaType(value: string): HighlightMediaType {
  if (value === 'video') return 'video';
  if (value === 'text') return 'text';
  return 'image';
}

const DEFAULT_ARCHIVE_STORY_DURATION_SECONDS = 5;

function getStoryDuration(story: ProfileHighlight | undefined, durations: Record<string, number> = {}) {
  const storedDuration = story
    ? durations[story.id] ?? story.duration ?? story.duration_seconds ?? (story.source_story_id ? durations[story.source_story_id] : undefined)
    : undefined;
  const duration = Number(storedDuration);
  return Number.isFinite(duration) && duration > 0
    ? duration
    : DEFAULT_ARCHIVE_STORY_DURATION_SECONDS;
}

function getArchiveStoryDurationSeconds(story: Pick<ArchiveStory, 'duration_seconds'>) {
  const duration = Number(story.duration_seconds);
  return Number.isFinite(duration) && duration > 0
    ? Math.min(duration, 120)
    : DEFAULT_ARCHIVE_STORY_DURATION_SECONDS;
}

function mediaPreview(mediaUrl: string | null, mediaType: string, caption: string | null, className: string, controls = true, durationSeconds = DEFAULT_ARCHIVE_STORY_DURATION_SECONDS) {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(durationSeconds, 120)
    : DEFAULT_ARCHIVE_STORY_DURATION_SECONDS;
  if (mediaUrl && mediaType === 'video') {
    return <video src={mediaUrl} className={className} controls={controls} muted={!controls} playsInline preload="metadata" data-duration={safeDuration} />;
  }
  if (mediaUrl) return <img src={mediaUrl} className={className} alt="معاينة القصة" data-duration={safeDuration} />;
  return <div className={`${className} flex items-center justify-center whitespace-pre-wrap break-words bg-gradient-to-br from-[#30303a] to-[#111116] p-6 text-center text-lg font-bold text-white`}>{caption || 'قصة نصية'}</div>;
}

export default function ProfileHighlightsManager({
  open,
  onClose,
  userId,
  ownerName,
  ownerAvatarUrl,
  collections,
  existingSourceStoryIds,
  onHighlightAdded,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  ownerName: string;
  ownerAvatarUrl: string | null;
  collections: ProfileHighlightCollection[];
  existingSourceStoryIds: Set<string>;
  onHighlightAdded: (collection: ProfileHighlightCollectionSummary, highlight: ProfileHighlight) => void;
}) {
  useModalBodyScrollLock();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const storyProgressRef = useRef<HTMLDivElement>(null);
  const storyVideoRef = useRef<HTMLVideoElement>(null);
  const storyTimerRef = useRef<number | null>(null);
  const storyTimerStartedAtRef = useRef(0);
  const storyTimerRemainingMsRef = useRef(0);
  const storyTimerHasStartedRef = useRef(false);
  const [isRendered, setIsRendered] = useState(open);
  const [isActive, setIsActive] = useState(false);
  const [tab, setTab] = useState<'archive' | 'studio'>('archive');
  const [step, setStep] = useState<'media' | 'collection'>('media');
  const [archiveStories, setArchiveStories] = useState<ArchiveStory[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [selectedArchiveStory, setSelectedArchiveStory] = useState<ArchiveStory | null>(null);
  const [previewingArchiveStory, setPreviewingArchiveStory] = useState<ArchiveStory | null>(null);
  const [storyDurationSeconds, setStoryDurationSeconds] = useState<number | null>(null);
  const [studioFile, setStudioFile] = useState<File | null>(null);
  const [studioPreviewUrl, setStudioPreviewUrl] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState('');
  const [collectionTitleDraft, setCollectionTitleDraft] = useState('');
  const [highlightsSelectionOpen, setHighlightsSelectionOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [newCollectionTitle, setNewCollectionTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const closeStoryPreview = useCallback(() => {
    if (storyTimerRef.current !== null) {
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    const progress = storyProgressRef.current;
    storyTimerStartedAtRef.current = 0;
    storyTimerRemainingMsRef.current = 0;
    storyTimerHasStartedRef.current = false;
    if (progress) {
      progress.style.animation = 'none';
      progress.style.animationDuration = '';
      progress.style.animationPlayState = '';
      progress.style.width = '0%';
    }
    const video = storyVideoRef.current;
    if (video) {
      video.pause();
      if (video.readyState > 0) video.currentTime = 0;
    }
    setPreviewingArchiveStory(null);
    setStoryDurationSeconds(null);
    setHighlightsSelectionOpen(false);
    setCreateCollectionOpen(false);
    setNewCollectionTitle('');
  }, []);

  const startStoryProgress = useCallback((durationSeconds: number) => {
    if (storyTimerRef.current !== null) {
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    const storyDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.min(durationSeconds, 120)
      : DEFAULT_ARCHIVE_STORY_DURATION_SECONDS;
    const progress = storyProgressRef.current;
    const durationMs = storyDuration * 1000;
    storyTimerRemainingMsRef.current = durationMs;
    storyTimerStartedAtRef.current = Date.now();
    storyTimerHasStartedRef.current = true;
    if (progress) {
      progress.style.animation = 'none';
      progress.style.animationDuration = '';
      progress.style.animationPlayState = 'running';
      progress.style.width = '0%';
      void progress.offsetWidth;
      progress.style.animation = 'fillProgress linear forwards';
      progress.style.animationDuration = `${storyDuration}s`;
    }
    const timer = window.setTimeout(closeStoryPreview, durationMs);
    storyTimerRef.current = timer;
    return timer;
  }, [closeStoryPreview]);

  const pauseStoryProgress = useCallback(() => {
    if (storyTimerRef.current !== null) {
      const elapsedMs = storyTimerStartedAtRef.current > 0 ? Date.now() - storyTimerStartedAtRef.current : 0;
      storyTimerRemainingMsRef.current = Math.max(0, storyTimerRemainingMsRef.current - elapsedMs);
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    storyTimerStartedAtRef.current = 0;
    if (storyProgressRef.current) storyProgressRef.current.style.animationPlayState = 'paused';
    storyVideoRef.current?.pause();
  }, []);

  const resumeStoryProgress = useCallback(() => {
    const remainingMs = storyTimerRemainingMsRef.current;
    if (remainingMs <= 0) {
      if (storyTimerHasStartedRef.current) closeStoryPreview();
      return;
    }
    if (storyTimerRef.current !== null) window.clearTimeout(storyTimerRef.current);
    storyTimerStartedAtRef.current = Date.now();
    if (storyProgressRef.current) storyProgressRef.current.style.animationPlayState = 'running';
    storyTimerRef.current = window.setTimeout(closeStoryPreview, remainingMs);
    if (storyVideoRef.current) void storyVideoRef.current.play().catch(() => {});
  }, [closeStoryPreview]);

  const openArchiveStoryPreview = (story: ArchiveStory, durationSeconds: number) => {
    if (storyTimerRef.current !== null) {
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    storyTimerStartedAtRef.current = 0;
    storyTimerRemainingMsRef.current = 0;
    storyTimerHasStartedRef.current = false;
    const progress = storyProgressRef.current;
    if (progress) {
      progress.style.animation = 'none';
      progress.style.animationDuration = '';
      progress.style.animationPlayState = '';
      progress.style.width = '0%';
    }
    const previousVideo = storyVideoRef.current;
    if (previousVideo) {
      previousVideo.pause();
      if (previousVideo.readyState > 0) previousVideo.currentTime = 0;
    }
    setPreviewingArchiveStory(story);
    setStoryDurationSeconds(story.media_url && story.media_type === 'video' ? null : durationSeconds);
  };

  const handleStoryVideoMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const storedDuration = Number(video.dataset.duration);
    const storyDuration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : storedDuration;
    startStoryProgress(storyDuration);
    if (highlightsSelectionOpen || createCollectionOpen) pauseStoryProgress();
    else void video.play().catch(() => {});
  };

  const handleStoryVideoError = (event: SyntheticEvent<HTMLVideoElement>) => {
    const storedDuration = Number(event.currentTarget.dataset.duration);
    startStoryProgress(storedDuration);
    if (highlightsSelectionOpen || createCollectionOpen) pauseStoryProgress();
  };

  useEffect(() => {
    if (open) {
      setIsRendered(true);
      const frame = window.requestAnimationFrame(() => setIsActive(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setIsActive(false);
    if (!isRendered) return;
    const timeout = window.setTimeout(() => setIsRendered(false), 300);
    return () => window.clearTimeout(timeout);
  }, [open, isRendered]);

  useEffect(() => {
    const isVideo = Boolean(previewingArchiveStory?.media_url && previewingArchiveStory.media_type === 'video');
    if (!previewingArchiveStory || isVideo || storyDurationSeconds === null) return;

    const timer = startStoryProgress(storyDurationSeconds);
    return () => {
      window.clearTimeout(timer);
      if (storyTimerRef.current === timer) storyTimerRef.current = null;
    };
  }, [previewingArchiveStory, storyDurationSeconds, startStoryProgress]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setTab('archive');
    setStep('media');
    setSelectedArchiveStory(null);
    setStudioFile(null);
    setCaptionDraft('');
    setCollectionTitleDraft('');
    setArchiveError('');
    setArchiveLoading(true);

    void (async () => {
      try {
        if (!supabaseConfigured) throw new Error('اتصال قاعدة البيانات غير متاح.');
        const stories: ArchiveStory[] = [];
        let offset = 0;
        const pageSize = 100;
        while (true) {
          const { data, error } = await supabase.rpc('aani_get_my_story_archive', {
            p_limit: pageSize,
            p_offset: offset,
          });
          if (!active) return;
          if (error) throw error;
          const page = (data ?? []) as ArchiveStory[];
          stories.push(...page);
          if (page.length < pageSize) break;
          offset += page.length;
        }
        if (active) setArchiveStories(stories);
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : 'تعذر تحميل أرشيف القصص.';
        setArchiveError(message);
        setArchiveStories([]);
      } finally {
        if (active) setArchiveLoading(false);
      }
    })();

    return () => { active = false; };
  }, [open, userId]);

  useEffect(() => {
    if (!studioFile) {
      setStudioPreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(studioFile);
    setStudioPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [studioFile]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      if (createCollectionOpen) {
        setCreateCollectionOpen(false);
        setNewCollectionTitle('');
        resumeStoryProgress();
        return;
      }
      if (highlightsSelectionOpen) {
        setHighlightsSelectionOpen(false);
        resumeStoryProgress();
        return;
      }
      if (previewingArchiveStory) {
        closeStoryPreview();
        return;
      }
      if (step === 'collection') setStep('media');
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, saving, step, previewingArchiveStory, closeStoryPreview, createCollectionOpen, highlightsSelectionOpen, resumeStoryProgress]);

  const close = () => {
    if (saving) return;
    closeStoryPreview();
    setStudioFile(null);
    setSelectedArchiveStory(null);
    setCaptionDraft('');
    setCollectionTitleDraft('');
    setStep('media');
    onClose();
  };

  const selectStudioFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] || null;
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      toast.error('اختر صورة أو مقطع فيديو صالحاً.');
      return;
    }
    setStudioFile(file);
    setSelectedArchiveStory(null);
    setCaptionDraft('');
  };

  const selectArchiveStory = (story: ArchiveStory) => {
    if (existingSourceStoryIds.has(story.id)) return;
    setSelectedArchiveStory(story);
    setStudioFile(null);
    setCaptionDraft(story.caption || '');
  };

  const openHighlightsSelection = () => {
    const story = previewingArchiveStory;
    if (!story || existingSourceStoryIds.has(story.id)) return;
    pauseStoryProgress();
    setHighlightsSelectionOpen(true);
  };

  const closeHighlightsSelection = () => {
    setHighlightsSelectionOpen(false);
    if (!createCollectionOpen) resumeStoryProgress();
  };

  const openCreateCollection = () => {
    setHighlightsSelectionOpen(false);
    setNewCollectionTitle('');
    setCreateCollectionOpen(true);
  };

  const cancelCreateCollection = () => {
    setCreateCollectionOpen(false);
    setNewCollectionTitle('');
    resumeStoryProgress();
  };

  const continueToCollections = () => {
    if (!selectedArchiveStory && !studioFile) return;
    setCollectionTitleDraft(captionDraft.trim());
    setStep('collection');
  };

  const saveHighlight = async (targetCollection: ProfileHighlightCollection | null) => {
    if (saving) return;
    if (!supabaseConfigured || !userId) {
      toast.error('اتصال قاعدة البيانات غير متاح.');
      return;
    }
    if (!selectedArchiveStory && !studioFile) return;

    setSaving(true);
    let uploadedPath: string | null = null;
    try {
      let mediaUrl: string | null;
      let mediaType: HighlightMediaType;
      let sourceStoryId: string | null = null;

      if (selectedArchiveStory) {
        mediaUrl = selectedArchiveStory.media_url;
        mediaType = normalizeMediaType(selectedArchiveStory.media_type);
        sourceStoryId = selectedArchiveStory.id;
      } else {
        const file = studioFile!;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'highlight-media';
        uploadedPath = `${userId}/highlights/${Date.now()}-${safeName}`;
        await uploadMedia({ file, path: uploadedPath });
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(uploadedPath).data.publicUrl;
        mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      }

      const { data, error } = await supabase.rpc('aani_add_profile_highlight', {
        p_collection_id: targetCollection?.id ?? null,
        p_collection_title: targetCollection ? null : collectionTitleDraft.trim() || captionDraft.trim() || 'أبرز القصص',
        p_media_url: mediaUrl,
        p_media_type: mediaType,
        p_caption: captionDraft.trim() || null,
        p_source_story_id: sourceStoryId,
      });
      if (error) throw error;

      const result = data as {
        collection?: ProfileHighlightCollectionSummary;
        highlight?: ProfileHighlight;
      } | null;
      if (!result?.collection?.id || !result.highlight?.id) throw new Error('لم تُرجع قاعدة البيانات القصة المحفوظة.');

      onHighlightAdded(result.collection, result.highlight);
      uploadedPath = null;
      toast.success(targetCollection ? `أُضيفت القصة إلى ${targetCollection.title}.` : 'أُنشئت المجموعة وأُضيفت إليها القصة.');
      setStudioFile(null);
      setSelectedArchiveStory(null);
      setCaptionDraft('');
      setCollectionTitleDraft('');
      setStep('media');
      onClose();
    } catch (error) {
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage.from(storageBucket).remove([uploadedPath]);
        if (cleanupError) console.warn('[profile highlights] تعذر حذف الوسيط غير المحفوظ:', cleanupError);
      }
      console.error('[profile highlights] تعذر حفظ أبرز القصص:', error);
      const message = error && typeof error === 'object' && 'code' in error && error.code === '23505'
        ? 'هذه القصة موجودة بالفعل في أبرز القصص.'
        : 'تعذر حفظ القصة في أبرز القصص. حاول مرة أخرى.';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const savePreviewedArchiveStory = async (targetCollection: ProfileHighlightCollection | null, titleDraft = '') => {
    const story = previewingArchiveStory;
    if (saving || !story) return;
    if (!supabaseConfigured || !userId) {
      toast.error('اتصال قاعدة البيانات غير متاح.');
      return;
    }
    if (existingSourceStoryIds.has(story.id)) {
      toast.error('هذه القصة موجودة بالفعل في أبرز القصص.');
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('aani_add_profile_highlight', {
        p_collection_id: targetCollection?.id ?? null,
        p_collection_title: targetCollection ? null : titleDraft.trim() || 'أبرز القصص',
        p_media_url: story.media_url,
        p_media_type: normalizeMediaType(story.media_type),
        p_caption: story.caption,
        p_source_story_id: story.id,
      });
      if (error) throw error;

      const result = data as {
        collection?: ProfileHighlightCollectionSummary;
        highlight?: ProfileHighlight;
      } | null;
      if (!result?.collection?.id || !result.highlight?.id) throw new Error('لم تُرجع قاعدة البيانات القصة المحفوظة.');

      onHighlightAdded(result.collection, result.highlight);
      toast.success(targetCollection ? `أُضيفت القصة إلى ${targetCollection.title}.` : 'أُنشئت المجموعة وأُضيفت إليها القصة.');
      setHighlightsSelectionOpen(false);
      setCreateCollectionOpen(false);
      setNewCollectionTitle('');
      resumeStoryProgress();
    } catch (error) {
      console.error('[profile highlights] تعذر حفظ قصة الأرشيف:', error);
      const message = error && typeof error === 'object' && 'code' in error && error.code === '23505'
        ? 'هذه القصة موجودة بالفعل في أبرز القصص.'
        : 'تعذر حفظ القصة في أبرز القصص. حاول مرة أخرى.';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (!isRendered) return null;

  const canContinue = step === 'media' && (tab === 'archive' ? Boolean(selectedArchiveStory) : Boolean(studioFile));
  const selectedMediaUrl = selectedArchiveStory ? selectedArchiveStory.media_url : studioPreviewUrl;
  const selectedMediaType = selectedArchiveStory ? selectedArchiveStory.media_type : (studioFile?.type.startsWith('video/') ? 'video' : 'image');
  const selectedMediaCaption = selectedArchiveStory ? captionDraft : studioFile?.name || captionDraft;

  return createPortal(
    <div id="highlightCreationModal" className={`highlight-creation-modal fixed inset-0 z-[10000] flex h-[100dvh] w-full flex-col overflow-hidden bg-black text-white ${isActive ? 'active' : ''}`} dir="rtl" role="dialog" aria-modal="true" aria-hidden={!isRendered} aria-label="إنشاء أبرز القصص">
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-white/10 px-4 pb-3 pt-[env(safe-area-inset-top,44px)]">
        <button id="closeModalBtn" type="button" onClick={close} className="justify-self-start px-2 py-2 text-base font-bold text-white transition-opacity hover:opacity-70 disabled:opacity-50" disabled={saving}>إلغاء</button>
        <div className="flex items-center gap-1 rounded-full bg-neutral-900 p-1" role="tablist" aria-label="مصدر أبرز القصص">
          <button id="tabArchive" type="button" role="tab" aria-selected={tab === 'archive'} aria-pressed={tab === 'archive'} onClick={() => { setTab('archive'); setStep('media'); }} className={`min-w-[112px] rounded-full px-5 py-2 text-sm font-bold transition-colors ${tab === 'archive' ? 'bg-white text-black' : 'text-neutral-400'}`}>
            الأرشيف
          </button>
          <button id="tabStudio" type="button" role="tab" aria-selected={tab === 'studio'} aria-pressed={tab === 'studio'} onClick={() => { setTab('studio'); setStep('media'); }} className={`min-w-[112px] rounded-full px-5 py-2 text-sm font-bold transition-colors ${tab === 'studio' ? 'bg-white text-black' : 'text-neutral-400'}`}>
            الاستوديو
          </button>
        </div>
        <span aria-hidden="true" />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <section id="contentArchive" aria-hidden={tab !== 'archive'} className={tab === 'archive' ? 'w-full' : 'hidden'}>
          {selectedArchiveStory && (
            <div className="mb-4 grid gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
              <div className="mx-auto aspect-[9/14] max-h-[42dvh] w-full max-w-[250px] overflow-hidden rounded-xl bg-black">
                {mediaPreview(selectedArchiveStory.media_url, selectedArchiveStory.media_type, captionDraft, 'h-full w-full object-contain')}
              </div>
              <div className="flex min-w-0 flex-col justify-center gap-3">
                <p className="text-sm font-bold">معاينة القصة المختارة</p>
                {selectedArchiveStory.is_close_friends && <p className="rounded-lg bg-emerald-950/60 px-3 py-2 text-xs text-emerald-200">ستظل هذه القصة مقتصرة على الأصدقاء المقرّبين.</p>}
                <label className="text-xs font-semibold text-zinc-300" htmlFor="archive-highlight-caption">وصف القصة</label>
                <textarea id="archive-highlight-caption" value={captionDraft} onChange={event => setCaptionDraft(event.currentTarget.value)} maxLength={500} rows={3} className="w-full resize-none rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-white outline-none focus:border-[#1D9BF0]" placeholder="أضف وصفاً اختيارياً..." />
              </div>
            </div>
          )}
          {archiveLoading ? (
            <div className="grid min-h-48 place-items-center text-sm text-zinc-400">جارٍ تحميل الأرشيف...</div>
          ) : archiveError ? (
            <div role="alert" className="rounded-2xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">تعذر تحميل الأرشيف: {archiveError}</div>
          ) : archiveStories.length === 0 ? (
            <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/15 bg-white/[0.03] p-6 text-center">
              <div><p className="font-bold">لا توجد قصص منتهية في الأرشيف بعد</p><p className="mt-2 text-sm text-zinc-400">يمكنك اختيار الاستوديو لإضافة صورة أو فيديو مباشرة إلى أبرز القصص.</p></div>
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-zinc-400">اختر قصة منتهية لمعاينتها ثم أضفها إلى مجموعة.</p>
              <div className="grid grid-cols-3 gap-1">
                {archiveStories.map(story => {
                  const alreadyAdded = existingSourceStoryIds.has(story.id);
                  const archiveDurationSeconds = getArchiveStoryDurationSeconds(story);
                  return (
                    <button key={story.id} type="button" data-duration={archiveDurationSeconds} onClick={event => {
                      const mediaDuration = event.currentTarget.querySelector<HTMLElement>('[data-duration]')?.dataset.duration;
                      const durationFromTile = Number(mediaDuration ?? event.currentTarget.dataset.duration);
                      openArchiveStoryPreview(story, Number.isFinite(durationFromTile) && durationFromTile > 0 ? durationFromTile : DEFAULT_ARCHIVE_STORY_DURATION_SECONDS);
                    }} aria-label={`معاينة القصة ${story.caption?.trim() || 'المحفوظة'}`} className="group relative aspect-[9/16] overflow-hidden rounded-md border border-white/10 bg-zinc-900 text-left transition hover:border-white/40">
                      {mediaPreview(story.media_url, story.media_type, story.caption, 'h-full w-full object-cover', false, archiveDurationSeconds)}
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-2 pb-2 pt-7 text-right text-[10px] text-white">{alreadyAdded ? 'مضافة' : story.caption?.trim() || 'قصة محفوظة'}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <section id="contentStudio" aria-hidden={tab !== 'studio'} className={tab === 'studio' ? 'w-full' : 'hidden'}>
          <div className="w-full">
            <div className="grid grid-cols-3 gap-1">
              {!studioFile ? (
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex aspect-[9/16] flex-col items-center justify-center gap-3 overflow-hidden rounded-md border border-dashed border-white/20 bg-neutral-900 px-2 text-center transition hover:border-[#1D9BF0] hover:bg-[#1D9BF0]/5">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-[#1D9BF0]/15 text-[#56B4F5]"><ImagePlus size={25} /></span>
                  <span className="text-xs font-bold">اختيار صورة أو فيديو</span>
                </button>
              ) : (
                <div className="relative aspect-[9/16] overflow-hidden rounded-md bg-neutral-900">
                  {studioFile.type.startsWith('video/') ? (
                    <video src={studioPreviewUrl || undefined} className="h-full w-full object-cover" controls muted playsInline preload="metadata" />
                  ) : (
                    <img src={studioPreviewUrl || ''} className="h-full w-full object-cover" alt="معاينة الوسيط المختار" />
                  )}
                  <button type="button" onClick={() => { setStudioFile(null); setCaptionDraft(''); }} aria-label="إزالة الوسيط المختار" className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/75 text-white"><X size={17} /></button>
                </div>
              )}
              {studioFile && (
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex aspect-[9/16] flex-col items-center justify-center gap-3 overflow-hidden rounded-md border border-dashed border-white/20 bg-neutral-900 px-2 text-center text-neutral-300 transition hover:border-[#1D9BF0]">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-white/10"><Upload size={22} /></span>
                  <span className="text-xs font-bold">اختيار ملف آخر</span>
                </button>
              )}
            </div>
            {studioFile && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="truncate text-xs text-zinc-400">{studioFile.name}</p>
                <label className="mt-3 block text-xs font-semibold text-zinc-300" htmlFor="studio-highlight-caption">وصف القصة (اختياري)</label>
                <textarea id="studio-highlight-caption" value={captionDraft} onChange={event => setCaptionDraft(event.currentTarget.value)} maxLength={500} rows={2} className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-white outline-none focus:border-[#1D9BF0]" placeholder="اكتب وصفاً قصيراً..." />
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" aria-label="اختيار صورة أو فيديو لإضافته إلى أبرز القصص" onChange={selectStudioFile} />
          </div>
        </section>
      </main>

      {canContinue && (
        <footer className="shrink-0 border-t border-white/10 bg-black px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
          <button type="button" onClick={continueToCollections} className="mx-auto flex min-h-12 w-full max-w-xl items-center justify-center gap-2 rounded-full bg-[#1D9BF0] px-5 text-sm font-black text-white transition hover:bg-[#1686d4]">
            <Check size={18} /> تم
          </button>
        </footer>
      )}

      {step === 'collection' && (
        <div className="fixed inset-0 z-[10001] flex items-end justify-center bg-black/75" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setStep('media'); }}>
          <section className="max-h-[82dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-white/10 bg-[#111114] px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="highlight-collection-title">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h3 id="highlight-collection-title" className="text-lg font-black">اختر مجموعة للقصة</h3>
                <p className="mt-1 text-sm text-zinc-400">أضفها إلى مجموعة حالية أو أنشئ مجموعة جديدة.</p>
              </div>
              <button type="button" onClick={() => setStep('media')} aria-label="العودة لاختيار القصة" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10" disabled={saving}><X size={18} /></button>
            </div>

            <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-zinc-900">
                {mediaPreview(selectedMediaUrl, selectedMediaType, selectedMediaCaption, 'h-full w-full object-cover', false)}
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="highlight-collection-name" className="text-xs font-bold text-zinc-300">اسم المجموعة الجديدة</label>
                <input id="highlight-collection-name" value={collectionTitleDraft} onChange={event => setCollectionTitleDraft(event.currentTarget.value)} maxLength={500} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-[#1D9BF0]" placeholder="اكتب عنواناً يظهر أسفل الدائرة" />
                <p className="mt-1 text-[10px] text-zinc-500">وصف القصة هو العنوان الافتراضي للمجموعة الجديدة.</p>
              </div>
            </div>

            <div className="no-scrollbar flex gap-5 overflow-x-auto pb-2">
              <button type="button" onClick={() => void saveHighlight(null)} disabled={saving} className="flex w-[92px] shrink-0 flex-col items-center gap-2 text-center disabled:opacity-50">
                <span className="grid h-[68px] w-[68px] place-items-center rounded-full border-2 border-dashed border-[#1D9BF0] bg-[#1D9BF0]/10 text-[#56B4F5]"><Plus size={27} /></span>
                <span className="line-clamp-2 text-[11px] font-semibold text-white">إنشاء مجموعة جديدة</span>
              </button>
              {collections.map(collection => {
                const cover = collection.stories[0];
                return (
                  <button key={collection.id} type="button" onClick={() => void saveHighlight(collection)} disabled={saving} className="flex w-[92px] shrink-0 flex-col items-center gap-2 text-center disabled:opacity-50" aria-label={`إضافة إلى مجموعة ${collection.title}`}>
                    <span className="flex h-[68px] w-[68px] overflow-hidden rounded-full border border-[#4B4B50] p-[3px]">
                      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                        {cover ? mediaPreview(cover.media_url, cover.media_type, cover.caption, 'h-full w-full object-cover', false) : <span className="px-1 text-center text-[9px] text-white">{collection.title}</span>}
                      </span>
                    </span>
                    <span className="line-clamp-2 w-full text-[11px] text-zinc-300">{collection.title}</span>
                  </button>
                );
              })}
            </div>
            {saving && <p className="mt-4 text-center text-xs text-zinc-400">جارٍ حفظ القصة في المجموعة...</p>}
          </section>
        </div>
      )}

      <div id="storyViewer" className={`archive-story-viewer fixed inset-0 z-[10005] flex flex-col bg-black text-white opacity-0 pointer-events-none transition-opacity duration-200 ${previewingArchiveStory ? 'active' : ''}`} dir="rtl" role="dialog" aria-modal="true" aria-hidden={!previewingArchiveStory} aria-label="معاينة القصة">
        {previewingArchiveStory && (
          <>
            <div className="pointer-events-none absolute inset-x-3 top-[calc(env(safe-area-inset-top,44px)+8px)] z-30 h-[2.5px] overflow-hidden rounded-full bg-white/35">
              <div id="storyProgress" ref={storyProgressRef} className="h-full w-0 bg-white" />
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-40 bg-gradient-to-b from-black/75 via-black/30 to-transparent" />
            {previewingArchiveStory.media_url && previewingArchiveStory.media_type === 'video' ? (
              <video
                id="storyImage"
                key={previewingArchiveStory.id}
                ref={storyVideoRef}
                src={previewingArchiveStory.media_url}
                className="absolute inset-0 z-0 h-full w-full object-cover"
                data-duration={getArchiveStoryDurationSeconds(previewingArchiveStory)}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={handleStoryVideoMetadata}
                onError={handleStoryVideoError}
                onEnded={closeStoryPreview}
              />
            ) : previewingArchiveStory.media_url ? (
              <img
                id="storyImage"
                key={previewingArchiveStory.id}
                src={previewingArchiveStory.media_url}
                className="absolute inset-0 z-0 h-full w-full object-cover"
                data-duration={getArchiveStoryDurationSeconds(previewingArchiveStory)}
                alt={previewingArchiveStory.caption || 'قصة محفوظة'}
                loading="eager"
                decoding="async"
              />
            ) : (
              <div id="storyImage" className="absolute inset-0 z-0 flex h-full w-full items-center justify-center bg-gradient-to-br from-[#30303a] to-[#111116] px-8 text-center">
                <p className="whitespace-pre-wrap text-2xl font-bold">{previewingArchiveStory.caption || 'قصة نصية'}</p>
              </div>
            )}
            <header className="absolute inset-x-0 z-20 flex items-center justify-between px-4" style={{ top: 'calc(env(safe-area-inset-top, 44px) + 18px)' }}>
              <div className="flex min-w-0 items-center gap-2">
                <Avatar profile={{ avatar_url: ownerAvatarUrl, full_name: ownerName, username: ownerName }} />
                <div className="min-w-0">
                  <p className="max-w-[58vw] truncate text-sm font-bold text-white">{ownerName || 'محمد'}</p>
                  <time dateTime={previewingArchiveStory.created_at} className="mt-0.5 block text-[10px] text-white/75">
                    {formatDate(previewingArchiveStory.created_at) || 'قصة محفوظة'}
                  </time>
                </div>
              </div>
              <button id="closeStoryBtn" type="button" onClick={closeStoryPreview} aria-label="إغلاق الستوري" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/30 text-white backdrop-blur-sm transition hover:bg-black/50">
                <X size={22} />
              </button>
            </header>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-black/45 to-transparent" />
            <button
              type="button"
              onClick={openHighlightsSelection}
              disabled={saving || existingSourceStoryIds.has(previewingArchiveStory.id)}
              aria-label={existingSourceStoryIds.has(previewingArchiveStory.id) ? 'مضافة بالفعل إلى أبرز القصص' : 'إضافة إلى أبرز القصص'}
              className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/30 bg-white/20 px-3 py-1 text-xs font-semibold text-white shadow-lg backdrop-blur-md transition hover:bg-white/30 disabled:cursor-default disabled:opacity-75"
            >
              <Heart size={13} className="shrink-0" />
              <span>أبرز القصص</span>
            </button>
          </>
        )}
      </div>
      {highlightsSelectionOpen && previewingArchiveStory && (
        <div
          className="highlights-selection-backdrop fixed inset-0 z-[10006] flex items-end justify-center bg-black/65 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget && !saving) closeHighlightsSelection(); }}
        >
          <section className="highlights-selection-sheet max-h-[52dvh] min-h-[230px] w-full max-w-[600px] rounded-t-3xl border border-white/10 bg-[#17171b] px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-3 text-white shadow-[0_-16px_60px_rgba(0,0,0,0.45)]" role="dialog" aria-modal="true" aria-label="اختيار مجموعة لأبرز القصص">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/25" />
            <header className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black">أبرز القصص</h2>
                <p className="mt-1 text-xs text-zinc-400">أضف القصة إلى مجموعة أو أنشئ مجموعة جديدة</p>
              </div>
              <button type="button" onClick={closeHighlightsSelection} disabled={saving} aria-label="إغلاق اختيار المجموعة" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white disabled:opacity-50"><X size={19} /></button>
            </header>
            <div className="no-scrollbar -mx-5 flex gap-4 overflow-x-auto px-5 pb-2">
              <button type="button" onClick={openCreateCollection} disabled={saving} className="flex w-[82px] shrink-0 flex-col items-center gap-2 text-center disabled:opacity-50">
                <span className="grid h-[72px] w-[72px] place-items-center rounded-full border-2 border-dashed border-white/60 bg-white/[0.04] text-white"><Plus size={27} /></span>
                <span className="line-clamp-2 w-full text-[11px] font-semibold leading-4">إنشاء مجموعة جديدة</span>
              </button>
              {collections.map(collection => {
                const cover = collection.stories[0];
                return (
                  <button key={collection.id} type="button" onClick={() => void savePreviewedArchiveStory(collection)} disabled={saving} aria-label={`إضافة القصة إلى مجموعة ${collection.title}`} className="flex w-[82px] shrink-0 flex-col items-center gap-2 text-center disabled:opacity-50">
                    <span className="flex h-[72px] w-[72px] overflow-hidden rounded-full border-2 border-white/50 p-[3px]">
                      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                        {cover ? mediaPreview(cover.media_url, cover.media_type, cover.caption, 'h-full w-full object-cover', false) : <span className="px-1 text-center text-[9px] text-white">{collection.title}</span>}
                      </span>
                    </span>
                    <span className="line-clamp-2 w-full text-[11px] leading-4 text-zinc-200">{collection.title}</span>
                  </button>
                );
              })}
            </div>
            {saving && <p className="mt-3 text-center text-xs text-zinc-400">جارٍ إضافة القصة إلى المجموعة...</p>}
          </section>
        </div>
      )}
      {createCollectionOpen && previewingArchiveStory && (
        <div className="highlights-create-modal fixed inset-0 z-[10007] flex h-[100dvh] justify-center bg-black text-white" dir="rtl">
          <section className="flex h-full w-full max-w-[600px] flex-col bg-black" role="dialog" aria-modal="true" aria-labelledby="create-highlight-title">
            <header className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-white/10 px-4 pb-3 pt-[env(safe-area-inset-top,44px)]">
              <button type="button" onClick={cancelCreateCollection} disabled={saving} className="justify-self-start px-2 py-2 text-sm font-bold text-zinc-200 disabled:opacity-50">إلغاء</button>
              <h2 id="create-highlight-title" className="text-sm font-bold">مجموعة جديدة</h2>
              <button type="button" onClick={() => void savePreviewedArchiveStory(null, newCollectionTitle)} disabled={saving} className="justify-self-end px-2 py-2 text-sm font-black text-[#56B4F5] disabled:opacity-50">حفظ</button>
            </header>
            <main className="px-5 pt-7">
              <label className="sr-only" htmlFor="new-highlight-title">العنوان</label>
              <input id="new-highlight-title" autoFocus value={newCollectionTitle} onChange={event => setNewCollectionTitle(event.currentTarget.value)} maxLength={500} placeholder="العنوان" className="w-full border-b border-white/20 bg-transparent px-1 py-3 text-lg text-white outline-none placeholder:text-zinc-500 focus:border-white/70" />
              {saving && <p className="mt-5 text-center text-xs text-zinc-400">جارٍ حفظ المجموعة...</p>}
            </main>
          </section>
        </div>
      )}
    </div>,
    document.body,
  );
}

export function ProfileHighlightViewer({
  collection,
  collections,
  onClose,
  currentUserId,
  ownerName,
  ownerAvatarUrl,
}: {
  collection: ProfileHighlightCollection;
  collections: ProfileHighlightCollection[];
  onClose: () => void;
  currentUserId: string;
  ownerName: string;
  ownerAvatarUrl: string | null;
}) {
  useModalBodyScrollLock();
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeCollectionId, setActiveCollectionId] = useState(collection.id);
  const [storyDurations, setStoryDurations] = useState<Record<string, number>>({});
  const [durationsLoaded, setDurationsLoaded] = useState(false);
  const [mediaReadyStoryId, setMediaReadyStoryId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [titleToastVisible, setTitleToastVisible] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isLikeLoading, setIsLikeLoading] = useState(false);
  const [isLikeSaving, setIsLikeSaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressContainerRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const activeStoryIdRef = useRef<string | null>(null);
  const storyTimerRef = useRef<number | null>(null);
  const storyTimerStartedAtRef = useRef(0);
  const storyTimerRemainingMsRef = useRef(0);
  const titleToastShownRef = useRef(false);
  const foundCollectionIndex = collections.findIndex(item => item.id === activeCollectionId);
  const collectionIndex = foundCollectionIndex >= 0 ? foundCollectionIndex : collections.findIndex(item => item.id === collection.id);
  const activeCollection = foundCollectionIndex >= 0 ? collections[foundCollectionIndex] : collection;
  const story = activeCollection.stories[activeIndex];
  const isStoryOwner = currentUserId === activeCollection.user_id;
  const isVideo = Boolean(story?.media_url && story.media_type === 'video');
  const storyDuration = getStoryDuration(story, storyDurations);

  const clearStoryTimer = useCallback(() => {
    if (storyTimerRef.current !== null) {
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    storyTimerStartedAtRef.current = 0;
  }, []);

  const closeViewer = useCallback(() => {
    clearStoryTimer();
    storyTimerRemainingMsRef.current = 0;
    videoRef.current?.pause();
    onClose();
  }, [clearStoryTimer, onClose]);

  const goToStory = useCallback((nextIndex: number) => {
    if (nextIndex < 0) return;
    clearStoryTimer();
    storyTimerRemainingMsRef.current = 0;
    if (nextIndex >= activeCollection.stories.length) {
      const nextCollection = collectionIndex >= 0 ? collections[collectionIndex + 1] : undefined;
      if (!nextCollection) {
        closeViewer();
        return;
      }
      videoRef.current?.pause();
      titleToastShownRef.current = false;
      setTitleToastVisible(false);
      setStoryDurations({});
      setDurationsLoaded(false);
      setMediaReadyStoryId(null);
      setActiveCollectionId(nextCollection.id);
      setActiveIndex(0);
      return;
    }
    videoRef.current?.pause();
    setMediaReadyStoryId(null);
    setActiveIndex(nextIndex);
  }, [activeCollection.stories.length, clearStoryTimer, closeViewer, collectionIndex, collections]);
  const activeIndexRef = useRef(activeIndex);
  const goToStoryRef = useRef<(nextIndex: number) => void>(() => {});
  activeIndexRef.current = activeIndex;
  goToStoryRef.current = goToStory;

  const pauseStoryProgress = useCallback(() => {
    if (storyTimerRef.current !== null) {
      const elapsedMs = storyTimerStartedAtRef.current > 0 ? Date.now() - storyTimerStartedAtRef.current : 0;
      storyTimerRemainingMsRef.current = Math.max(0, storyTimerRemainingMsRef.current - elapsedMs);
      window.clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
    storyTimerStartedAtRef.current = 0;
    if (progressFillRef.current) progressFillRef.current.style.animationPlayState = 'paused';
  }, []);

  const resumeStoryProgress = useCallback(() => {
    if (!story?.id || !durationsLoaded || mediaReadyStoryId !== story.id || storyTimerRef.current !== null) return;
    const remainingMs = storyTimerRemainingMsRef.current;
    if (remainingMs <= 0) {
      goToStoryRef.current(activeIndexRef.current + 1);
      return;
    }
    const timerStoryId = story.id;
    storyTimerStartedAtRef.current = Date.now();
    if (progressFillRef.current) progressFillRef.current.style.animationPlayState = 'running';
    storyTimerRef.current = window.setTimeout(() => {
      storyTimerRef.current = null;
      storyTimerStartedAtRef.current = 0;
      storyTimerRemainingMsRef.current = 0;
      if (activeStoryIdRef.current === timerStoryId) goToStoryRef.current(activeIndexRef.current + 1);
    }, remainingMs);
  }, [durationsLoaded, mediaReadyStoryId, story?.id]);

  useEffect(() => {
    let active = true;
    const sourceStoryIds = [...new Set(activeCollection.stories.flatMap(item => item.source_story_id ? [item.source_story_id] : []))];
    setStoryDurations({});
    if (sourceStoryIds.length === 0) {
      setDurationsLoaded(true);
      return () => { active = false; };
    }

    setDurationsLoaded(false);
    void (async () => {
      try {
        const { data, error } = await supabase.from('stories').select('id, duration_seconds').in('id', sourceStoryIds);
        if (!active) return;
        if (error) {
          console.warn('[profile highlights] تعذر تحميل مدد القصص الأصلية:', error);
          return;
        }
        const durations: Record<string, number> = {};
        (data || []).forEach((item: { id: string; duration_seconds: number | null }) => {
          const duration = Number(item.duration_seconds);
          if (Number.isFinite(duration) && duration > 0) durations[item.id] = duration;
        });
        setStoryDurations(durations);
      } catch (error) {
        if (active) console.warn('[profile highlights] تعذر تحميل مدد القصص الأصلية:', error);
      } finally {
        if (active) setDurationsLoaded(true);
      }
    })();

    return () => { active = false; };
  }, [activeCollection.id, activeCollection.stories]);

  useEffect(() => {
    if (activeIndex !== 0 || titleToastShownRef.current) {
      setTitleToastVisible(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      titleToastShownRef.current = true;
      setTitleToastVisible(true);
    });
    const timeout = window.setTimeout(() => setTitleToastVisible(false), 2000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [activeIndex, activeCollection.id]);

  useLayoutEffect(() => {
    activeStoryIdRef.current = story?.id ?? null;
    clearStoryTimer();
    storyTimerRemainingMsRef.current = 0;
    setIsPaused(false);
    progressContainerRef.current?.querySelectorAll<HTMLDivElement>('[data-story-progress-fill]').forEach(progressFill => {
      progressFill.style.animation = 'none';
      progressFill.style.animationDuration = '';
      progressFill.style.animationPlayState = '';
    });
    const progressFill = progressFillRef.current;
    if (progressFill) {
      progressFill.style.width = '0%';
      void progressFill.offsetWidth;
    }
    if (story && !story.media_url) setMediaReadyStoryId(story.id);
  }, [clearStoryTimer, story?.id, story?.media_url]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer();
      if (event.key === 'ArrowRight') goToStory(activeIndex - 1);
      if (event.key === 'ArrowLeft') goToStory(activeIndex + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, closeViewer, goToStory]);

  useEffect(() => {
    clearStoryTimer();
    storyTimerRemainingMsRef.current = 0;
    if (!story || !durationsLoaded || mediaReadyStoryId !== story.id) return;

    const duration = storyDuration;
    const durationMs = duration * 1000;
    const progressFill = progressFillRef.current;
    storyTimerRemainingMsRef.current = durationMs;
    if (progressFill) {
      progressFill.style.animation = 'none';
      progressFill.style.animationDuration = '';
      progressFill.style.animationPlayState = 'running';
      progressFill.style.width = '0%';
      void progressFill.offsetWidth;
      progressFill.style.animation = `fillProgress ${duration}s linear forwards`;
    }
    resumeStoryProgress();
    return () => clearStoryTimer();
  }, [clearStoryTimer, durationsLoaded, mediaReadyStoryId, resumeStoryProgress, story?.id, storyDuration]);

  useEffect(() => {
    if (!story || !durationsLoaded || mediaReadyStoryId !== story.id) return;
    if (isPaused) {
      pauseStoryProgress();
      videoRef.current?.pause();
    } else {
      resumeStoryProgress();
      if (isVideo && videoRef.current) void videoRef.current.play().catch(() => {});
    }
  }, [durationsLoaded, isPaused, isVideo, mediaReadyStoryId, pauseStoryProgress, resumeStoryProgress, story?.id, storyDuration]);

  useEffect(() => {
    setReplyText('');
    setIsLiked(false);
    setIsLikeLoading(false);
    if (!story || isStoryOwner || !currentUserId) return;
    let active = true;
    setIsLikeLoading(true);
    void (async () => {
      try {
        const { data, error } = await supabase.from('profile_highlight_likes').select('user_id').eq('highlight_id', story.id).eq('user_id', currentUserId).maybeSingle();
        if (!active) return;
        if (error) {
          console.warn('[profile highlights] تعذر تحميل حالة الإعجاب:', error);
          return;
        }
        setIsLiked(Boolean(data));
      } catch (error) {
        if (active) console.warn('[profile highlights] تعذر تحميل حالة الإعجاب:', error);
      } finally {
        if (active) setIsLikeLoading(false);
      }
    })();
    return () => { active = false; };
  }, [currentUserId, isStoryOwner, story?.id, story?.source_story_id]);

  const handleToggleLike = async () => {
    if (!story || !currentUserId || isStoryOwner || isLikeSaving) return;
    setIsLikeSaving(true);
    try {
      if (isLiked) {
        const { error } = await supabase.from('profile_highlight_likes').delete().eq('highlight_id', story.id).eq('user_id', currentUserId);
        if (error) throw error;
        setIsLiked(false);
      } else {
        const { error } = await supabase.from('profile_highlight_likes').upsert(
          { highlight_id: story.id, user_id: currentUserId },
          { onConflict: 'highlight_id,user_id', ignoreDuplicates: true },
        );
        if (error) throw error;
        setIsLiked(true);
        const { error: notificationError } = await supabase.from('notifications').insert({
          user_id: activeCollection.user_id,
          actor_id: currentUserId,
          type: 'like',
          content: 'أعجب بأبرز قصصك',
          reference_id: story.id,
        });
        if (notificationError) console.warn('[profile highlights] تعذر إرسال إشعار الإعجاب:', notificationError);
      }
    } catch (error) {
      console.error('[profile highlights] تعذر حفظ الإعجاب:', error);
      toast.error('تعذر حفظ الإعجاب. حاول مرة أخرى.');
    } finally {
      setIsLikeSaving(false);
    }
  };

  const handleSendReply = async () => {
    const text = replyText.trim();
    if (!story || !currentUserId || isStoryOwner || !text || isSendingReply) return;
    setIsSendingReply(true);
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: activeCollection.user_id,
        content: story.source_story_id ? `[story-reply]${text}` : `رد على أبرز القصص «${activeCollection.title}»: ${text}`,
        ...(story.source_story_id ? { story_id: story.source_story_id } : {}),
      });
      if (error) throw error;
      const { error: notificationError } = await supabase.from('notifications').insert({
        user_id: activeCollection.user_id,
        actor_id: currentUserId,
        type: 'reply',
        content: `رد على أبرز قصصك: ${text}`,
        reference_id: story.source_story_id || story.id,
      });
      if (notificationError) console.warn('[profile highlights] تعذر إرسال إشعار الرد:', notificationError);
      setReplyText('');
      toast.success('تم إرسال الرد إلى صاحب أبرز القصص');
    } catch (error) {
      console.error('[profile highlights] تعذر إرسال الرد:', error);
      toast.error('تعذر إرسال الرد. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setIsSendingReply(false);
    }
  };

  if (!story) return null;

  return createPortal(
    <div className="fixed inset-0 z-[2100] h-[100dvh] w-screen overflow-hidden bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label={`أبرز القصص: ${activeCollection.title}`}>
      <div ref={progressContainerRef} className="pointer-events-none absolute inset-x-2 z-30 flex gap-1 px-1" style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}>
        {activeCollection.stories.map((item, index) => (
          <div key={item.id} className="h-[2px] flex-1 overflow-hidden rounded-full bg-white/35">
            <div
              ref={index === activeIndex ? progressFillRef : null}
              data-story-progress-fill
              className="h-full bg-white"
              style={{ width: index < activeIndex ? '100%' : '0%' }}
            />
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-40 bg-gradient-to-b from-black/70 via-black/25 to-transparent" />

      {story.media_url && story.media_type === 'video' ? (
        <video
          key={story.id}
          ref={videoRef}
          src={story.media_url}
          className="absolute inset-0 z-0 h-full w-full object-contain"
          playsInline
          preload="metadata"
          data-duration={storyDuration}
          onLoadedMetadata={event => {
            const video = event.currentTarget;
            const metadataDuration = video.duration;
            const storedDuration = Number(video.dataset.duration);
            const duration = Number.isFinite(metadataDuration) && metadataDuration > 0 ? metadataDuration : storedDuration;
            setMediaReadyStoryId(story.id);
            if (Number.isFinite(duration) && duration > 0) {
              setStoryDurations(current => ({ ...current, [story.id]: duration }));
            }
          }}
          onError={() => setMediaReadyStoryId(story.id)}
        />
      ) : story.media_url ? (
        <img
          key={story.id}
          src={story.media_url}
          className="absolute inset-0 z-0 h-full w-full object-contain"
          data-duration={storyDuration}
          alt={story.caption || activeCollection.title}
          onLoad={event => {
            const duration = Number(event.currentTarget.dataset.duration);
            if (Number.isFinite(duration) && duration > 0 && (!story.source_story_id || durationsLoaded)) {
              const durationKey = story.source_story_id || story.id;
              setStoryDurations(current => ({ ...current, [durationKey]: duration }));
            }
            setMediaReadyStoryId(story.id);
          }}
          onError={() => setMediaReadyStoryId(story.id)}
        />
      ) : (
        <div className="absolute inset-0 z-0 flex items-center justify-center bg-gradient-to-br from-[#30303a] to-[#111116] px-8 text-center">
          <p className="whitespace-pre-wrap text-2xl font-bold">{story.caption || 'قصة نصية'}</p>
        </div>
      )}

      <header className="absolute inset-x-0 z-40 flex items-center justify-between px-4" style={{ top: 'calc(env(safe-area-inset-top, 44px) + 22px)' }}>
        <div className="flex min-w-0 items-center gap-2">
          <Avatar profile={{ avatar_url: ownerAvatarUrl, full_name: ownerName, username: ownerName, id: activeCollection.user_id }} />
          <div className="min-w-0">
            <p className="max-w-[58vw] truncate text-sm font-bold text-white">{ownerName || 'محمد'}</p>
            <time dateTime={story.created_at} className="mt-0.5 block text-[10px] text-white/75">{formatDate(story.created_at) || 'قصة محفوظة'}</time>
          </div>
        </div>
        <button type="button" onClick={closeViewer} aria-label="إغلاق أبرز القصص" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/30 text-white backdrop-blur-sm"><X size={22} /></button>
      </header>

      <div className={`pointer-events-none absolute inset-x-5 z-40 text-center text-lg font-bold text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] transition-all duration-500 ${activeIndex === 0 && titleToastVisible ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0'}`} style={{ top: 'calc(env(safe-area-inset-top, 44px) + 74px)' }} aria-live="polite">
        {activeCollection.title || ownerName}
      </div>

      <button type="button" aria-label="القصة التالية" onClick={() => goToStory(activeIndex + 1)} className="absolute inset-y-0 left-0 z-20 w-1/2 bg-transparent" style={{ bottom: isStoryOwner ? undefined : '5.5rem' }} />
      <button type="button" aria-label="القصة السابقة" onClick={() => goToStory(activeIndex - 1)} className="absolute inset-y-0 right-0 z-20 w-1/2 bg-transparent" style={{ bottom: isStoryOwner ? undefined : '5.5rem' }} />

      {story.caption?.trim() && story.media_url && <p className="pointer-events-none absolute inset-x-4 z-30 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] rounded-xl bg-black/55 p-3 text-center text-sm text-white">{story.caption}</p>}

      {!isStoryOwner && (
        <div className="absolute inset-x-0 bottom-0 z-50 flex items-center gap-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pt-5" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }} onClick={event => event.stopPropagation()}>
          <div className="flex min-w-0 flex-1 items-center rounded-full border border-zinc-700/70 bg-zinc-900/95 px-3 py-2 shadow-lg">
            <input
              key={story.id}
              type="text"
              placeholder={currentUserId ? 'رد على أبرز القصص...' : 'سجّل الدخول لإرسال رد'}
              aria-label="اكتب رداً على أبرز القصص"
              maxLength={3900}
              value={replyText}
              disabled={!currentUserId || isSendingReply}
              onFocus={() => { setIsPaused(true); videoRef.current?.pause(); }}
              onBlur={() => setIsPaused(false)}
              onChange={event => setReplyText(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleSendReply();
                }
              }}
              className="w-full min-w-0 bg-transparent text-xs text-white outline-none placeholder-zinc-400 disabled:opacity-60"
            />
            {replyText.trim() && (
              <button type="button" onClick={() => void handleSendReply()} disabled={!currentUserId || isSendingReply} aria-label="إرسال الرد" className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pink-400 transition hover:bg-white/10 disabled:opacity-50">
                {isSendingReply ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
              </button>
            )}
          </div>
          <button type="button" onClick={() => void handleToggleLike()} disabled={!currentUserId || isLikeLoading || isLikeSaving} aria-label={isLiked ? 'إلغاء الإعجاب بأبرز القصص' : 'الإعجاب بأبرز القصص'} aria-pressed={isLiked} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-700/70 bg-zinc-900/90 transition disabled:opacity-50 ${isLiked ? 'text-pink-500' : 'text-white'}`}>
            {isLikeLoading || isLikeSaving ? <Loader2 size={17} className="animate-spin" /> : <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
