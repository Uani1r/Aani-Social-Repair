import { useMemo, useState } from 'react';
import { Film, ImagePlus, Plus, Search, Smile, X } from 'lucide-react';

import StickerCutoutStudio from './StickerCutoutStudio';

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

type SheetTab = 'mine' | 'emoji' | 'gif';

interface StickerPack {
  key: string;
  label: string;
  items: string[];
}

const STICKER_PACKS: StickerPack[] = [
  {
    key: 'trending',
    label: 'رائج',
    items: ['🔥', '✨', '💫', '⚡', '🌟', '💥', '🌈', '🫧', '🎯', '👑', '💯', '🪄'],
  },
  {
    key: 'faces',
    label: 'وجوه',
    items: ['😂', '🥰', '😍', '😎', '🤩', '🥳', '😭', '🤔', '😴', '😇', '🫠', '🤯'],
  },
  {
    key: 'love',
    label: 'قلوب',
    items: ['❤️', '🩷', '🧡', '💛', '💚', '🩵', '💙', '💜', '🤍', '💖', '💘', '💞'],
  },
  {
    key: 'animals',
    label: 'حيوانات',
    items: ['🐱', '🐶', '🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🦄', '🐝', '🦋', '🐢'],
  },
  {
    key: 'party',
    label: 'احتفال',
    items: ['🎉', '🎊', '🎈', '🎁', '🕯️', '🥂', '🍾', '🎂', '🎵', '🎶', '🪩', '🎤'],
  },
  {
    key: 'food',
    label: 'طعام',
    items: ['☕', '🍕', '🍔', '🍟', '🍩', '🍰', '🍫', '🍓', '🥑', '🌮', '🍿', '🧋'],
  },
  {
    key: 'aani',
    label: 'آني',
    items: ['🇮🇶', '🌙', '⭐', '🕌', '🌴', '🫶', '🤍', '🕊️', '✨', '🌷', '💫', '🪬'],
  },
];

const GIF_STICKERS: string[] = ['💃', '🕺', '🤸', '🎉', '💥', '🔥', '💖', '⚡', '🌈', '🎈', '🌟', '🎊'];

const NAV: { key: SheetTab; label: string; Icon: typeof Smile }[] = [
  { key: 'mine', label: 'ملصقاتي', Icon: ImagePlus },
  { key: 'emoji', label: 'الإيموجي', Icon: Smile },
  { key: 'gif', label: 'GIF', Icon: Film },
];

export default function StoryStickersSheet({
  open,
  onClose,
  onPick,
  myStickers,
  onAddMySticker,
}: StoryStickersSheetProps) {
  const [tab, setTab] = useState<SheetTab>('emoji');
  const [search, setSearch] = useState('');
  const [activePack, setActivePack] = useState(STICKER_PACKS[0].key);
  const [studioOpen, setStudioOpen] = useState(false);

  const pack = useMemo(
    () => STICKER_PACKS.find(item => item.key === activePack) ?? STICKER_PACKS[0],
    [activePack],
  );

  const visibleEmojis = useMemo(() => {
    const query = search.trim();
    if (!query) return pack.items;
    const pool = STICKER_PACKS.flatMap(item => item.items);
    return Array.from(new Set(pool)).filter(item => item.includes(query));
  }, [pack, search]);

  const visibleGifs = useMemo(() => {
    const query = search.trim();
    return query ? GIF_STICKERS.filter(item => item.includes(query)) : GIF_STICKERS;
  }, [search]);

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

        <div className="aani-sheet-in relative z-10 flex max-h-[72vh] flex-col overflow-hidden rounded-t-[26px] border-t border-white/10 bg-[#141519] text-white shadow-[0_-16px_40px_rgba(0,0,0,0.6)]">
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

          {/* البحث */}
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

          {/* الأقسام */}
          {tab !== 'mine' && (
            <div className="aani-hscroll mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
              {STICKER_PACKS.map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActivePack(item.key)}
                  className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition ${
                    activePack === item.key
                      ? 'bg-white font-bold text-[#121212]'
                      : 'bg-white/8 text-white/70'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          {/* المحتوى */}
          <div className="aani-hscroll mt-2 flex-1 overflow-y-auto px-4 pb-3">
            {tab === 'emoji' && (
              <div className="grid grid-cols-4 gap-2">
                {visibleEmojis.map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => onPick({ type: 'emoji', value: item })}
                    className="flex aspect-square items-center justify-center rounded-2xl bg-white/5 text-[34px] leading-none transition active:scale-90"
                  >
                    {item}
                  </button>
                ))}
                {visibleEmojis.length === 0 && (
                  <p className="col-span-4 py-6 text-center text-[12px] text-white/40">لا توجد نتائج</p>
                )}
              </div>
            )}

            {tab === 'gif' && (
              <div className="grid grid-cols-4 gap-2">
                {visibleGifs.map((item, index) => (
                  <button
                    key={`${item}-${index}`}
                    type="button"
                    onClick={() => onPick({ type: 'emoji', value: item })}
                    className="flex aspect-square items-center justify-center rounded-2xl bg-white/5 text-[34px] leading-none transition active:scale-90"
                  >
                    <span className="aani-sticker-gif" style={{ animationDelay: `${index * 90}ms` }}>
                      {item}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {tab === 'mine' && (
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => setStudioOpen(true)}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/25 text-white/60 transition active:scale-95"
                >
                  <Plus size={20} />
                  <span className="text-[9px]">ملصق جديد</span>
                </button>

                {myStickers.map((dataUrl, index) => (
                  <button
                    key={`${dataUrl.slice(-24)}-${index}`}
                    type="button"
                    onClick={() => onPick({ type: 'image', value: dataUrl })}
                    className="flex aspect-square items-center justify-center rounded-2xl bg-white/5 p-1.5 transition active:scale-90"
                  >
                    <img src={dataUrl} alt="" className="max-h-full max-w-full object-contain" />
                  </button>
                ))}

                {myStickers.length === 0 && (
                  <p className="col-span-3 self-center py-6 text-center text-[11px] leading-5 text-white/40">
                    لا توجد ملصقات بعد — اضغط «صنع ملصق» لقص أي عنصر من صورك
                  </p>
                )}
              </div>
            )}
          </div>

          {/* شريط التنقل السفلي */}
          <div
            className="flex items-center justify-around border-t border-white/10 bg-black/40 px-2 py-1.5"
            style={{ paddingBottom: 'calc(0.4rem + env(safe-area-inset-bottom))' }}
          >
            {NAV.map(item => {
              const Icon = item.Icon;
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1 text-[10px] transition ${
                    active ? 'text-white' : 'text-white/45'
                  }`}
                >
                  <Icon size={19} />
                  {item.label}
                </button>
              );
            })}
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
