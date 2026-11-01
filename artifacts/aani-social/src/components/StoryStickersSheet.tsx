import { useEffect, useMemo, useState } from 'react';
import { ImagePlus, Plus, Search, Sparkles, X } from 'lucide-react';

import StickerCutoutStudio from './StickerCutoutStudio';
import { STICKER_CATEGORIES, STICKERS, type StickerCategory } from '@/lib/stickerLibrary';

export interface PickedSticker {
  type: 'emoji' | 'image';
  value: string;
}

interface StoryStickersSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (sticker: PickedSticker) => void;
  myStickers: string[];
  onAddMySticker: (dataUrl: string) => void;
}

type SheetTab = 'mine' | 'library';

export default function StoryStickersSheet({
  open,
  onClose,
  onPick,
  myStickers,
  onAddMySticker,
}: StoryStickersSheetProps) {
  const [tab, setTab] = useState<SheetTab>('library');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<StickerCategory>('reactions');
  const [studioOpen, setStudioOpen] = useState(false);
  const [remoteStickers, setRemoteStickers] = useState<string[]>([]);

  // إن وُجد مفتاح Tenor في متغيرات البيئة تُجلب ملصقات التريند العالمية
  useEffect(() => {
    if (!open) return;
    const apiKey = import.meta.env.VITE_TENOR_API_KEY as string | undefined;
    if (!apiKey) return;

    let cancelled = false;
    const query = search.trim() || 'reaction stickers';
    fetch(
      `https://g.tenor.com/v2/search?q=${encodeURIComponent(query)}&key=${apiKey}&limit=24&searchfilter=sticker`,
    )
      .then(response => (response.ok ? response.json() : null))
      .then((data: { results?: Array<{ media_formats?: { gif?: { url?: string } } }> } | null) => {
        if (cancelled || !data?.results) return;
        const urls = data.results
          .map(item => item.media_formats?.gif?.url)
          .filter((url): url is string => Boolean(url));
        setRemoteStickers(urls);
      })
      .catch(() => {
        /* بدون اتصال: تبقى المكتبة المحلية متاحة */
      });

    return () => {
      cancelled = true;
    };
  }, [open, search]);

  const library = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query) {
      return STICKERS.filter(item => item.label.toLowerCase().includes(query));
    }
    return STICKERS.filter(item => item.category === category);
  }, [category, search]);

  const mine = useMemo(() => (search.trim() ? [] : myStickers), [myStickers, search]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] flex flex-col justify-end" dir="rtl">
        <button
          type="button"
          aria-label="إغلاق الملصقات"
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[1px]"
        />

        <div className="aani-sheet-in relative z-10 flex h-[62vh] flex-col overflow-hidden rounded-t-[26px] border-t border-white/10 bg-[#141519] text-white shadow-[0_-16px_40px_rgba(0,0,0,0.6)]">
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/25" />

          <div className="flex items-center justify-between px-4 pt-2 pb-1">
            <span className="text-[14px] font-bold">الملصقات</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStudioOpen(true)}
                className="flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-bold transition active:scale-95"
              >
                <Plus size={13} />
                صنع ملصق
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="إغلاق"
                className="rounded-full p-1 text-white/70 transition hover:bg-white/10"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="px-4 pt-1">
            <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
              <Search size={15} className="text-white/50" />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="ابحث عن ملصق"
                className="w-full bg-transparent text-[12px] outline-none placeholder:text-white/40"
              />
            </div>
          </div>

          {tab === 'library' && !search.trim() && (
            <div className="aani-hscroll mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
              {STICKER_CATEGORIES.map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setCategory(item.key)}
                  className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition ${
                    category === item.key ? 'bg-white font-bold text-[#121212]' : 'bg-white/10 text-white/70'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <div className="aani-hscroll mt-2 flex-1 overflow-y-auto px-4 pb-3">
            {tab === 'library' && remoteStickers.length > 0 && (
              <div className="mb-3">
                <p className="mb-1.5 text-[10px] text-white/40">تريند عالمي</p>
                <div className="aani-hscroll flex gap-2 overflow-x-auto pb-1">
                  {remoteStickers.map(src => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => onPick({ type: 'image', value: src })}
                      className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-white/5 p-1.5 transition active:scale-90"
                    >
                      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === 'library' && (
              <div className="grid grid-cols-3 gap-2">
                {library.map(sticker => (
                  <button
                    key={sticker.id}
                    type="button"
                    onClick={() => onPick({ type: 'image', value: sticker.src })}
                    className="flex aspect-square items-center justify-center rounded-2xl bg-white/5 p-2 transition active:scale-90"
                  >
                    <img src={sticker.src} alt={sticker.label} className="max-h-full max-w-full object-contain" />
                  </button>
                ))}
                {library.length === 0 && (
                  <p className="col-span-3 py-6 text-center text-[12px] text-white/40">لا توجد نتائج</p>
                )}
              </div>
            )}

            {tab === 'mine' && (
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setStudioOpen(true)}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/25 text-white/60 transition active:scale-95"
                >
                  <Plus size={20} />
                  <span className="text-[9px]">ملصق جديد</span>
                </button>

                {mine.map((dataUrl, index) => (
                  <button
                    key={`${dataUrl.slice(-24)}-${index}`}
                    type="button"
                    onClick={() => onPick({ type: 'image', value: dataUrl })}
                    className="flex aspect-square items-center justify-center rounded-2xl bg-white/5 p-2 transition active:scale-90"
                  >
                    <img src={dataUrl} alt="" className="max-h-full max-w-full object-contain" />
                  </button>
                ))}

                {mine.length === 0 && (
                  <p className="col-span-2 self-center py-6 text-center text-[11px] leading-5 text-white/40">
                    لا توجد ملصقات بعد — اضغط «صنع ملصق» لقص أي عنصر من صورك
                  </p>
                )}
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-around border-t border-white/10 bg-black/40 px-2 py-1.5"
            style={{ paddingBottom: 'calc(0.4rem + env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={() => setTab('mine')}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1 text-[10px] transition ${
                tab === 'mine' ? 'text-white' : 'text-white/45'
              }`}
            >
              <ImagePlus size={19} />
              ملصقاتي
            </button>
            <button
              type="button"
              onClick={() => setTab('library')}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1 text-[10px] transition ${
                tab === 'library' ? 'text-white' : 'text-white/45'
              }`}
            >
              <Sparkles size={19} />
              الملصقات
            </button>
          </div>
        </div>
      </div>

      <StickerCutoutStudio
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
        onDone={dataUrl => {
          onAddMySticker(dataUrl);
          onPick({ type: 'image', value: dataUrl });
          setStudioOpen(false);
          setTab('mine');
        }}
      />
    </>
  );
}
