import type { ComponentType, ReactNode } from 'react';

import type { Profile, ProfileNotificationSettings } from '@/lib/types';

export type NotificationsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
  notificationSettings?: ProfileNotificationSettings | null;
  language?: 'ar' | 'en';
  openFollowRequests?: boolean;
  onOpenFollowRequestsHandled?: () => void;
  onOpenFollowRequests?: () => void;
};

export type ShellProps = {
  children: ReactNode;
  profile: Profile | null;
  onProfileUpdate: (next: Profile) => void;
  userId: string;
  onSignOut: () => void;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
  NotificationsModalComponent: ComponentType<NotificationsModalProps>;
  headerStories?: ReactNode;
};
