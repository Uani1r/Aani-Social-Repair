import React, { useRef } from 'react';
import { Image } from 'lucide-react';
import { toast } from 'sonner';

interface CommentMediaPickerProps {
  onSelectImage: (file: File) => void;
}

const CommentMediaPicker: React.FC<CommentMediaPickerProps> = ({ onSelectImage }) => {
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => imageInputRef.current?.click()}
        className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
        title="إرفاق صورة"
        aria-label="إرفاق صورة"
      >
        <Image size={22} strokeWidth={2.3} />
      </button>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = '';

          if (!file) return;

          if (file.size > 10 * 1024 * 1024) {
            toast.error('حجم الصورة يجب ألا يتجاوز 10 ميغابايت');
            return;
          }

          onSelectImage(file);
        }}
      />
    </>
  );
};

export default CommentMediaPicker;
