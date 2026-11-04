import type { ComponentType } from 'react';
import { Bot } from 'lucide-react';

import AIAssistantModal from '@/components/AIAssistantModal';
import CreatePostModal from '@/components/CreatePostModal';
import ImagePreviewModal from '@/components/ImagePreviewModal';
import PublishOptionsSheet from '@/components/PublishOptionsSheet';
import VideoPreviewModal from '@/components/VideoPreviewModal';
import SettingsModal from '@/components/SettingsModal';
import type { PostMetadataTag, Profile, VideoTrimRange } from '@/lib/types';

import type { NotificationsModalProps } from './types';

type ShellOverlayControlsProps = {
  showPublishOptionsSheet: boolean;
  onClosePublishOptionsSheet: () => void;
  onCreateTextPost: () => void;
  onSelectPublishImages: (files: File[]) => void;
  onSelectPublishVideo: (file: File) => void;
  onOpenMorePublishOptions: () => void;
  showImagePreviewModal: boolean;
  imagePreviewImages: { file: File; dataUrl: string }[];
  onImagePreviewImagesChange: (images: { file: File; dataUrl: string }[]) => void;
  onCloseImagePreview: () => void;
  onNextImagePreview: () => void;
  showVideoPreviewModal: boolean;
  videoPreviewUrl: string | null;
  videoTrim: VideoTrimRange | null;
  onVideoTrimChange: (range: VideoTrimRange) => void;
  onCloseVideoPreview: () => void;
  onNextVideoPreview: (range: VideoTrimRange) => void;
  showCreateModal: boolean;
  postText: string;
  selectedFiles: File[];
  fileType: 'image' | 'video' | null;
  filePreviews: { file: File; url: string }[];
  isSubmitting: boolean;
  createError: string;
  onPostTextChange: (text: string) => void;
  onRemoveFile: (index: number) => void;
  onPublish: (tags: PostMetadataTag[]) => void;
  onCloseCreatePost: () => void;
  showSettingsModal: boolean;
  onCloseSettings: () => void;
  profile: Profile | null;
  onSignOut: () => void;
  showNotifsModal: boolean;
  onCloseNotifications: () => void;
  NotificationsModalComponent: ComponentType<NotificationsModalProps>;
  userId: string;
  showAssistantModal: boolean;
  onOpenAssistant: () => void;
  onCloseAssistant: () => void;
};

export default function ShellOverlayControls({
  showPublishOptionsSheet,
  onClosePublishOptionsSheet,
  onCreateTextPost,
  onSelectPublishImages,
  onSelectPublishVideo,
  onOpenMorePublishOptions,
  showImagePreviewModal,
  imagePreviewImages,
  onImagePreviewImagesChange,
  onCloseImagePreview,
  onNextImagePreview,
  showVideoPreviewModal,
  videoPreviewUrl,
  videoTrim,
  onVideoTrimChange,
  onCloseVideoPreview,
  onNextVideoPreview,
  showCreateModal,
  postText,
  selectedFiles,
  fileType,
  filePreviews,
  isSubmitting,
  createError,
  onPostTextChange,
  onRemoveFile,
  onPublish,
  onCloseCreatePost,
  showSettingsModal,
  onCloseSettings,
  profile,
  onSignOut,
  showNotifsModal,
  onCloseNotifications,
  NotificationsModalComponent,
  userId,
  showAssistantModal,
  onOpenAssistant,
  onCloseAssistant,
}: ShellOverlayControlsProps) {
  return (
    <>
      <PublishOptionsSheet
        open={showPublishOptionsSheet}
        onClose={onClosePublishOptionsSheet}
        onCreateTextPost={onCreateTextPost}
        onImagesSelected={onSelectPublishImages}
        onVideoSelected={onSelectPublishVideo}
        onOpenMore={onOpenMorePublishOptions}
      />

      <ImagePreviewModal
        open={showImagePreviewModal}
        images={imagePreviewImages}
        onImagesChange={onImagePreviewImagesChange}
        onClose={onCloseImagePreview}
        onNext={onNextImagePreview}
      />

      <VideoPreviewModal
        open={showVideoPreviewModal && Boolean(videoPreviewUrl)}
        src={videoPreviewUrl || ''}
        initialTrim={videoTrim}
        onTrimChange={onVideoTrimChange}
        onClose={onCloseVideoPreview}
        onNext={onNextVideoPreview}
      />

      {showCreateModal && (
        <CreatePostModal
          profile={profile}
          userId={userId}
          postText={postText}
          selectedFiles={selectedFiles}
          fileType={fileType}
          filePreviews={filePreviews}
          videoTrim={videoTrim}
          isSubmitting={isSubmitting}
          createError={createError}
          onPostTextChange={onPostTextChange}
          onRemoveFile={onRemoveFile}
          onPublish={onPublish}
          onClose={onCloseCreatePost}
        />
      )}

      <SettingsModal isOpen={showSettingsModal} onClose={onCloseSettings} currentProfile={profile} onSignOut={onSignOut} />
      <NotificationsModalComponent isOpen={showNotifsModal} onClose={onCloseNotifications} currentUserId={userId} />

      <button
        onClick={onOpenAssistant}
        className="fixed bottom-20 left-6 z-50 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white p-3.5 rounded-full shadow-2xl flex items-center justify-center transition-transform hover:scale-110 active:scale-95 border border-white/20"
        title="فتح المساعد الذكي"
      >
        <Bot className="w-6 h-6" />
      </button>

      <AIAssistantModal open={showAssistantModal} onClose={onCloseAssistant} />
    </>
  );
}
