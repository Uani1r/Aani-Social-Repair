import type { ComponentType } from 'react';
import type { PostMetadataTag } from '../lib/types';

type ImagePreviewItem = {
  file: File;
  dataUrl: string;
};

type SelectedLibrarySound = {
  id: string;
  title: string;
  sourceVideoUrl?: string | null;
  previewUrl?: string | null;
};

type ImagePreviewModalProps = {
  open: boolean;
  images: ImagePreviewItem[];
  onImagesChange: (images: ImagePreviewItem[]) => void;
  /** الصوت المختار من مكتبة أصوات التطبيق (نظام الأصوات) */
  music?: SelectedLibrarySound & { soundTrim?: { start: number; end: number } | null } | null;
  /** إزالة الصوت المختار من داخل الشاشة */
  onClearMusic?: () => void;
  /** نص الوصف/الكابشن (يُربط بحالة postText في Shell) */
  caption?: string;
  onCaptionChange?: (caption: string) => void;
  /** وسوم المنشور (موقع/إشارة) */
  tags?: PostMetadataTag[];
  onTagsChange?: (tags: PostMetadataTag[]) => void;
  /** وجهة النشر: feed أو reels */
  destination?: string;
  onDestinationChange?: (destination: string) => void;
  userId?: string;
  /** النشر المباشر من الشاشة الموحدة: يجمع الوسائط المقصوصة + الوصف + الوسوم + الصوت في طلب واحد */
  onPublish?: (images: ImagePreviewItem[]) => void;
  onClose: () => void;
};

declare const ImagePreviewModal: ComponentType<ImagePreviewModalProps>;

export default ImagePreviewModal;
