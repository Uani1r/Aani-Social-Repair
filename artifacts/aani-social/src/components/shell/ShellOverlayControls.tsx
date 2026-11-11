import type { ComponentType } from 'react';
import { Bot } from 'lucide-react';

import AIAssistantModal from '@/components/AIAssistantModal';
import CreatePostModal from '@/components/CreatePostModal';
import ImagePreviewModal from '@/components/ImagePreviewModal';
import PublishOptionsSheet from '@/components/PublishOptionsSheet';
import VideoPreviewModal, { type VideoMentionPerson } from '@/components/VideoPreviewModal';
import SettingsModal from '@/components/SettingsModal';
import type { PostDestination, PostMetadataTag, Profile, VideoCropTransform, VideoTrimRange } from '@/lib/types';

import type { NotificationsModalProps } from './types';

type ShellOverlayControlsProps = {
  showPublishOptionsSheet: boolean;
  onClosePublishOptionsSheet: () => void;
  onCreateTextPost: () => void;
  onImagePickerStart: () => void;
  onImagePickerCancel: () => void;
  onSelectPublishImages: (files: File[]) => void;
  onSelectPublishVideo: (file: File) => void;
  onOpenMorePublishOptions: () => void;
  showImagePreviewModal: boolean;
  imagePreviewImages: { file: File; dataUrl: string }[];
  onImagePreviewImagesChange: (images: { file: File; dataUrl: string }[]) => void;
  onCloseImagePreview: () => void;
  showVideoPreviewModal: boolean;
  videoPreviewUrl: string | null;
  videoTrim: VideoTrimRange | null;
  videoCrop: VideoCropTransform | null;
  videoCoverPreview: string | null;
  onVideoTrimChange: (range: VideoTrimRange) => void;
  onVideoCropChange: (crop: VideoCropTransform) => void;
  onVideoCoverChange: (cover: File | null, previewUrl: string | null) => void;
  onVideoMentionSelect: (person: VideoMentionPerson) => void;
  onVideoMentionDeselect: (personId: string) => void;
  initialVideoMentions: VideoMentionPerson[];
  onCloseVideoPreview: () => void;
  onNextVideoPreview: (range: VideoTrimRange, crop: VideoCropTransform) => void;
  showCreateModal: boolean;
  postText: string;
  selectedFiles: File[];
  fileType: 'image' | 'video' | null;
  destination: PostDestination;
  onDestinationChange: (destination: PostDestination) => void;
  filePreviews: { file: File; url: string }[];
  isSubmitting: boolean;
  createError: string;
  initialCreateTags: PostMetadataTag[];
  /** الصوت المختار من مكتبة أصوات التطبيق — يُربط بالمنشور عند النشر (sound_id/audio_url/audio_title + أوقات الاقتصاص) */
  music: { id: string; title: string; sourceVideoUrl?: string | null; previewUrl?: string | null; soundTrim?: { start: number; end: number } | null } | null;
  onClearMusic: () => void;
  /** هل الوسائط الحالية خلفية تلقائية مولدة من الصوت؟ */
  autoSoundMedia: boolean;
  onReplaceAutoMedia: () => void;
  onClearAutoMedia: () => void;
  /** الشاشة الموحدة لمنشورات الصور: الوصف + الوسوم + الوجهة + النشر المباشر */
  caption: string;
  onCaptionChange: (caption: string) => void;
  imageTags: PostMetadataTag[];
  onImageTagsChange: (tags: PostMetadataTag[]) => void;
  imageDestination: PostDestination;
  onImageDestinationChange: (destination: PostDestination) => void;
  onImagePublish: (images: { file: File; dataUrl: string }[]) => void;
  onPostTextChange: (text: string) => void;
  onRemoveFile: (index: number) => void;
  onPublish: (tags: PostMetadataTag[], destination: PostDestination) => void;
  onCloseCreatePost: () => void;
  showSettingsModal: boolean;
  onCloseSettings: () => void;
  profile: Profile | null;
  onProfileUpdate: (next: Profile) => void;
  onOpenNotifications: () => void;
  onSignOut: () => void;
  showNotifsModal: boolean;
  onCloseNotifications: () => void;
  openFollowRequests: boolean;
  onOpenFollowRequestsHandled: () => void;
  onOpenFollowRequests: () => void;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
  NotificationsModalComponent: ComponentType<NotificationsModalProps>;
  userId: string;
  showAssistantModal: boolean;
  hideAssistantLauncher: boolean;
  onOpenAssistant: () => void;
  onCloseAssistant: () => void;
};

