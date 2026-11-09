import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Play, RefreshCw, X } from 'lucide-react';

import { normalizeStoryAuthor, normalizeStoryRow, type StoryCanvasStyleOverlay, type StoryMediaTransformOverlay, type StoryRow, type StoryTextOverlay } from '@/components/stories/types';
import { supabase, supabaseConfigured } from '@/lib/supabase';

export default function ProfileStoryArchiveView({ userId }: { userId: string }) {
  const [stories, setStories] = useState<StoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStory, setSelectedStory] = useState<StoryRow | null>(null);
  const requestIdRef = useRef(0);

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

  const closePreview = () => setSelectedStory(null);

  return (
    <div className="space-y-4 py-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">أرشيف القصص</h3>
          <p className="mt-1 text-xs leading-6 text-zinc-500">القصص التي انتهت مدة عرضها محفوظة هنا.</p>
        </div>
        <button
          type="button"
          aria-label="تحديث أرشيف القصص"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 transition hover:bg-zinc-800 hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="rounded-xl border border-[#262626] bg-[#0a0a0a] px-3 py-2.5 text-xs leading-6 text-zinc-500">
        أرشيف المنشورات غير متاح حالياً؛ الأرشيف المدعوم في التطبيق يقتصر على القصص.
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-sm text-red-300">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()} className="mt-3 rounded-full bg-white px-4 py-2 text-xs font-bold text-black">إعادة المحاولة</button>
        </div>
      ) : loading && stories.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500">جارٍ تحميل أرشيف القصص...</p>
      ) : stories.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-[#242424] bg-[#0a0a0a] px-5 py-12 text-center">
          <Archive size={30} className="text-zinc-600" />
          <p className="mt-3 text-sm font-semibold text-zinc-300">لا توجد قصص مؤرشفة بعد</p>
          <p className="mt-2 text-xs leading-6 text-zinc-500">ستظهر القصص هنا بعد انتهاء مدة عرضها.</p>
        </div>
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

      {selectedStory && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/90 p-4" role="presentation" onClick={closePreview}>
          <section className="relative flex h-[min(82dvh,720px)] w-full max-w-[390px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111] text-white shadow-2xl" role="dialog" aria-modal="true" aria-label="عرض قصة مؤرشفة" onClick={event => event.stopPropagation()}>
            <button type="button" aria-label="إغلاق القصة" onClick={closePreview} className="absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white"><X size={20} /></button>
            <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
              {(() => {
                const canvasStyle = selectedStory.timed_texts.find((layer): layer is StoryCanvasStyleOverlay => layer.type === 'canvas-style');
                const mediaTransform = selectedStory.timed_texts.find((layer): layer is StoryMediaTransformOverlay => layer.type === 'media-transform');
                const textLayers = selectedStory.timed_texts.filter((layer): layer is StoryTextOverlay => layer.type === undefined || layer.type === 'text');
                const transform = mediaTransform
                  ? `translate(${mediaTransform.x}%, ${mediaTransform.y}%) scale(${mediaTransform.scale}) rotate(${mediaTransform.rotation}deg)`
                  : undefined;
                return (
                  <div className="absolute inset-0" style={{ background: canvasStyle?.background || '#111' }}>
                    {selectedStory.media_url && selectedStory.media_type !== 'text' && (selectedStory.media_type === 'video' ? (
                      <video src={selectedStory.media_url} controls playsInline className="h-full w-full object-contain" style={{ transform }} />
                    ) : (
                      <img src={selectedStory.media_url} alt="" className="h-full w-full object-contain" style={{ transform }} />
                    ))}
                    {textLayers.map(layer => (
                      <span key={layer.id} className="absolute max-w-[88%] whitespace-pre-wrap break-words px-1 text-center font-bold" style={{
                        left: `${layer.x}%`,
                        top: `${layer.y}%`,
                        transform: `translate(-50%, -50%) scale(${layer.scale ?? 1}) rotate(${layer.rotation ?? 0}deg)`,
                        zIndex: layer.layerOrder ?? 10,
                        fontSize: `${Math.max(12, (layer.fontSize ?? 30) * 0.65)}px`,
                        color: layer.textColor || canvasStyle?.textColor || '#fff',
                        fontFamily: layer.fontFamily || canvasStyle?.fontFamily || undefined,
                        background: layer.textBackground || 'transparent',
                      }}>{layer.text}</span>
                    ))}
                    {!textLayers.length && selectedStory.caption && (!selectedStory.media_url || selectedStory.media_type === 'text') && (
                      <p className="absolute left-1/2 top-1/2 w-[88%] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap text-center text-lg leading-8" style={{ color: canvasStyle?.textColor || '#fff', fontFamily: canvasStyle?.fontFamily || undefined }}>{selectedStory.caption}</p>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="shrink-0 border-t border-white/10 px-4 py-3">
              <p className="text-xs text-zinc-400">{new Date(selectedStory.created_at).toLocaleString('ar')}</p>
              {selectedStory.caption && selectedStory.media_type !== 'text' && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white">{selectedStory.caption}</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
