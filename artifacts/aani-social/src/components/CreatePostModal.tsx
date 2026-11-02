import { ImagePlus, Video, X } from 'lucide-react';

type CreatePostModalProps = {
  postText: string;
  selectedFiles: File[];
  fileType: 'image' | 'video' | null;
  filePreviews: { file: File; url: string }[];
  isSubmitting: boolean;
  createError: string;
  onPostTextChange: (text: string) => void;
  onRemoveFile: (index: number) => void;
  onSelectImages: (files: File[]) => void;
  onSelectVideo: (file: File) => void;
  onPublish: () => void;
  onClose: () => void;
};

export default function CreatePostModal({
  postText,
  selectedFiles,
  fileType,
  filePreviews,
  isSubmitting,
  createError,
  onPostTextChange,
  onRemoveFile,
  onSelectImages,
  onSelectVideo,
  onPublish,
  onClose,
}: CreatePostModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
          <h3 className="font-semibold text-white text-sm">منشور جديد</h3>
          <button className="text-zinc-400" onClick={onClose}><X size={18} /></button>
        </div>

        <textarea 
          value={postText}
          onChange={(e) => onPostTextChange(e.target.value)}
          placeholder="اكتب شرحاً للمنشور..." 
          className="w-full p-3 border rounded-xl resize-none outline-none bg-zinc-950 border-zinc-800 text-white text-xs" 
          rows={3} 
        />

        {filePreviews.length > 0 && (
          <div className="flex gap-2 overflow-x-auto py-2 no-scrollbar">
            {filePreviews.map((preview, i) => (
              <div key={preview.url} className="relative w-20 h-20 rounded-xl overflow-hidden border border-zinc-800 shrink-0 bg-black">
                {fileType === 'image' ? (
                  <img src={preview.url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <video src={preview.url} className="w-full h-full object-cover" />
                )}
                <button type="button" onClick={() => onRemoveFile(i)} className="absolute top-1 right-1 bg-black/70 text-white rounded-full p-0.5">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <input type="file" id="image-upload" multiple accept="image/*" className="hidden" onChange={(e) => { if (e.target.files) onSelectImages(Array.from(e.target.files)); }} />
        <input type="file" id="video-upload" accept="video/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) onSelectVideo(e.target.files[0]); }} />

        <div className="flex items-center justify-between pt-2 border-t border-zinc-800 text-xs">
          <div className="flex gap-2">
            <label htmlFor="image-upload" className="flex items-center gap-1 px-3 py-2 text-pink-400 bg-pink-950/40 rounded-xl cursor-pointer">
              <ImagePlus size={15} /> صور
            </label>
            <label htmlFor="video-upload" className="flex items-center gap-1 px-3 py-2 text-purple-400 bg-purple-950/40 rounded-xl cursor-pointer">
              <Video size={15} /> فيديو
            </label>
          </div>

          <button 
            type="button"
            onClick={onPublish}
            disabled={isSubmitting || (!postText.trim() && selectedFiles.length === 0)}
            className="px-5 py-2 bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold"
          >
            {isSubmitting ? 'جاري النشر...' : 'نشر'}
          </button>
        </div>
        {createError && <p className="text-xs text-red-400">{createError}</p>}
      </div>
    </div>
  );
}
