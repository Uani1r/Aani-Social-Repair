import { useEffect, useRef, useState } from 'react';
import { Music2, X } from 'lucide-react';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// شاشة مراجعة الصور المختارة قبل النشر — القص الإجباري بالمقاس المربع
// يتم داخل محرر النشر (PostImageCropper) بعد هذه الشاشة.
export default function ImagePreviewModal({ open, images, onClose, onNext }) {
  const trackRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const [musicNotice, setMusicNotice] = useState(false);
  const activeImage = images[activeIndex];

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open, images.length]);

  useEffect(() => {
    if (!musicNotice) return undefined;
    const timer = window.setTimeout(() => setMusicNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [musicNotice]);

  if (!open || images.length === 0 || !activeImage) return null;

  const handleScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const nextIndex = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    setActiveIndex(clamp(nextIndex, 0, images.length - 1));
  };

  const goToImage = index => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    setActiveIndex(index);
  };

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="معاينة الصور المختارة">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onClose} aria-label="إغلاق معاينة الصور" className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10">
          <X size={23} />
        </button>
        <span className="text-sm font-semibold text-white/70">{images.length > 1 ? `${activeIndex + 1} من ${images.length}` : 'معاينة الصور'}</span>
        <button type="button" onClick={onNext} className="rounded-full bg-[#f1a17f] px-6 py-2.5 text-base font-bold text-black transition active:scale-95">التالي</button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center pb-28">
        <div
          ref={trackRef}
          onScroll={handleScroll}
          dir="ltr"
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden no-scrollbar"
          style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}
        >
          {images.map((image, index) => (
            <div key={`${image.file.name}-${image.file.lastModified}-${index}`} className="flex h-full w-full shrink-0 snap-center items-center justify-center px-4">
              <div className="relative aspect-square h-full max-h-full w-auto max-w-full shrink-0 overflow-hidden rounded-xl bg-black">
                <img
                  src={image.dataUrl}
                  alt={`الصورة ${index + 1}`}
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                />
              </div>
            </div>
          ))}
        </div>

        {images.length > 1 && (
          <div className="absolute bottom-20 flex items-center justify-center gap-2" dir="ltr" aria-label="التنقل بين الصور">
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`عرض الصورة ${index + 1}`}
                aria-current={index === activeIndex ? 'true' : undefined}
                onClick={() => goToImage(index)}
                className={`h-2 rounded-full transition-all ${index === activeIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-[#242326]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
        <button type="button" onClick={() => setMusicNotice(true)} className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-[#f1a17f] transition hover:bg-white/5">
          <Music2 size={24} />
          <span className="text-xs font-medium">موسيقى</span>
        </button>
        <span className="flex min-w-24 flex-col items-center gap-1 rounded-full px-4 py-1 text-white/60">
          <span className="grid h-6 w-6 place-items-center rounded-md border border-white/25 text-[10px] font-bold">1:1</span>
          <span className="text-xs font-medium">مقاس مربع</span>
        </span>
      </div>

      {musicNotice && (
        <p role="status" className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg" style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
          إضافة الموسيقى غير متاحة حالياً للمنشورات.
        </p>
      )}
    </div>
  );
}
