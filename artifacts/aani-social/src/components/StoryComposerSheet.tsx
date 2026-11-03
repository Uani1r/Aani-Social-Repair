import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Camera, Check, ImagePlus, Play, X } from 'lucide-react';

import StoryImageSticker from '@/components/StoryImageSticker';
import type { StoryImageOverlay, StoryMediaTransformOverlay, StoryRow, StoryTextOverlay, StoryCanvasStyleOverlay } from '@/components/stories/types';

type StoryMedia = StoryRow;

type StoryComposerSheetProps = {
  open: boolean;
  autoOpenGallery?: boolean;
  onClose: () => void;
  onFilesSelected: (files: File[]) => void;
  onTextMode: () => void;
  archive: StoryMedia[];
  archiveLoading: boolean;
  onOpenArchive: () => void;
  onOpenArchivedStory: (story: StoryMedia) => void;
};

type TabKey = 'all' | 'videos' | 'photos';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'الكل' },
  { key: 'photos', label: 'الصور' },
  { key: 'videos', label: 'الفيديوهات' },
];

const fileKey = (file: File) => `${file.name}-${file.size}`;

/**
 * درج سفلي لاختيار وسائط القصة: تبويبات تصفية، شبكة ثلاثية، اختيار متعدد،
 * وأرشيف قصصك السابقة — بتصميم داكن وانبثاق سلس من الأسفل.
 */
