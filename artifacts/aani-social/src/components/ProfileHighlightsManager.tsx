import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, ImagePlus, Plus, Upload, X } from 'lucide-react';

import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';

type HighlightMediaType = 'image' | 'video' | 'text';

type ArchiveStory = {
  id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
  is_close_friends: boolean;
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

function mediaPreview(mediaUrl: string | null, mediaType: string, caption: string | null, className: string, controls = true) {
  if (mediaUrl && mediaType === 'video') {
    return <video src={mediaUrl} className={className} controls={controls} muted={!controls} playsInline preload="metadata" />;
  }
  if (mediaUrl) return <img src={mediaUrl} className={className} alt="معاينة القصة" />;
  return <div className={`${className} flex items-center justify-center whitespace-pre-wrap break-words bg-gradient-to-br from-[#30303a] to-[#111116] p-6 text-center text-lg font-bold text-white`}>{caption || 'قصة نصية'}</div>;
}

export default function ProfileHighlightsManager({
  open,
  onClose,
  userId,
  collections,
  existingSourceStoryIds,
  onHighlightAdded,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  collections: ProfileHighlightCollection[];
  existingSourceStoryIds: Set<string>;
  onHighlightAdded: (collection: ProfileHighlightCollectionSummary, highlight: ProfileHighlight) => void;
}) {
  useModalBodyScrollLock();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'archive' | 'studio'>('archive');
  const [step, setStep] = useState<'media' | 'collection'>('media');
  const [archiveStories, setArchiveStories] = useState<ArchiveStory[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [selectedArchiveStory, setSelectedArchiveStory] = useState<ArchiveStory | null>(null);
  const [studioFile, setStudioFile] = useState<File | null>(null);
  const [studioPreviewUrl, setStudioPreviewUrl] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState('');
  const [collectionTitleDraft, setCollectionTitleDraft] = useState('');
  const [saving, setSaving] = useState(false);

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
      if (step === 'collection') setStep('media');
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, saving, step]);

  const close = () => {
    if (saving) return;
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

  if (!open) return null;

  const canContinue = step === 'media' && (tab === 'archive' ? Boolean(selectedArchiveStory) : Boolean(studioFile));
  const selectedMediaUrl = selectedArchiveStory ? selectedArchiveStory.media_url : studioPreviewUrl;
  const selectedMediaType = selectedArchiveStory ? selectedArchiveStory.media_type : (studioFile?.type.startsWith('video/') ? 'video' : 'image');
  const selectedMediaCaption = selectedArchiveStory ? captionDraft : studioFile?.name || captionDraft;

  return createPortal(
    <div className="fixed inset-0 z-[2200] flex h-[100dvh] w-full flex-col bg-[#09090B] text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="استوديو أبرز القصص">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div>
          <h2 className="text-lg font-black">استوديو أبرز القصص</h2>
          <p className="mt-1 text-xs text-zinc-400">احفظ من الأرشيف أو أضف وسيطاً جديداً دون نشر ستوري.</p>
        </div>
        <button type="button" onClick={close} aria-label="إغلاق الاستوديو" className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/15" disabled={saving}>
          <X size={20} />
        </button>
      </header>

      <div className="flex shrink-0 gap-2 border-b border-white/10 px-4 py-3">
        <button type="button" onClick={() => { setTab('archive'); setStep('media'); }} aria-pressed={tab === 'archive'} className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-bold transition ${tab === 'archive' ? 'bg-white text-black' : 'bg-white/5 text-zinc-300'}`}>
          الأرشيف
        </button>
        <button type="button" onClick={() => { setTab('studio'); setStep('media'); }} aria-pressed={tab === 'studio'} className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-bold transition ${tab === 'studio' ? 'bg-white text-black' : 'bg-white/5 text-zinc-300'}`}>
          الاستوديو
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'archive' ? (
          <div className="mx-auto w-full max-w-4xl">
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
                {selectedArchiveStory && (
                  <div className="mb-5 grid gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
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
                <p className="mb-3 text-xs text-zinc-400">اختر قصة منتهية لمعاينتها ثم أضفها إلى مجموعة.</p>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {archiveStories.map(story => {
                    const alreadyAdded = existingSourceStoryIds.has(story.id);
                    const selected = selectedArchiveStory?.id === story.id;
                    return (
                      <button key={story.id} type="button" onClick={() => selectArchiveStory(story)} disabled={alreadyAdded} aria-pressed={selected} className={`group relative aspect-[4/5] overflow-hidden rounded-xl border bg-zinc-900 text-left transition ${selected ? 'border-[#1D9BF0] ring-2 ring-[#1D9BF0]/50' : 'border-white/10'} disabled:cursor-not-allowed disabled:opacity-45`}>
                        {mediaPreview(story.media_url, story.media_type, story.caption, 'h-full w-full object-cover', false)}
                        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-2 pb-2 pt-7 text-right text-[10px] text-white">{alreadyAdded ? 'مضافة' : story.caption?.trim() || 'قصة محفوظة'}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4">
            {!studioFile ? (
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-60 w-full flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-white/20 bg-white/[0.03] px-6 text-center transition hover:border-[#1D9BF0] hover:bg-[#1D9BF0]/5">
                <span className="grid h-16 w-16 place-items-center rounded-2xl bg-[#1D9BF0]/15 text-[#56B4F5]"><ImagePlus size={30} /></span>
                <span><strong className="block text-base">اختر صورة أو فيديو</strong><span className="mt-2 block text-sm text-zinc-400">ستتم معاينة الوسيط قبل إضافته إلى مجموعة أبرز القصص.</span></span>
                <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-black"><Upload size={16} /> اختيار ملف</span>
              </button>
            ) : (
              <>
                <div className="relative aspect-[9/14] max-h-[54dvh] w-full overflow-hidden rounded-2xl bg-black">
                  {studioFile.type.startsWith('video/') ? (
                    <video src={studioPreviewUrl || undefined} className="h-full w-full object-contain" controls playsInline />
                  ) : (
                    <img src={studioPreviewUrl || ''} className="h-full w-full object-contain" alt="معاينة الوسيط المختار" />
                  )}
                  <button type="button" onClick={() => { setStudioFile(null); setCaptionDraft(''); }} aria-label="إزالة الوسيط المختار" className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-black/70 text-white"><X size={18} /></button>
                </div>
                <div className="w-full rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <p className="truncate text-xs text-zinc-400">{studioFile.name}</p>
                  <label className="mt-3 block text-xs font-semibold text-zinc-300" htmlFor="studio-highlight-caption">وصف القصة (اختياري)</label>
                  <textarea id="studio-highlight-caption" value={captionDraft} onChange={event => setCaptionDraft(event.currentTarget.value)} maxLength={500} rows={2} className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-white outline-none focus:border-[#1D9BF0]" placeholder="اكتب وصفاً قصيراً..." />
                </div>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="text-sm font-semibold text-[#56B4F5]">اختيار ملف آخر</button>
              </>
            )}
            <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" aria-label="اختيار صورة أو فيديو لإضافته إلى أبرز القصص" onChange={selectStudioFile} />
          </div>
        )}
      </div>

      {canContinue && (
        <footer className="shrink-0 border-t border-white/10 bg-[#09090B] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
          <button type="button" onClick={continueToCollections} className="mx-auto flex min-h-12 w-full max-w-xl items-center justify-center gap-2 rounded-full bg-[#1D9BF0] px-5 text-sm font-black text-white transition hover:bg-[#1686d4]">
            <Check size={18} /> تم
          </button>
        </footer>
      )}

      {step === 'collection' && (
        <div className="fixed inset-0 z-[2300] flex items-end justify-center bg-black/75" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setStep('media'); }}>
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
    </div>,
    document.body,
  );
}

export function ProfileHighlightViewer({ collection, onClose }: { collection: ProfileHighlightCollection; onClose: () => void }) {
  useModalBodyScrollLock();
  const [activeIndex, setActiveIndex] = useState(0);
  const story = collection.stories[activeIndex];
  const hasPrevious = activeIndex > 0;
  const hasNext = activeIndex < collection.stories.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setActiveIndex(index => Math.max(0, index - 1));
      if (event.key === 'ArrowLeft') setActiveIndex(index => Math.min(collection.stories.length - 1, index + 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collection.stories.length, onClose]);

  if (!story) return null;

  return createPortal(
    <div className="fixed inset-0 z-[2100] flex h-[100dvh] flex-col items-center justify-center bg-black/95 p-4 text-white" dir="rtl" role="dialog" aria-modal="true" aria-label={collection.title}>
      <button type="button" onClick={onClose} aria-label="إغلاق العرض" className="absolute left-4 top-[calc(env(safe-area-inset-top)+1rem)] z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10"><X size={20} /></button>
      <div className="absolute top-[calc(env(safe-area-inset-top)+1.25rem)] text-center">
        <h2 className="font-bold">{collection.title}</h2>
        <p className="mt-1 text-xs text-zinc-400">{activeIndex + 1} / {collection.stories.length}</p>
      </div>
      <div className="relative flex h-full max-h-[85dvh] w-full max-w-lg items-center justify-center overflow-hidden rounded-2xl bg-zinc-950">
        {story.media_url && story.media_type === 'video' ? (
          <video key={story.id} src={story.media_url} className="h-full w-full object-contain" controls autoPlay playsInline />
        ) : story.media_url ? (
          <img src={story.media_url} className="h-full w-full object-contain" alt={story.caption || collection.title} />
        ) : (
          <p className="whitespace-pre-wrap px-8 text-center text-2xl font-bold">{story.caption || 'قصة نصية'}</p>
        )}
        {hasPrevious && <button type="button" onClick={() => setActiveIndex(index => index - 1)} aria-label="القصة السابقة" className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/60"><ChevronRight size={24} /></button>}
        {hasNext && <button type="button" onClick={() => setActiveIndex(index => index + 1)} aria-label="القصة التالية" className="absolute left-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/60"><ChevronLeft size={24} /></button>}
        {story.media_url && story.caption?.trim() && <p className="absolute inset-x-4 bottom-4 rounded-xl bg-black/65 p-3 text-center text-sm text-white">{story.caption}</p>}
      </div>
    </div>,
    document.body,
  );
}
