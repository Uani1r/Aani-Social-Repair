import type { ComponentType } from 'react';

type MediaPickerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelectComplete?: (files: File[]) => void;
  existingImages?: File[];
};

declare const MediaPickerModal: ComponentType<MediaPickerModalProps>;

export default MediaPickerModal;