const StoryComposerSheet: React.FC<StoryComposerSheetProps> = ({
  open,
  autoOpenGallery = true,
  onClose,
  onFilesSelected,
  onTextMode,
  archive,
  archiveLoading,
  onOpenArchive,
  onOpenArchivedStory,
}) => {
  const [shown, setShown] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [tab, setTab] = useState<TabKey>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [showArchive, setShowArchive] = useState(false);

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setShown(false);
      setShowArchive(false);
      return;
    }

    const raf = requestAnimationFrame(() => setShown(true));

    // فتح استوديو الجهاز تلقائيًا عند ظهور الدرج (بدون زر وسيط)
    const timer = autoOpenGallery
      ? window.setTimeout(() => {
          galleryInputRef.current?.click();
        }, 350)
      : null;

    return () => {
      cancelAnimationFrame(raf);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, autoOpenGallery]);

  const previews = useMemo(
    () => files.map(file => ({ file, url: URL.createObjectURL(file), key: fileKey(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      previews.forEach(preview => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  if (!open) return null;

  const filtered = previews
    .filter(preview => {
      const isVideo = preview.file.type.startsWith('video');

      if (tab === 'photos') return !isVideo;
      if (tab === 'videos') return isVideo;
      return true;
    })
    .sort((a, b) => b.file.lastModified - a.file.lastModified);

  const toggleSelection = (key: string) => {
    setSelected(prev => (prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]));
  };

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = '';

    if (picked.length === 0) return;

    setFiles(prev => [...picked, ...prev]);
    setSelected(picked.map(fileKey));
  };

  const confirm = () => {
    const chosen = previews.filter(preview => selected.includes(preview.key)).map(preview => preview.file);
    if (chosen.length === 0) return;

    onFilesSelected(chosen);
    setSelected([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[120] bg-[#121212]" dir="rtl" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="إضافة إلى قصة"
        className={`relative flex h-full w-full flex-col overflow-hidden bg-[#121212] text-white transition-transform duration-300 ease-out ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* الرأس */}
        <header className="relative flex shrink-0 items-center justify-center border-b border-[#232329] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="absolute right-3 rounded-full p-1.5 text-zinc-400 transition hover:bg-[#1f1f27] hover:text-white"
          >
            <X size={20} />
          </button>
          <h2 className="text-[15px] font-bold text-white">إضافة إلى قصة</h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* إجراءات سريعة */}
          <div className="grid grid-cols-2 gap-2.5 px-4 pt-3">
            <button
              type="button"
              onClick={() => {
                const openingArchive = !showArchive;
                setShowArchive(openingArchive);
                if (openingArchive) onOpenArchive();
              }}
              className={`flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border text-[12px] font-semibold transition ${
                showArchive ? 'border-zinc-500 bg-[#1f1f27] text-white' : 'border-[#26262e] bg-[#17171b] text-zinc-300 hover:bg-[#1f1f27]'
              }`}
            >
              <Archive size={22} className="text-zinc-300" />
              الأرشيف
            </button>
            <button
              type="button"
              onClick={onTextMode}
              className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border border-[#26262e] bg-[#17171b] text-[12px] font-semibold text-zinc-300 transition hover:bg-[#1f1f27]"
            >
              <span className="text-lg font-bold leading-none">Aa</span>
              النص
            </button>
          </div>

          {showArchive ? (
            /* الأرشيف */
            <div className="px-4 pb-6 pt-3">
              {archiveLoading ? (
                <p className="py-10 text-center text-xs text-zinc-500">جارٍ تحميل الأرشيف...</p>
              ) : archive.length === 0 ? (
                <p className="py-10 text-center text-xs text-zinc-500">لا توجد قصص مؤرشفة بعد</p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {archive.map((story, index) => {
                    const canvasStyle = story.timed_texts.find(
                      (item): item is StoryCanvasStyleOverlay => item.type === 'canvas-style',
                    );
                    const mediaTransform = story.timed_texts.find(
                      (item): item is StoryMediaTransformOverlay => item.type === 'media-transform',
                    );
                    const mediaTransformCss = mediaTransform
                      ? `translate(${mediaTransform.x}%, ${mediaTransform.y}%) scale(${mediaTransform.scale}) rotate(${mediaTransform.rotation}deg)`
                      : undefined;
                    const visualLayers = story.timed_texts.filter(
                      (item): item is StoryTextOverlay | StoryImageOverlay =>
                        item.type === undefined || item.type === 'text' || item.type === 'image',
                    );
                    const hasTextLayer = visualLayers.some(layer => layer.type === undefined || layer.type === 'text');

                    return (
                      <button
                        key={story.id}
                        type="button"
                        aria-label="فتح القصة في العارض"
                        onClick={() => onOpenArchivedStory(story)}
                        className="aani-media-tile relative aspect-square w-full overflow-hidden rounded-lg border border-[#26262e] bg-[#17171b] text-right"
                        style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                      >
                        {story.media_url && story.media_type !== 'text' ? (
                          story.media_type === 'video' ? (
                            <video src={story.media_url} muted playsInline className="h-full w-full object-cover" style={{ transform: mediaTransformCss, transformOrigin: 'center' }} />
                          ) : (
                            <img src={story.media_url} alt="" className="h-full w-full object-cover" style={{ transform: mediaTransformCss, transformOrigin: 'center' }} />
                          )
                        ) : (
                          <div className="absolute inset-0" style={{ background: canvasStyle?.background || '#1f1f27' }} />
                        )}
                        {visualLayers.map((layer, layerIndex) => {
                          const layerOrder = layer.layerOrder ?? layerIndex + 10;
                          if (layer.type === 'image') {
                            return (
                              <StoryImageSticker
                                key={layer.id}
                                sticker={layer}
                                interactive={false}
                                layerOrder={layerOrder}
                                sizeScale={0.3}
                              />
                            );
                          }

                          return (
                            <span
                              key={layer.id}
                              className="absolute z-10 w-[88%] max-w-[88%] whitespace-pre-wrap break-words px-1 text-center text-[8px] font-bold leading-tight"
                              style={{
                                left: `${layer.x}%`,
                                top: `${layer.y}%`,
                                transform: `translate(-50%, -50%) scale(${layer.scale ?? 1}) rotate(${layer.rotation ?? 0}deg)`,
                                zIndex: layerOrder,
                                fontSize: layer.fontSize ? `${layer.fontSize * 0.22}px` : undefined,
                                color: layer.textColor || canvasStyle?.textColor || '#FFFFFF',
                                fontFamily: layer.fontFamily || canvasStyle?.fontFamily || 'Cairo',
                                background: layer.textBackground || 'transparent',
                              }}
                            >
                              {layer.text}
                            </span>
                          );
                        })}
                        {!hasTextLayer && (!story.media_url || story.media_type === 'text') && (
                          <p
                            className="absolute left-1/2 top-1/2 line-clamp-4 w-[88%] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap text-center text-[10px] leading-4 text-zinc-200"
                            style={{
                              color: canvasStyle?.textColor || undefined,
                              fontFamily: canvasStyle?.fontFamily || undefined,
                              background: canvasStyle?.textBackground || undefined,
                            }}
                          >
                            {story.caption}
                          </p>
                        )}
                        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4 text-center text-[9px] font-semibold text-white/90">
                          فتح القصة
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* التبويبات */}
              <div className="mt-2 flex items-center gap-5 overflow-x-auto no-scrollbar border-b border-[#232329] px-4">
                {TABS.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setTab(item.key)}
                    className={`relative shrink-0 pb-2 pt-2 text-[12px] transition ${
                      tab === item.key ? 'font-bold text-white' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {item.label}
                    {tab === item.key && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-white" />}
                  </button>
                ))}
              </div>

              {/* الشبكة */}
              <div className="px-3 pb-28 pt-3">
                <div className="grid grid-cols-3 gap-1.5">
                  {tab === 'all' && (
                    <>
                      {/* الكاميرا */}
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="aani-media-tile flex aspect-square items-center justify-center rounded-lg border border-[#26262e] bg-[#17171b] text-zinc-300 transition hover:bg-[#1f1f27]"
                      >
                        <Camera size={24} />
                      </button>

                      {/* إعادة فتح استوديو الجهاز إن أُغلق المنتقي */}
                      <button
                        type="button"
                        onClick={() => galleryInputRef.current?.click()}
                        className="aani-media-tile flex aspect-square items-center justify-center rounded-lg border border-[#26262e] bg-[#17171b] text-zinc-300 transition hover:bg-[#1f1f27]"
                        style={{ animationDelay: '30ms' }}
                      >
                        <ImagePlus size={22} />
                      </button>
                    </>
                  )}

                  {filtered.map((preview, index) => {
                    const isSelected = selected.includes(preview.key);

                    return (
                      <button
                        key={preview.key}
                        type="button"
                        onClick={() => toggleSelection(preview.key)}
                        className="aani-media-tile relative aspect-square overflow-hidden rounded-lg border border-[#26262e] bg-[#17171b]"
                        style={{ animationDelay: `${Math.min(index + (tab === 'all' ? 2 : 0), 15) * 30}ms` }}
                      >
                        {preview.file.type.startsWith('video') ? (
                          <>
                            <video src={preview.url} muted playsInline className="h-full w-full object-cover" />
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm">
                                <Play size={16} fill="currentColor" />
                              </span>
                            </span>
                          </>
                        ) : (
                          <img src={preview.url} alt="" className="h-full w-full object-cover" />
                        )}

                        <span
                          className={`absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border ${
                            isSelected ? 'border-white bg-white text-[#121212]' : 'border-white/80 bg-black/25'
                          }`}
                        >
                          {isSelected && <Check size={11} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* شريط التأكيد */}
        {!showArchive && (
          <div
            className="absolute inset-x-0 bottom-0 border-t border-[#232329] bg-[#121212]/95 px-4 py-3 backdrop-blur"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={confirm}
              disabled={selected.length === 0}
              className="w-full rounded-full bg-white py-2.5 text-[13px] font-bold text-[#121212] transition disabled:opacity-40"
            >
              إضافة إلى قصة{selected.length ? ` (${selected.length})` : ''}
            </button>
          </div>
        )}

        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="sr-only"
          onChange={handleFileInput}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={handleFileInput}
        />
      </section>
    </div>
  );
};

export default StoryComposerSheet;
