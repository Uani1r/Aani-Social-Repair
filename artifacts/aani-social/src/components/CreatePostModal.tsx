import { ImagePlus, Video, X } from 'lucide-react';

import Avatar from './Avatar';
import UserIdentity from './UserIdentity';
import { displayName, type Profile } from '@/lib/types';

type CreatePostModalProps = {
  profile: Profile | null;
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
  profile,
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
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="إغلاق إنشاء المنشور"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-black/65 backdrop-blur-[15px] animate-in fade-in-0 duration-200"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="إنشاء منشور"
        dir="rtl"
        onClick={event => event.stopPropagation()}
        className="relative z-10 flex max-h-[86dvh] w-full max-w-[450px] flex-col overflow-y-auto rounded-[32px] border border-white/10 bg-[#1d1b21]/95 text-white shadow-[0_24px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-4 duration-300"
      >
        <div className="flex items-center justify-between px-6 pb-4 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar profile={profile} extraLarge />
            <UserIdentity
              name={displayName(profile)}
              username={profile?.username ? `@${profile.username}` : null}
              nameClassName="text-base font-bold text-white"
              usernameClassName="text-sm text-zinc-400"
            />
          </div>
          <button
            type="button"
            aria-label="إغلاق إنشاء المنشور"
            onClick={onClose}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/[0.08] text-white transition hover:bg-white/[0.14]"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 pb-5">
          <textarea
            value={postText}
            onChange={event => onPostTextChange(event.target.value)}
            placeholder="اكتب شرحاً للمنشور..."
            aria-label="اكتب محتوى المنشور"
            className="min-h-[280px] max-h-[42dvh] w-full resize-none border-0 bg-transparent p-0 text-right text-[18px] leading-[1.9] text-white outline-none placeholder:text-zinc-500 focus:ring-0"
            rows={8}
          />
        </div>

        {filePreviews.length > 0 && (
          <div className="flex gap-3 overflow-x-auto px-6 pb-5 no-scrollbar">
            {filePreviews.map((preview, index) => (
              <div key={preview.url} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                {fileType === 'image' ? (
                  <img src={preview.url} alt="معاينة الصورة المحددة" className="h-full w-full object-cover" />
                ) : (
                  <video src={preview.url} muted playsInline className="h-full w-full object-cover" />
                )}
                <button
                  type="button"
                  aria-label="إزالة الملف"
                  onClick={() => onRemoveFile(index)}
                  className="absolute left-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          type="file"
          id="image-upload"
          multiple
          accept="image/*"
          className="hidden"
          onChange={event => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            if (files.length) onSelectImages(files);
          }}
        />
        <input
          type="file"
          id="video-upload"
          accept="video/*"
          className="hidden"
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) onSelectVideo(file);
          }}
        />

        <footer className="mx-6 border-t border-white/10 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label
                htmlFor="image-upload"
                title="إضافة صور"
                className="grid h-[52px] w-[52px] cursor-pointer place-items-center rounded-full bg-white/[0.07] text-zinc-300 transition hover:bg-white/[0.12]"
              >
                <ImagePlus size={22} />
                <span className="sr-only">إضافة صور</span>
              </label>
              <label
                htmlFor="video-upload"
                title="إضافة فيديو"
                className="grid h-[52px] w-[52px] cursor-pointer place-items-center rounded-full bg-white/[0.07] text-zinc-300 transition hover:bg-white/[0.12]"
              >
                <Video size={22} />
                <span className="sr-only">إضافة فيديو</span>
              </label>
            </div>
            <button
              type="button"
              onClick={onPublish}
              disabled={isSubmitting || (!postText.trim() && selectedFiles.length === 0)}
              className="min-w-[120px] rounded-full bg-white px-8 py-3 text-base font-bold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'جاري النشر...' : 'نشر'}
            </button>
          </div>
          {createError && <p role="alert" className="mt-3 text-sm text-red-400">{createError}</p>}
        </footer>
      </section>
    </div>
  );
}
