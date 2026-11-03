import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Image, MoreHorizontal, Type, Video } from 'lucide-react';

type PublishOptionsSheetProps = {
  open: boolean;
  onClose: () => void;
  onCreateTextPost: () => void;
  onImagesSelected: (files: File[]) => void;
  onVideoSelected: (file: File) => void;
  onOpenMore: () => void;
};

const options = [
  { key: 'text', label: 'نص', Icon: Type, iconClassName: 'text-rose-400', backgroundClassName: 'bg-rose-500/15' },
  { key: 'image', label: 'صورة', Icon: Image, iconClassName: 'text-emerald-400', backgroundClassName: 'bg-emerald-500/15' },
  { key: 'video', label: 'فيديو', Icon: Video, iconClassName: 'text-blue-400', backgroundClassName: 'bg-blue-500/15' },
  { key: 'more', label: 'المزيد', Icon: MoreHorizontal, iconClassName: 'text-purple-400', backgroundClassName: 'bg-purple-500/15' },
] as const;

export default function PublishOptionsSheet({
  open,
  onClose,
  onCreateTextPost,
  onImagesSelected,
  onVideoSelected,
  onOpenMore,
}: PublishOptionsSheetProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragOffsetRef = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const handleOption = (key: (typeof options)[number]['key']) => {
    if (key === 'text') {
      onClose();
      onCreateTextPost();
      return;
    }

    if (key === 'image') {
      imageInputRef.current?.click();
      onClose();
      return;
    }

    if (key === 'video') {
      videoInputRef.current?.click();
      onClose();
      return;
    }

    onClose();
    onOpenMore();
  };

  const handleImagesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (files.length) onImagesSelected(files);
  };

  const handleVideoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onVideoSelected(file);
  };

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open) return;
    dragStartYRef.current = event.clientY;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartYRef.current === null) return;
    const nextOffset = Math.max(0, event.clientY - dragStartYRef.current);
    dragOffsetRef.current = nextOffset;
    setDragOffset(nextOffset);
  };

  const handleDragEnd = () => {
    if (dragStartYRef.current === null) return;
    dragStartYRef.current = null;
    setIsDragging(false);
    const shouldDismiss = dragOffsetRef.current > 90;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    if (shouldDismiss) onClose();
  };

  return (
    <div
      className={`fixed inset-0 z-[110] ${open ? '' : 'pointer-events-none'}`}
      dir="rtl"
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="إغلاق قائمة النشر"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 h-full w-full bg-black/75 backdrop-blur-xl transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <section
        role="dialog"
        aria-modal={open}
        aria-label="ماذا تريد أن تنشر؟"
        onClick={event => event.stopPropagation()}
        className="absolute bottom-0 min-h-[320px] w-full max-w-[450px] rounded-t-[24px] border-t border-[#2a2b33] text-white shadow-[0_-12px_48px_rgba(0,0,0,0.35)]"
        style={{
          left: '50%',
          background: '#1a1b22',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          padding: '12px 24px 40px',
          transform: open ? `translate(-50%, ${dragOffset}px)` : 'translate(-50%, 100%)',
          transition: isDragging ? 'none' : 'transform 320ms cubic-bezier(0.22, 0.75, 0.25, 1)',
        }}
      >
        <div
          className="mx-auto mb-6 flex h-4 w-16 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          aria-label="اسحب للأسفل لإغلاق القائمة"
        >
          <span className="h-1 w-10 rounded-full bg-[#444]" />
        </div>

        <h2 className="mb-[30px] text-center text-[18px] font-bold text-white">ماذا تريد أن تنشر؟</h2>

        <div className="grid grid-cols-4 justify-between gap-[10px]">
          {options.map(({ key, label, Icon, iconClassName, backgroundClassName }) => (
            <button
              key={key}
              type="button"
              onClick={() => handleOption(key)}
              className="flex min-w-0 flex-col items-center gap-[10px] rounded-2xl px-1 py-2 text-[#8b8d98] transition active:scale-95"
            >
              <span className={`flex h-[60px] w-[60px] items-center justify-center rounded-[22px] ${backgroundClassName}`}>
                <Icon size={24} strokeWidth={2.2} className={iconClassName} />
              </span>
              <span className="text-[13px] text-[#8b8d98]">{label}</span>
            </button>
          ))}
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={handleImagesChange}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          tabIndex={-1}
          onChange={handleVideoChange}
        />
      </section>
    </div>
  );
}
