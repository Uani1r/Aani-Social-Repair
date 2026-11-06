import type { ComponentType, ReactNode } from 'react';

import type { Profile } from '@/lib/types';

export type NotificationsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
};

export type ShellProps = {
  children: ReactNode;
  profile: Profile | null;
  userId: string;
  onSignOut: () => void;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
  NotificationsModalComponent: ComponentType<NotificationsModalProps>;
  headerStories?: ReactNode;
};
