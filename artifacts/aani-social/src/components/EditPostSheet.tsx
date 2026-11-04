import type { ChangeEventHandler, FormEventHandler } from 'react';
import { X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';

type EditPostSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  postId: string;
  postType: 'text' | 'photo' | 'reel';
  content: string;
  onContentChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  busy: boolean;
  onReplacementFileChange: ChangeEventHandler<HTMLInputElement>;
};

export default function EditPostSheet({
  open,
  onOpenChange,
  postId,
  postType,
  content,
  onContentChange,
  onSubmit,
  busy,
  onReplacementFileChange,
}: EditPostSheetProps) {
  const { dragOffset, dragging, ...dismissHandlers } = useBottomSheetDismiss(open, () => onOpenChange(false));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="edit-post-overlay fixed inset-0 z-[100] bg-black/70 backdrop-blur-[5px]" />
        <DialogPrimitive.Content
          dir="rtl"
          className="edit-post-sheet fixed inset-x-0 bottom-0 z-[101] mx-auto max-h-[90dvh] w-full max-w-[500px] overflow-y-auto rounded-t-[24px] bg-[#1c1c1e] px-5 pt-4 text-white shadow-[0_-4px_30px_rgba(0,0,0,0.5)] focus:outline-none"
          style={{
            transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
            transition: dragging ? 'none' : 'transform 220ms ease-out',
            paddingBottom: 'max(32px, env(safe-area-inset-bottom))',
          }}
          aria-describedby={undefined}
          {...dismissHandlers}
        >
          <div className="edit-post-drag-handle" aria-hidden="true" />
          <header className="edit-post-header">
            <DialogPrimitive.Title id={`edit-post-${postId}`} className="edit-post-title">
              تعديل المنشور
            </DialogPrimitive.Title>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="edit-post-close"
              aria-label="إغلاق"
            >
              <X size={20} />
            </button>
          </header>

          <form onSubmit={onSubmit} className="edit-post-form">
            <div className="edit-post-textarea-container">
              <textarea
                value={content}
                onChange={event => onContentChange(event.target.value)}
                maxLength={2000}
                className="edit-post-textarea"
                placeholder="ماذا يدور في ذهنك؟ قم بتعديل منشورك هنا..."
                aria-label="نص المنشور"
              />
            </div>

            {postType !== 'text' && (
              <label className="edit-post-media-field">
                استبدال {postType === 'photo' ? 'الصورة' : 'الفيديو'} بملف من النوع نفسه
                <input
                  className="edit-post-file-input"
                  type="file"
                  accept={postType === 'photo' ? 'image/*' : 'video/*'}
                  onChange={onReplacementFileChange}
                />
              </label>
            )}

            <div className="edit-post-actions">
              <button type="button" className="edit-post-button edit-post-cancel" onClick={() => onOpenChange(false)}>
                إلغاء
              </button>
              <button type="submit" className="edit-post-button edit-post-save" disabled={busy}>
                {busy ? 'جارٍ الحفظ...' : 'حفظ التعديلات'}
              </button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
