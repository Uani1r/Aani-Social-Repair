import React from 'react';
import { MessageCircle } from 'lucide-react';

import type { CommentWithDetails } from '../../lib/interactions';
import CommentItem from '../CommentItem';

interface CommentsListProps {
  comments: CommentWithDetails[];
  currentUserId: string;
  pendingDeleteIds: Record<string, boolean>;
  storyOwners: Set<string>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReply: (comment: CommentWithDetails) => void;
  onToggleLike: (commentId: string, isLiked: boolean) => void | Promise<void>;
  onToggleDislike: (commentId: string, isDisliked: boolean) => void | Promise<void>;
  onDelete: (comment: CommentWithDetails) => void | Promise<void>;
  highlightCommentId?: string | null;
}

const CommentsList: React.FC<CommentsListProps> = ({
  comments,
  currentUserId,
  pendingDeleteIds,
  storyOwners,
  loading,
  error,
  onRetry,
  onReply,
  onToggleLike,
  onToggleDislike,
  onDelete,
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
      <div className="space-y-5 py-4" role="status" aria-label="جارٍ تحميل التعليقات">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex animate-pulse items-start gap-3">
            <div className="h-10 w-10 shrink-0 rounded-full bg-zinc-800" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3 w-24 rounded bg-zinc-800" />
              <div className="h-3 w-full rounded bg-zinc-800/70" />
              <div className="h-3 w-2/3 rounded bg-zinc-800/50" />
            </div>
          </div>
        ))}
      </div>
    ) : !loading && !error && comments.length === 0 ? (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-zinc-500">
        <MessageCircle size={32} className="text-zinc-700" />
        <p className="text-sm">لا توجد تعليقات بعد... كن أول من يعلق!</p>
      </div>
    ) : comments.length > 0 ? (
      comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          currentUserId={currentUserId}
          pendingDeleteIds={pendingDeleteIds}
          storyOwners={storyOwners}
          highlightCommentId={highlightCommentId}
          onReply={onReply}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          onDelete={onDelete}
        />
      ))
    ) : null}
  </div>
);

export default CommentsList;