export default function ShellOverlayControls({
  showPublishOptionsSheet,
  onClosePublishOptionsSheet,
  onCreateTextPost,
  onImagePickerStart,
  onImagePickerCancel,
  onSelectPublishImages,
  onSelectPublishVideo,
  onOpenMorePublishOptions,
  showImagePreviewModal,
  imagePreviewImages,
  onImagePreviewImagesChange,
  onCloseImagePreview,
  showVideoPreviewModal,
  videoPreviewUrl,
  videoTrim,
  videoCrop,
  videoCoverPreview,
  onVideoTrimChange,
  onVideoCropChange,
  onVideoCoverChange,
  onVideoMentionSelect,
  onVideoMentionDeselect,
  initialVideoMentions,
  onCloseVideoPreview,
  onNextVideoPreview,
  showCreateModal,
  postText,
  selectedFiles,
  fileType,
  destination,
  onDestinationChange,
  filePreviews,
  isSubmitting,
  createError,
  initialCreateTags,
  music,
  onClearMusic,
  autoSoundMedia,
  onReplaceAutoMedia,
  onClearAutoMedia,
  caption,
  onCaptionChange,
  imageTags,
  onImageTagsChange,
  imageDestination,
  onImageDestinationChange,
  onImagePublish,
  onPostTextChange,
  onRemoveFile,
  onPublish,
  onCloseCreatePost,
  showSettingsModal,
  onCloseSettings,
  profile,
  onProfileUpdate,
  onOpenNotifications,
  onSignOut,
  showNotifsModal,
  onCloseNotifications,
  openFollowRequests,
  onOpenFollowRequestsHandled,
  onOpenFollowRequests,
  onOpenComments,
  onOpenStory,
  NotificationsModalComponent,
  userId,
  showAssistantModal,
  hideAssistantLauncher,
  onOpenAssistant,
  onCloseAssistant,
}: ShellOverlayControlsProps) {
  return (
    <>
      <PublishOptionsSheet
        open={showPublishOptionsSheet}
        onClose={onClosePublishOptionsSheet}
        onCreateTextPost={onCreateTextPost}
        onImagePickerStart={onImagePickerStart}
        onImagePickerCancel={onImagePickerCancel}
        onImagesSelected={onSelectPublishImages}
        onVideoSelected={onSelectPublishVideo}
        onOpenMore={onOpenMorePublishOptions}
      />

      <ImagePreviewModal
        open={showImagePreviewModal}
        images={imagePreviewImages}
        onImagesChange={onImagePreviewImagesChange}
        music={music}
        onClearMusic={onClearMusic}
        caption={caption}
        onCaptionChange={onCaptionChange}
        tags={imageTags}
        onTagsChange={onImageTagsChange}
        destination={imageDestination}
        onDestinationChange={onImageDestinationChange}
        userId={userId}
        onPublish={onImagePublish}
        onClose={onCloseImagePreview}
      />

      <VideoPreviewModal
        open={showVideoPreviewModal && Boolean(videoPreviewUrl)}
        src={videoPreviewUrl || ''}
        userId={userId}
        initialTrim={videoTrim}
        initialCrop={videoCrop}
        initialCoverPreview={videoCoverPreview}
        onTrimChange={onVideoTrimChange}
        onCropChange={onVideoCropChange}
        onCoverChange={onVideoCoverChange}
        onMentionSelect={onVideoMentionSelect}
        onMentionDeselect={onVideoMentionDeselect}
        initialMentions={initialVideoMentions}
        music={music}
        onClearMusic={onClearMusic}
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
          destination={destination}
          onDestinationChange={onDestinationChange}
          filePreviews={filePreviews}
          videoTrim={videoTrim}
          videoCrop={videoCrop}
          isSubmitting={isSubmitting}
          createError={createError}
          initialTags={initialCreateTags}
          pendingSound={music}
          onClearMusic={onClearMusic}
          autoSoundMedia={autoSoundMedia}
          onReplaceAutoMedia={onReplaceAutoMedia}
          onClearAutoMedia={onClearAutoMedia}
          onPostTextChange={onPostTextChange}
          onRemoveFile={onRemoveFile}
          onPublish={onPublish}
          onClose={onCloseCreatePost}
        />
      )}

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={onCloseSettings}
        currentProfile={profile}
        onProfileUpdate={onProfileUpdate}
        onOpenNotifications={() => {
          onCloseSettings();
          onOpenNotifications();
        }}
        onSignOut={onSignOut}
      />
      <NotificationsModalComponent
        isOpen={showNotifsModal}
        onClose={onCloseNotifications}
        currentUserId={userId}
        onOpenComments={onOpenComments}
        onOpenStory={onOpenStory}
        notificationSettings={profile?.notification_settings}
        language={profile?.language_preference || 'ar'}
        openFollowRequests={openFollowRequests}
        onOpenFollowRequestsHandled={onOpenFollowRequestsHandled}
        onOpenFollowRequests={onOpenFollowRequests}
      />

      {!hideAssistantLauncher && (
        <button
          onClick={onOpenAssistant}
          className="fixed bottom-20 left-6 z-50 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white p-3.5 rounded-full shadow-2xl flex items-center justify-center transition-transform hover:scale-110 active:scale-95 border border-white/20"
          title="فتح المساعد الذكي"
        >
          <Bot className="w-6 h-6" />
        </button>
      )}

      <AIAssistantModal open={showAssistantModal} onClose={onCloseAssistant} />
    </>
  );
}
