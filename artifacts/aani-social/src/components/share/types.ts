import type { Post } from '../../lib/types';

export interface ShareSheetProps {
  post: Post;
  currentUserId: string;
  reposted?: boolean;
  onToggleRepost?: () => boolean | Promise<boolean>;
  onRecordExternalShare?: () => void;
  onSent?: (count: number) => void;
  onClose: () => void;
}
