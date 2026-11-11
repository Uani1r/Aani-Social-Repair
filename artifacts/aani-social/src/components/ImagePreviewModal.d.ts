import type { ComponentType } from 'react';

type ImagePreviewItem = {
  file: File;
  dataUrl: string;
};

type PreviewMusic = {
  file: File;
  title: string;
  previewUrl: string;
};

type ImagePreviewModalProps = {
  open: boolean;
  images: ImagePreviewItem[];
  onImagesChange: (images: ImagePreviewItem[]) => void;
  /** الصوت المختار من شاشة المعاينة (نظام الأصوات) لاستعادته */
  music?: PreviewMusic | null;
  /** يُستدعى عند اختيار/إزالة صوت من شاشة المعاينة */
  onMusicChange?: (music: PreviewMusic | null) => void;
  onClose: () => void;
  onNext: () => void;
};

declare const ImagePreviewModal: ComponentType<ImagePreviewModalProps>;

export default ImagePreviewModal;
