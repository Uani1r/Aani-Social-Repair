import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowRight, ImagePlus, Plus, Store, X } from 'lucide-react';
import { toast } from 'sonner';

import StickerStudio from '@/components/StickerStudio';
import { EMOJI_CATEGORY_LABELS, normalizeEmojiCatalog, TwemojiEmoji, type EmojiChoice } from '@/components/TwemojiText';
import type { ChatStickerPayload } from '@/components/ChatStickerMessage';
import { storageBucket, supabase, supabaseConfigured } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';

type StickerItem = { emoji: string; label: string };
type StickerPack = { id: string; title: string; description: string; cover: string; stickers: StickerItem[] };
type CustomSticker = { id: string; url: string; label: string };
type PanelMode = 'emoji' | 'stickers' | 'store';

const STICKER_PACKS: StickerPack[] = [
  {
    id: 'reactions',
    title: 'ردود سريعة',
    description: 'تعبيرات يومية للمحادثات',
    cover: '🫶',
    stickers: [
      { emoji: '🫶', label: 'قلب باليدين' }, { emoji: '🥹', label: 'تأثر' }, { emoji: '😂', label: 'ضحك' },
      { emoji: '😍', label: 'إعجاب' }, { emoji: '😭', label: 'بكاء' }, { emoji: '🤍', label: 'قلب أبيض' },
      { emoji: '👍', label: 'إعجاب' }, { emoji: '🙏', label: 'شكراً' }, { emoji: '✨', label: 'لمعان' },
      { emoji: '🤝', label: 'اتفاق' }, { emoji: '😮', label: 'دهشة' }, { emoji: '😎', label: 'رائع' },
    ],
  },
  {
    id: 'moods',
    title: 'مشاعر مرحة',
    description: 'وجوه ومشاعر لكل موقف',
    cover: '🥰',
    stickers: [
      { emoji: '🥰', label: 'محبة' }, { emoji: '🤗', label: 'عناق' }, { emoji: '😴', label: 'نعاس' },
      { emoji: '🤔', label: 'تفكير' }, { emoji: '😅', label: 'ضحكة محرجة' }, { emoji: '🙃', label: 'مرح' },
      { emoji: '😇', label: 'براءة' }, { emoji: '😤', label: 'إصرار' }, { emoji: '🥳', label: 'احتفال' },
      { emoji: '😋', label: 'لذيذ' }, { emoji: '🤩', label: 'انبهار' }, { emoji: '😌', label: 'راحة' },
    ],
  },
  {
    id: 'celebrations',
    title: 'لحظات سعيدة',
    description: 'تهاني وأجواء احتفالية',
    cover: '🎉',
    stickers: [
      { emoji: '🎉', label: 'تهانينا' }, { emoji: '🎂', label: 'عيد ميلاد' }, { emoji: '🎊', label: 'احتفال' },
      { emoji: '🌟', label: 'نجمة' }, { emoji: '💐', label: 'باقة زهور' }, { emoji: '💖', label: 'قلب لامع' },
      { emoji: '🥂', label: 'نخب' }, { emoji: '🏆', label: 'فوز' }, { emoji: '🎁', label: 'هدية' },
      { emoji: '🌈', label: 'قوس قزح' }, { emoji: '🪩', label: 'ديسكو' }, { emoji: '🎈', label: 'بالون' },
    ],
  },
];

const DEFAULT_PACKS = ['reactions'];
const installedPacksKey = (userId: string) => `aani_sticker_packs_${userId}`;
const customStickersKey = (userId: string) => `aani_custom_stickers_${userId}`;

function readInstalledPacks(userId: string): string[] {
  if (typeof window === 'undefined') return DEFAULT_PACKS;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(installedPacksKey(userId)) || 'null');
    if (stored === null) return DEFAULT_PACKS;
    if (!Array.isArray(stored)) return DEFAULT_PACKS;
    return [...new Set(stored.filter((id): id is string => typeof id === 'string' && STICKER_PACKS.some(pack => pack.id === id)))];
  } catch {
    return DEFAULT_PACKS;
  }
}

