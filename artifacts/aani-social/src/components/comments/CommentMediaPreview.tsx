import React from 'react';
import { X } from 'lucide-react';

const CommentMediaPreview: React.FC<{
  previewUrl: string;
  onRemove: () => void;
}> = ({ previewUrl, onRemove }) => (
  <div className="relative mr-1 inline-block h-16 w-16 overflow-hidden rounded-xl border border-zinc-700">
    <img
      src={previewUrl}
      alt="معاينة الصورة المرفقة"
      className="h-full w-full object-cover"
    />

    <button
      type="button"
      onClick={onRemove}
      className="absolute left-1 top-1 rounded-full bg-black/80 p-1 text-white hover:bg-black"
      aria-label="إزالة الصورة"
    >
      <X size={12} />
    </button>
  </div>
);

export default CommentMediaPreview;
