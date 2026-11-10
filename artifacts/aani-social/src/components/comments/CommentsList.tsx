import React from 'react';
import { MessageCircle } from 'lucide-react';

import type { CommentWithDetails } from '../../lib/interactions';
import CommentItem from '../CommentItem';
import { CommentsSkeleton } from '../Skeletons';

interface CommentsListProps {
  comments: CommentWithDetails[];
  currentUserId: string;
  postOwnerId: string | null;
  restrictedUserIds: Set<string>;
  pendingDeleteIds: Record<string, boolean>;
  pendingEditIds: Record<string, boolean>;
  pendingActionIds: Record<string, boolean>;
  storyOwners: Set<string>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReply: (comment: CommentWithDetails) => void;
  onToggleLike: (commentId: string, isLiked: boolean) => void | Promise<void>;
  onToggleDislike: (commentId: string, isDisliked: boolean) => void | Promise<void>;
  onEdit: (comment: CommentWithDetails, content: string) => Promise<boolean>;
  onDelete: (comment: CommentWithDetails) => void | Promise<void>;
  onCopy: (comment: CommentWithDetails) => void | Promise<void>;
  onReport: (comment: CommentWithDetails) => void | Promise<void>;
  onHide: (comment: CommentWithDetails) => void | Promise<void>;
  onTogglePin: (comment: CommentWithDetails) => void | Promise<void>;
  onBlock: (comment: CommentWithDetails) => void | Promise<void>;
  onToggleRestriction: (userId: string, restricted: boolean) => void | Promise<void>;
  highlightCommentId?: string | null;
}

const CommentsList: React.FC<CommentsListProps> = ({
  comments,
  currentUserId,
  postOwnerId,
  restrictedUserIds,
  pendingDeleteIds,
  pendingEditIds,
  pendingActionIds,
  storyOwners,
  loading,
  error,
  onRetry,
  onReply,
  onToggleLike,
  onToggleDislike,
  onEdit,
  onDelete,
  onCopy,
  onReport,
  onHide,
  onTogglePin,
  onBlock,
  onToggleRestriction,
  highlightCommentId,
}) => (
  <div className="comments-list flex-1 overflow-y-auto overscroll-contain px-4 py-1">
    {error && (
      <div
        className="my-3 flex items-center justify-between gap-3 rounded-xl border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-200"
        role="alert"
      >
        <span>{error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold hover:bg-red-900/50"
        >
          إعادة المحاولة
        </button>
      </div>
    )}

    {loading && comments.length === 0 && !error ? (
      <CommentsSkeleton count={4} />
    ) : !loading && !error && comments.length === 0 ? (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-zinc-500">
        <MessageCircle size={32} className="text-zinc-700" />
        <p>لا توجد تعليقات بعد... كن أول من يعلق!</p>
      </div>
    ) : comments.length > 0 ? (
      comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          currentUserId={currentUserId}
          postOwnerId={postOwnerId}
          restrictedUserIds={restrictedUserIds}
          pendingDeleteIds={pendingDeleteIds}
          pendingEditIds={pendingEditIds}
          pendingActionIds={pendingActionIds}
          storyOwners={storyOwners}
          highlightCommentId={highlightCommentId}
          onReply={onReply}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          onEdit={onEdit}
          onDelete={onDelete}
          onCopy={onCopy}
          onReport={onReport}
          onHide={onHide}
          onTogglePin={onTogglePin}
          onBlock={onBlock}
          onToggleRestriction={onToggleRestriction}
        />
      ))
    ) : null}
  </div>
);

export default CommentsList;