function readCustomStickers(userId: string): CustomSticker[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(customStickersKey(userId)) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      if (typeof value.id !== 'string' || typeof value.url !== 'string' || typeof value.label !== 'string') return [];
      try {
        const url = new URL(value.url);
        return url.protocol === 'https:' || url.protocol === 'http:'
          ? [{ id: value.id, url: url.toString(), label: value.label.slice(0, 120) }]
          : [];
      } catch {
        return [];
      }
    }).slice(0, 80);
  } catch {
    return [];
  }
}

export default function ChatStickerPanel({
  currentUserId,
  onClose,
  onInsertEmoji,
  onSendSticker,
}: {
  currentUserId: string;
  onClose: () => void;
  onInsertEmoji: (emoji: string) => void;
  onSendSticker: (sticker: ChatStickerPayload) => void;
}) {
  const [mode, setMode] = useState<PanelMode>('emoji');
  const [selectedCategory, setSelectedCategory] = useState('Smileys & Emotion');
  const [emojiChoices, setEmojiChoices] = useState<EmojiChoice[]>([]);
  const [emojiLoading, setEmojiLoading] = useState(true);
  const [emojiError, setEmojiError] = useState(false);
  const [installedPacks, setInstalledPacks] = useState<string[]>(() => readInstalledPacks(currentUserId));
  const [customStickers, setCustomStickers] = useState<CustomSticker[]>(() => readCustomStickers(currentUserId));
  const [activeCollection, setActiveCollection] = useState<string>('reactions');
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [studioFile, setStudioFile] = useState<File | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const packs = readInstalledPacks(currentUserId);
    setInstalledPacks(packs);
    setCustomStickers(readCustomStickers(currentUserId));
    setActiveCollection(packs.includes('reactions') ? 'reactions' : packs[0] || 'mine');
  }, [currentUserId]);

  useEffect(() => {
    const controller = new AbortController();
    setEmojiLoading(true);
    fetch('/emoji-catalog.json', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('emoji catalog unavailable');
        return response.json() as Promise<unknown>;
      })
      .then(value => {
        setEmojiChoices(normalizeEmojiCatalog(value));
        setEmojiError(false);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error('[messages] تعذر تحميل قائمة الإيموجي:', error);
        setEmojiChoices([]);
        setEmojiError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setEmojiLoading(false);
      });
    return () => controller.abort();
  }, []);

  const categories = Object.keys(EMOJI_CATEGORY_LABELS);
  const visibleEmojis = useMemo(() => emojiChoices.filter(choice => choice.category === selectedCategory), [emojiChoices, selectedCategory]);
  const visiblePack = STICKER_PACKS.find(pack => pack.id === activeCollection && installedPacks.includes(pack.id));

  const updateInstalledPacks = (next: string[]) => {
    setInstalledPacks(next);
    try {
      localStorage.setItem(installedPacksKey(currentUserId), JSON.stringify(next));
    } catch {
      toast.error('تعذر حفظ حزم الملصقات على هذا الجهاز.');
    }
  };

  const installPack = (packId: string) => {
    if (installedPacks.includes(packId)) return;
    updateInstalledPacks([...installedPacks, packId]);
    toast.success('تمت إضافة الحزمة إلى الملصقات');
  };

  const addImageFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] || null;
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('اختر ملف صورة مدعوماً.');
      return;
    }
    setStudioFile(file);
    setPlusMenuOpen(false);
  };

  const saveCustomSticker = async (file: File) => {
    if (!supabaseConfigured) throw new Error('قاعدة البيانات غير مهيأة لحفظ الملصقات.');
    const extension = file.type === 'image/webp' ? 'webp' : 'png';
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-60) || `sticker.${extension}`;
    const path = `${currentUserId}/stickers/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    await uploadMedia({ file, path });
    const url = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
    const sticker: CustomSticker = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, url, label: 'ملصق مخصص' };
    setCustomStickers(current => {
      const next = [sticker, ...current].slice(0, 80);
      try {
        localStorage.setItem(customStickersKey(currentUserId), JSON.stringify(next));
      } catch {
        toast.error('رُفع الملصق، لكن تعذر حفظه في قائمة هذا الجهاز.');
      }
      return next;
    });
    setActiveCollection('mine');
    setMode('stickers');
    setStudioFile(null);
    toast.success('تم حفظ الملصق الشفاف');
  };

  const selectSticker = (sticker: StickerItem) => {
    onSendSticker(sticker);
    onClose();
  };

  const selectCustomSticker = (sticker: CustomSticker) => {
    onSendSticker({ url: sticker.url, label: sticker.label });
    onClose();
  };

  return (
    <>
      <section className="messages-sticker-picker" role="dialog" aria-label="الإيموجي والملصقات" dir="rtl">
        <header className="messages-sticker-panel-header">
          <div className="messages-sticker-panel-tabs" role="tablist" aria-label="نوع التعبير">
            <button type="button" role="tab" aria-selected={mode === 'emoji'} className={mode === 'emoji' ? 'is-active' : ''} onClick={() => { setMode('emoji'); setPlusMenuOpen(false); }}>إيموجي</button>
            <button type="button" role="tab" aria-selected={mode !== 'emoji'} className={mode !== 'emoji' ? 'is-active' : ''} onClick={() => { setMode('stickers'); setPlusMenuOpen(false); }}>ملصقات</button>
          </div>
          <strong>{mode === 'emoji' ? 'اختر تعبيراً' : mode === 'store' ? 'متجر الملصقات' : 'ملصقاتك'}</strong>
          <button type="button" className="messages-sticker-close" aria-label="إغلاق الإيموجي والملصقات" onClick={onClose}><X size={17} /></button>
        </header>

        <div className={`messages-sticker-panel-layout${mode === 'store' ? ' is-store' : ''}`}>
          <nav className="messages-sticker-categories" aria-label={mode === 'emoji' ? 'فئات الإيموجي' : 'مجموعات الملصقات'}>
            {mode === 'emoji' ? categories.map(category => (
              <button key={category} type="button" className={selectedCategory === category ? 'is-active' : ''} aria-label={EMOJI_CATEGORY_LABELS[category]} title={EMOJI_CATEGORY_LABELS[category]} onClick={() => setSelectedCategory(category)}>
                <span aria-hidden="true">{category === 'Smileys & Emotion' ? '☺' : category === 'People & Body' ? '♙' : category === 'Animals & Nature' ? '♧' : category === 'Food & Drink' ? '♨' : category === 'Travel & Places' ? '⌖' : category === 'Activities' ? '⚽' : category === 'Objects' ? '▣' : category === 'Symbols' ? '♥' : '⚑'}</span>
              </button>
            )) : mode === 'store' ? (
              <button type="button" aria-label="العودة إلى الملصقات" title="العودة" onClick={() => setMode('stickers')}><ArrowRight size={18} /></button>
            ) : (
              <>
                <button type="button" className={activeCollection === 'mine' ? 'is-active' : ''} aria-label="ملصقاتي" title="ملصقاتي" onClick={() => setActiveCollection('mine')}><ImagePlus size={17} /></button>
                {STICKER_PACKS.filter(pack => installedPacks.includes(pack.id)).map(pack => (
                  <button key={pack.id} type="button" className={activeCollection === pack.id ? 'is-active' : ''} aria-label={pack.title} title={pack.title} onClick={() => setActiveCollection(pack.id)}>
                    <TwemojiEmoji emoji={pack.cover} size={22} />
                  </button>
                ))}
              </>
            )}
          </nav>

          <div className="messages-sticker-panel-content">
            {mode === 'emoji' && (
              <>
                <div className="messages-sticker-content-title">{EMOJI_CATEGORY_LABELS[selectedCategory]}</div>
                {emojiLoading ? <div className="messages-sticker-empty">جارٍ تحميل الإيموجي...</div> : emojiError ? (
                  <div className="messages-sticker-empty" role="alert">تعذر تحميل الإيموجي. تحقق من الاتصال.</div>
                ) : (
                  <div className="messages-emoji-catalog">
                    {visibleEmojis.map((choice, index) => (
                      <button key={`${choice.emoji}-${index}`} type="button" aria-label={choice.name} title={choice.name} onClick={() => { onInsertEmoji(choice.emoji); onClose(); }}>
                        <TwemojiEmoji emoji={choice.emoji} size={27} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {mode === 'stickers' && (
              <>
                <div className="messages-sticker-content-title">{activeCollection === 'mine' ? 'ملصقاتي المخصصة' : visiblePack?.title || 'اختر مجموعة'}</div>
                {activeCollection === 'mine' ? customStickers.length ? (
                  <div className="messages-sticker-grid">
                    {customStickers.map(sticker => (
                      <button key={sticker.id} type="button" aria-label={`إرسال ${sticker.label}`} title={sticker.label} onClick={() => selectCustomSticker(sticker)}>
                        <img src={sticker.url} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : <div className="messages-sticker-empty">أنشئ ملصقاً شفافاً من صورة على جهازك.</div> : visiblePack ? (
                  <div className="messages-sticker-grid">
                    {visiblePack.stickers.map((sticker, index) => (
                      <button key={`${visiblePack.id}-${index}`} type="button" aria-label={`إرسال ${sticker.label}`} title={sticker.label} onClick={() => selectSticker(sticker)}>
                        <TwemojiEmoji emoji={sticker.emoji} size={48} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="messages-sticker-empty">أضف حزمة من المتجر لبدء إرسال الملصقات.</div>
                )}
              </>
            )}

            {mode === 'store' && (
              <div className="messages-sticker-store-list">
                {STICKER_PACKS.map(pack => {
                  const installed = installedPacks.includes(pack.id);
                  return (
                    <article className="messages-sticker-store-card" key={pack.id}>
                      <span className="messages-sticker-store-cover"><TwemojiEmoji emoji={pack.cover} size={34} /></span>
                      <span className="messages-sticker-store-copy"><strong>{pack.title}</strong><small>{pack.description} · {pack.stickers.length} ملصقاً</small></span>
                      <button type="button" disabled={installed} onClick={() => installPack(pack.id)}>{installed ? 'مضافة' : 'إضافة إلى التطبيق'}</button>
                    </article>
                  );
                })}
                <p className="messages-sticker-store-note">الحزم المضافة تحفظ على هذا الجهاز، ويمكن إرسال ملصقاتها مباشرة.</p>
              </div>
            )}
          </div>

          <aside className="messages-sticker-plus-area">
            <button type="button" className={`messages-sticker-plus-button${plusMenuOpen ? ' is-active' : ''}`} aria-label="إضافة ملصق أو حزمة" aria-expanded={plusMenuOpen} onClick={() => setPlusMenuOpen(value => !value)}><Plus size={20} /></button>
            {plusMenuOpen && (
              <div className="messages-sticker-plus-menu" role="menu" aria-label="إضافة إلى الملصقات">
                <button type="button" role="menuitem" onClick={() => imageInputRef.current?.click()}><ImagePlus size={16} /><span>إنشاء ملصق</span></button>
                <button type="button" role="menuitem" onClick={() => { setMode('store'); setPlusMenuOpen(false); }}><Store size={16} /><span>متجر الملصقات</span></button>
              </div>
            )}
            <input ref={imageInputRef} type="file" accept="image/*" className="messages-sticker-file-input" onChange={addImageFile} />
          </aside>
        </div>
      </section>
      {studioFile && <StickerStudio file={studioFile} onClose={() => setStudioFile(null)} onSave={saveCustomSticker} />}
    </>
  );
}
