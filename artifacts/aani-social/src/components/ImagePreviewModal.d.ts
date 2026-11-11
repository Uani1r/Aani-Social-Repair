import type { ComponentType } from 'react';

type ImagePreviewItem = {
  file: File;
  dataUrl: string;
};

type SelectedLibrarySound = {
  id: string;
  title: string;
  sourceVideoUrl?: string | null;
};

type ImagePreviewModalProps = {
  open: boolean;
  images: ImagePreviewItem[];
  onImagesChange: (images: ImagePreviewItem[]) => void;
  /** الصوت المختار من مكتبة أصوات التطبيق (نظام الأصوات) */
  music?: SelectedLibrarySound | null;
  /** إزالة الصوت المختار من داخل المعاينة */
  onClearMusic?: () => void;
  onClose: () => void;
  onNext: () => void;
};

declare const ImagePreviewModal: ComponentType<ImagePreviewModalProps>;

export default ImagePreviewModal;
