import type { ComponentType } from 'react';

type ImagePreviewItem = {
  file: File;
  dataUrl: string;
};

type ImagePreviewModalProps = {
  open: boolean;
  images: ImagePreviewItem[];
  onImagesChange: (images: ImagePreviewItem[]) => void;
  onClose: () => void;
  onNext: () => void;
};

declare const ImagePreviewModal: ComponentType<ImagePreviewModalProps>;

export default ImagePreviewModal;
