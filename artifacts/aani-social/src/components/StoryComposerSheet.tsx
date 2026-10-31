import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Camera, Check, ChevronDown, X } from 'lucide-react';

type StoryMedia = {
  id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
};

type StoryComposerSheetProps = {
  open: boolean;
  onClose: () => void;
  onFilesSelected: (files: File[]) => void;
  onTextMode: () => void;
  archive: StoryMedia[];
};

type TabKey = 'all' | 'favorites' | 'photos' | 'videos';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'الكل' },
  { key: 'favorites', label: 'المفضلات' },
  { key: 'photos', label: 'الصور' },
  { key: 'videos', label: 'الفيديوهات' },
];

const FAVORITES_KEY = 'aani:story-favorites';

const fileKey = (file: File) => `${file.name}-${file.size}`;

/**
 * درج سفلي لاختيار وسائط القصة: تبويبات تصفية، شبكة ثلاثية، اختيار متعدد،
 * وأرشيف قصصك السابقة — بتصميم داكن وانبثاق سلس من الأسفل.
 */
const StoryComposerSheet: React.FC<StoryComposerSheetProps> = ({
  open,
  onClose,
  onFilesSelected,
  onTextMode,
  archive,
}) => {
  const [shown, setShown] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [tab, setTab] = useState<TabKey>('all');
  const [multiSelect, setMultiSelect] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }

    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const previews = useMemo(
    () => files.map(file => ({ file, url: URL.createObjectURL(file), key: fileKey(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      previews.forEach(preview => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      /* التخزين المحلي غير متاح */
    }
  }, [favorites]);

  if (!open) return null;

  const filtered = previews
    .filter(preview => {
      const isVideo = preview.file.type.startsWith('video');

      if (tab === 'photos') return !isVideo;
      if (tab === 'videos') return isVideo;
      if (tab === 'favorites') return favorites.includes(preview.key);
      return true;
    })
    .sort((a, b) => (newestFirst ? b.file.lastModified - a.file.lastModified : a.file.lastModified - b.file.lastModified));

  const toggleSelection = (key: string) => {
    if (!multiSelect) {
      setSelected([key]);
      return;
    }

    setSelected(prev => (prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]));
  };

  const toggleFavorite = (key: string) => {
    setFavorites(prev => (prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]));
  };

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = '';

    if (picked.length === 0) return;

    setFiles(prev => [...picked, ...prev]);
    setSelected(picked.map(fileKey).slice(0, multiSelect ? undefined : 1));
  };

  const confirm = () => {
    const chosen = previews.filter(preview => selected.includes(preview.key)).map(preview => preview.file);
    if (chosen.length === 0) return;

    onFilesSelected(chosen);
    setSelected([]);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 backdrop-blur-sm"
      dir="rtl"
      role="presentation"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="إضافة إلى قصة"
        onClick={event => event.stopPropagation()}
        className={`relative flex h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-b-0 border-[#26262e] bg-[#121212] text-white shadow-2xl transition-transform duration-300 ease-out ${
          shown ? 'translate-y-0' : 'translate-y-full'
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
              onClick={() => setShowArchive(value => !value)}
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

          {/* أدوات التصفية */}
          <div className="mt-3 flex items-center justify-between gap-3 px-4">
            <button
              type="button"
              onClick={() => setNewestFirst(value => !value)}
              className="flex items-center gap-1 rounded-lg border border-[#26262e] bg-[#17171b] px-3 py-1.5 text-[11px] text-zinc-300"
            >
              {newestFirst ? 'الحديثة' : 'القديمة'}
              <ChevronDown size={14} className="text-zinc-500" />
            </button>

            <label className="flex items-center gap-2 text-[11px] text-zinc-300">
              اختيار متعدد
              <button
                type="button"
                role="switch"
                aria-checked={multiSelect}
                onClick={() => {
                  setMultiSelect(value => {
                    const next = !value;
                    if (!next) setSelected(prev => prev.slice(0, 1));
                    return next;
                  });
                }}
                className={`relative h-6 w-11 rounded-full transition ${multiSelect ? 'bg-zinc-200' : 'bg-[#2b2b34]'}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#121212] transition-all ${
                    multiSelect ? 'right-5' : 'right-0.5'
                  }`}
                />
              </button>
            </label>
          </div>

          {showArchive ? (
            /* الأرشيف */
            <div className="px-4 pb-6 pt-3">
              {archive.length === 0 ? (
                <p className="py-10 text-center text-xs text-zinc-500">لا توجد قصص مؤرشفة بعد</p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {archive.map((story, index) => (
                    <div
                      key={story.id}
                      className="aani-media-tile relative aspect-square overflow-hidden rounded-lg border border-[#26262e] bg-[#17171b]"
                      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                    >
                      {story.media_url && story.media_type !== 'text' ? (
                        story.media_type === 'video' ? (
                          <video src={story.media_url} muted playsInline className="h-full w-full object-cover" />
                        ) : (
                          <img src={story.media_url} alt="" className="h-full w-full object-cover" />
                        )
                      ) : (
                        <p className="line-clamp-4 p-2 text-[10px] leading-4 text-zinc-400">{story.caption}</p>
                      )}
                    </div>
                  ))}
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
                  {/* الكاميرا */}
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="aani-media-tile flex aspect-square items-center justify-center rounded-lg border border-[#26262e] bg-[#17171b] text-zinc-300 transition hover:bg-[#1f1f27]"
                  >
                    <Camera size={24} />
                  </button>

                  {filtered.map((preview, index) => {
                    const isSelected = selected.includes(preview.key);

                    return (
                      <button
                        key={preview.key}
                        type="button"
                        onClick={() => toggleSelection(preview.key)}
                        onDoubleClick={() => toggleFavorite(preview.key)}
                        className="aani-media-tile relative aspect-square overflow-hidden rounded-lg border border-[#26262e] bg-[#17171b]"
                        style={{ animationDelay: `${Math.min(index, 15) * 30}ms` }}
                      >
                        {preview.file.type.startsWith('video') ? (
                          <video src={preview.url} muted playsInline className="h-full w-full object-cover" />
                        ) : (
                          <img src={preview.url} alt="" className="h-full w-full object-cover" />
                        )}

                        {multiSelect && (
                          <span
                            className={`absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border ${
                              isSelected ? 'border-white bg-white text-[#121212]' : 'border-white/80 bg-black/25'
                            }`}
                          >
                            {isSelected && <Check size={11} />}
                          </span>
                        )}

                        {favorites.includes(preview.key) && (
                          <span className="absolute bottom-1 left-1 rounded-full bg-black/60 px-1 text-[9px] text-zinc-200">
                            ★
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {filtered.length === 0 && (
                  <div className="py-10 text-center">
                    <p className="text-xs text-zinc-500">
                      {tab === 'favorites' ? 'لا توجد عناصر مفضلة — انقر مطولًا على أي وسائط لإضافتها' : 'لا توجد وسائط بعد'}
                    </p>
                    <button
                      type="button"
                      onClick={() => galleryInputRef.current?.click()}
                      className="mt-3 rounded-full border border-[#2f2f39] px-4 py-2 text-[11px] text-zinc-200"
                    >
                      اختيار من الاستوديو
                    </button>
                  </div>
                )}
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
