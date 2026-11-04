import { useEffect, useRef, useState, type PointerEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  EyeOff, Flag, LockKeyhole, MoreVertical, Pencil, Star, ThumbsUp, Trash2,
} from 'lucide-react';

type PostOptionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  feedback?: 'interested' | 'not_interested' | null;
  privacySaving?: boolean;
  onEdit: () => void;
  onTogglePrivacy: () => void;
  onPromote: () => void;
  onDelete: () => void;
  onReport: () => void;
  onFeedback: (value: 'interested' | 'not_interested') => void;
};

export default function PostOptionsSheet({
  open,
  onOpenChange,
  isOwner,
  feedback,
  privacySaving = false,
  onEdit,
  onTogglePrivacy,
  onPromote,
  onDelete,
  onReport,
  onFeedback,
}: PostOptionsSheetProps) {
  const dragStartY = useRef<number | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) {
      dragStartY.current = null;
      dragPointerId.current = null;
      setDragOffset(0);
      setDragging(false);
    }
  }, [open]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStartY.current = event.clientY;
    dragPointerId.current = event.pointerId;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerId.current !== event.pointerId || dragStartY.current === null) return;
    setDragOffset(Math.max(0, event.clientY - dragStartY.current));
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerId.current !== event.pointerId || dragStartY.current === null) return;
    const distance = Math.max(0, event.clientY - dragStartY.current);
    dragStartY.current = null;
    dragPointerId.current = null;
    setDragging(false);
    setDragOffset(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (distance > 90) onOpenChange(false);
  };

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointerId.current !== event.pointerId) return;
    dragStartY.current = null;
    dragPointerId.current = null;
    setDragging(false);
    setDragOffset(0);
  };

  const selectAction = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <button type="button" className="shrink-0 rounded-full p-1 text-zinc-500 transition hover:text-white" aria-label="خيارات المنشور">
          <MoreVertical size={18} />
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="post-options-overlay fixed inset-0 z-[90] bg-black/65 backdrop-blur-[4px]" />
        <DialogPrimitive.Content
          dir="rtl"
          className="post-options-content fixed inset-x-0 bottom-0 z-[91] max-h-[85vh] overflow-y-auto rounded-t-[24px] border border-white/10 bg-[#1c1c1e] px-4 pt-2 text-white shadow-[0_-12px_50px_rgba(0,0,0,0.45)] focus:outline-none"
          style={{
            transform: dragging ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
            transition: dragging ? 'none' : 'transform 220ms ease-out',
            paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
          }}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">خيارات المنشور</DialogPrimitive.Title>
          <div
            className="flex w-full touch-none cursor-grab justify-center py-2 active:cursor-grabbing"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={cancelDrag}
            aria-hidden="true"
          >
            <span className="h-1 w-10 rounded-full bg-zinc-600" />
          </div>

          <div className="space-y-2.5 pb-2">
            {isOwner ? (
              <>
                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(onEdit)}
                  className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] bg-[#252527] px-3 text-right transition hover:bg-[#303033]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#38383a] text-zinc-100">
                    <Pencil size={19} />
                  </span>
                  <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold text-white">تعديل المنشور</span>
                </button>

                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(onTogglePrivacy)}
                  disabled={privacySaving}
                  aria-busy={privacySaving}
                  className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] bg-[#252527] px-3 text-right transition hover:bg-[#303033] disabled:opacity-60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#38383a] text-zinc-100">
                    <LockKeyhole size={19} />
                  </span>
                  <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold text-white">تعديل الخصوصية</span>
                </button>

                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(onPromote)}
                  className="flex min-h-[88px] w-full flex-row items-center justify-between gap-3 rounded-[14px] px-3 py-3 text-right shadow-lg transition hover:brightness-110"
                  style={{ background: 'linear-gradient(135deg, #6e8efb, #a777e3)' }}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white/20">
                    <Star size={22} fill="white" className="text-white" />
                  </span>
                  <span dir="rtl" className="min-w-0 flex-1 text-right">
                    <span className="block whitespace-nowrap text-sm font-bold text-white">تعزيز المنشور</span>
                    <span className="mt-1 block truncate whitespace-nowrap text-xs leading-5 text-white/85">اجعل إبداعك يتصدر واجهة الجميع الآن</span>
                  </span>
                  <span dir="rtl" className="shrink-0 whitespace-nowrap rounded-full bg-white/20 px-2 py-1 text-[10px] font-bold text-white">ترويج</span>
                </button>

                <div className="border-t border-white/10 pt-2">
                  <button
                    type="button"
                    dir="ltr"
                    onClick={() => selectAction(onDelete)}
                    className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] px-3 text-right transition hover:bg-[rgba(255,59,48,0.2)]"
                    style={{ background: 'rgba(255, 59, 48, 0.12)', color: '#ff453a' }}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(255,69,58,0.18)]">
                      <Trash2 size={19} />
                    </span>
                    <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold">حذف المنشور</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(onReport)}
                  className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] bg-[#252527] px-3 text-right transition hover:bg-[#303033]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#38383a] text-red-400">
                    <Flag size={18} />
                  </span>
                  <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold text-red-400">إبلاغ عن المنشور</span>
                </button>
                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(() => onFeedback('interested'))}
                  className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] bg-[#252527] px-3 text-right transition hover:bg-[#303033]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#38383a] text-zinc-100">
                    <ThumbsUp size={18} />
                  </span>
                  <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold text-white">{feedback === 'interested' ? 'إلغاء مهتم' : 'مهتم'}</span>
                </button>
                <button
                  type="button"
                  dir="ltr"
                  onClick={() => selectAction(() => onFeedback('not_interested'))}
                  className="flex h-16 w-full flex-row items-center justify-between gap-3 rounded-[14px] bg-[#252527] px-3 text-right transition hover:bg-[#303033]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#38383a] text-zinc-100">
                    <EyeOff size={18} />
                  </span>
                  <span dir="rtl" className="flex-1 whitespace-nowrap text-right text-sm font-semibold text-white">{feedback === 'not_interested' ? 'إلغاء غير مهتم' : 'غير مهتم'}</span>
                </button>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
