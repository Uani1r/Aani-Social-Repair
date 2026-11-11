import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Image, MoreHorizontal, Type, Video } from 'lucide-react';

import { useOverlayBack } from '@/hooks/useOverlayBack';

type PublishOptionsSheetProps = {
  open: boolean;
  onClose: () => void;
  onCreateTextPost: () => void;
  onImagePickerStart: () => void;
  onImagePickerCancel: () => void;
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
  onImagePickerStart,
  onImagePickerCancel,
  onImagesSelected,
  onVideoSelected,
  onOpenMore,
}: PublishOptionsSheetProps) {
  // زر الرجوع (الهاتف/المتصفح) يغلق قائمة النشر دون مغادرة الصفحة
  useOverlayBack(open, onClose);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragStartTimeRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const dragOffsetRef = useRef(0);
  const hasDraggedRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onImagePickerCancelRef = useRef(onImagePickerCancel);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
    onImagePickerCancelRef.current = onImagePickerCancel;
  }, [onClose, onImagePickerCancel]);

  const handleOption = (key: (typeof options)[number]['key']) => {
    if (key === 'text') {
      onClose();
      onCreateTextPost();
      return;
    }

    if (key === 'image') {
      const input = document.getElementById('native-image-input');
      if (input instanceof HTMLInputElement) {
        // Start the cached preview inside the trusted tap before the OS picker opens.
        onImagePickerStart();
        input.click();
      }
      return;
    }

    if (key === 'video') {
      videoInputRef.current?.click();
      return;
    }

    onClose();
    onOpenMore();
  };

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []).filter(file => file.type.startsWith('image/'));
    event.currentTarget.value = '';
    if (files.length) onImagesSelected(files);
    else {
      onImagePickerCancelRef.current();
      onCloseRef.current();
    }
  };

  const handleVideoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = Array.from(event.currentTarget.files || []).find(candidate => candidate.type.startsWith('video/'));
    event.currentTarget.value = '';
    if (file) onVideoSelected(file);
    else onCloseRef.current();
  };

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!open || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    activePointerIdRef.current = event.pointerId;
    dragStartYRef.current = event.clientY;
    dragStartTimeRef.current = event.timeStamp;
    dragOffsetRef.current = 0;
    hasDraggedRef.current = false;
    setDragOffset(0);
    setIsDragging(true);
  };

  useEffect(() => {
    const closeOnImagePickerCancel = () => {
      onImagePickerCancelRef.current();
      onCloseRef.current();
    };
    const closeOnVideoPickerCancel = () => onCloseRef.current();
    const imageInput = document.getElementById('native-image-input');
    const videoInput = videoInputRef.current;
    imageInput?.addEventListener('cancel', closeOnImagePickerCancel);
    videoInput?.addEventListener('cancel', closeOnVideoPickerCancel);
    return () => {
      imageInput?.removeEventListener('cancel', closeOnImagePickerCancel);
      videoInput?.removeEventListener('cancel', closeOnVideoPickerCancel);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (activePointerIdRef.current !== event.pointerId || dragStartYRef.current === null) return;
      const delta = event.clientY - dragStartYRef.current;
      if (Math.abs(delta) > 8) hasDraggedRef.current = true;
      const nextOffset = Math.max(0, delta);
      dragOffsetRef.current = nextOffset;
      setDragOffset(nextOffset);
    };

    const finishDrag = (event: PointerEvent, allowDismiss: boolean) => {
      if (activePointerIdRef.current !== event.pointerId || dragStartYRef.current === null) return;

      const delta = event.clientY - dragStartYRef.current;
      const finalOffset = Math.max(0, delta);
      if (Math.abs(delta) > 8) hasDraggedRef.current = true;
      const elapsed = Math.max(1, event.timeStamp - dragStartTimeRef.current);
      const downwardVelocity = finalOffset / elapsed;
      const shouldDismiss = allowDismiss && (
        finalOffset >= 65 || (finalOffset >= 24 && downwardVelocity >= 0.65)
      );
      const shouldSuppressClick = hasDraggedRef.current;

      activePointerIdRef.current = null;
      dragStartYRef.current = null;
      dragOffsetRef.current = 0;
      hasDraggedRef.current = false;
      setIsDragging(false);
      setDragOffset(0);

      if (shouldSuppressClick) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => { suppressNextClickRef.current = false; }, 0);
      }
      if (shouldDismiss) onCloseRef.current();
    };

    const handlePointerUp = (event: PointerEvent) => finishDrag(event, true);
    const handlePointerCancel = (event: PointerEvent) => finishDrag(event, false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, []);

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
        onPointerDown={handleDragStart}
        onClickCapture={event => {
          if (!suppressNextClickRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          suppressNextClickRef.current = false;
        }}
        onClick={event => event.stopPropagation()}
        className="absolute bottom-0 h-fit w-full max-w-[450px] rounded-t-[20px] border-t border-[#2a2b33] text-white shadow-[0_-12px_48px_rgba(0,0,0,0.35)]"
        style={{
          left: '50%',
          background: '#1a1b22',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          padding: '8px 24px calc(12px + env(safe-area-inset-bottom))',
          touchAction: 'none',
          transform: open ? `translate(-50%, ${dragOffset}px)` : 'translate(-50%, 100%)',
          transition: isDragging ? 'none' : 'transform 320ms cubic-bezier(0.22, 0.75, 0.25, 1)',
        }}
      >
        <div
          className="mx-auto mb-6 flex h-4 w-16 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
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
              className="flex min-w-0 flex-col items-center gap-[10px] rounded-2xl px-1 text-[#8b8d98] transition active:scale-95"
            >
              <span className={`flex h-[60px] w-[60px] items-center justify-center rounded-[22px] ${backgroundClassName}`}>
                <Icon size={24} strokeWidth={2.2} className={iconClassName} />
              </span>
              <span className="text-[13px] text-[#8b8d98]">{label}</span>
            </button>
          ))}
        </div>

        <input
          id="native-image-input"
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelection}
        />
        <input
          id="native-video-input"
          ref={videoInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          tabIndex={-1}
          onChange={handleVideoChange}
        />
      </section>
    </div>
  );
}
