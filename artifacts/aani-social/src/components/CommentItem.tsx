
import React, { useState } from 'react';
import {
  Heart,
  MoreHorizontal,
  Reply,
  ThumbsDown,
  Trash2,
  X,
} from 'lucide-react';
import type { CommentWithDetails } from '../lib/interactions';
import CommentText from './CommentText';
import UserIdentity from './UserIdentity';

interface CommentItemProps {
  comment: CommentWithDetails;
  currentUserId?: string;
  depth?: number;
  /** اسم صاحب التعليق الأصلي الذي يرد عليه هذا الرد (يظهر كإشارة @) */
  replyTo?: string;
  /** في العرض المسطّح تُدار قائمة الردود من التعليق الأساسي فقط */
  renderReplies?: boolean;
  onReply: (comment: CommentWithDetails) => void;
  onToggleLike: (commentId: string, isLiked: boolean) => void | Promise<void>;
  onToggleDislike: (commentId: string, isDisliked: boolean) => void | Promise<void>;
  onDelete: (comment: CommentWithDetails) => void | Promise<void>;
  pendingDeleteIds?: Record<string, boolean>;
  storyOwners?: Set<string>;
  highlightCommentId?: string | null;
}

type FlatReply = {
  comment: CommentWithDetails;
  replyTo?: string;
};

const formatRelativeTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'الآن';

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes === 0) return 'الآن';
  if (minutes === 1) return 'منذ دقيقة';
  if (minutes === 2) return 'منذ دقيقتين';
  if (minutes < 11) return `منذ ${minutes} دقائق`;
  if (minutes < 60) return `منذ ${minutes} دقيقة`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'منذ ساعة';
  if (hours === 2) return 'منذ ساعتين';
  if (hours < 11) return `منذ ${hours} ساعات`;
  if (hours < 24) return `منذ ${hours} ساعة`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'منذ يوم';
  if (days === 2) return 'منذ يومين';
  if (days < 11) return `منذ ${days} أيام`;
  if (days < 30) return `منذ ${days} يوم`;

  const months = Math.floor(days / 30);
  if (months === 1) return 'منذ شهر';
  if (months === 2) return 'منذ شهرين';
  if (months < 11) return `منذ ${months} أشهر`;
  return `منذ ${months} شهر`;
};

const buildInitials = (fullName?: string | null): string => {
  const source = (fullName ?? '').trim();
  if (!source) return 'آ';

  const initials = source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);

  return initials || 'آ';
};

const formatRepliesLabel = (count: number): string => {
  if (count === 1) return 'عرض ردّ واحد';
  if (count === 2) return 'عرض ردّين';
  if (count <= 10) return `عرض ${count} ردود`;
  return `عرض ${count} ردًّا`;
};

const mentionLabel = (comment?: CommentWithDetails): string | undefined => {
  const fullName = comment?.profiles?.full_name?.trim();
  if (fullName) return fullName;
  const username = comment?.profiles?.username?.trim();
  return username || undefined;
};

/**
 * تسطيح الردود: كل الردود (بأي مستوى) تُعرض في قائمة واحدة مستقيمة،
 * ويُحفظ سياق الرد عبر إشارة @اسم صاحب التعليق الأصلي بدل الإزاحة البصرية.
 */
const flattenReplies = (
  items: CommentWithDetails[],
  parent?: CommentWithDetails,
): FlatReply[] =>
  items.flatMap((item) => [
    { comment: item, replyTo: mentionLabel(parent) },
    ...flattenReplies(item.replies ?? [], item),
  ]);

export const CommentItem: React.FC<CommentItemProps> = ({
  comment,
  currentUserId,
  depth = 0,
  replyTo,
  renderReplies = true,
  onReply,
  onToggleLike,
  onToggleDislike,
  onDelete,
  pendingDeleteIds = {},
  storyOwners = new Set<string>(),
  highlightCommentId,
}) => {
  const flatReplies = flattenReplies(comment.replies ?? []);
  const shouldShowHighlightedReply = Boolean(highlightCommentId && flatReplies.some(reply => reply.comment.id === highlightCommentId));
  const [showReplies, setShowReplies] = useState(shouldShowHighlightedReply);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);

  const replyCount = flatReplies.length;
  const author = comment.profiles;
  const displayName = author?.full_name || 'مستخدم آني';
  const isReply = depth > 0;
  const hasActiveStory = storyOwners.has(comment.user_id);
  const ringClasses = hasActiveStory
    ? 'ring-[1.5px] ring-[#FF0000]'
    : 'ring-1 ring-zinc-800';
  const isOwnComment = currentUserId === comment.user_id;
  const isDeleting = !!pendingDeleteIds[comment.id];

  return (
    <div
      id={`comment-${comment.id}`}
      className={`relative rounded-xl transition-colors ${highlightCommentId === comment.id ? 'bg-pink-500/[0.06] ring-1 ring-pink-400/60' : ''}`}
    >
      <div className="comment-row relative flex py-2" dir="rtl">
        <div className="comment-avatar-wrap shrink-0">
          {author?.avatar_url ? (
            <img
              src={author.avatar_url}
              alt={displayName}
              className={`comment-avatar ${ringClasses}`}
            />
          ) : (
            <div className={`comment-avatar comment-avatar-fallback ${ringClasses}`}>
              {buildInitials(displayName)}
            </div>
          )}
        </div>

        <div className="comment-content min-w-0 flex-1">
          <div className="comment-header">
            <div className="comment-author-line">
              <UserIdentity
                name={displayName}
                username={author?.username?.replace(/^@+/, '')}
                className="comment-author-identity"
                nameClassName="comment-author-name"
                usernameClassName="comment-author-username"
              />
              <time className="comment-time">
                {formatRelativeTime(comment.created_at)}
              </time>
            </div>

            {isOwnComment && (
              <div className="comment-options relative shrink-0">
                <button
                  type="button"
                  onClick={() => setShowMenu((visible) => !visible)}
                  className="comment-options-button rounded-full text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="خيارات التعليق"
                  aria-expanded={showMenu}
                >
                  <MoreHorizontal size={16} />
                </button>
                {showMenu && (
                  <div className="absolute left-0 top-full z-20 min-w-32 rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => {
                        setShowMenu(false);
                        void onDelete(comment);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-red-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                      حذف التعليق
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="comment-content-row">
            <div
              className="comments-text-bubble whitespace-pre-wrap break-words text-right font-normal"
              dir="rtl"
              style={{ unicodeBidi: 'isolate' }}
            >
              {isReply && replyTo && (
                <span className="me-1 font-semibold text-pink-400">{replyTo}</span>
              )}
              <CommentText text={comment.content} />
            </div>

            <div className="comment-reactions" dir="rtl">
              <button
                type="button"
                onClick={() => void onToggleLike(comment.id, !!comment.is_liked)}
                aria-pressed={!!comment.is_liked}
                className={`comment-reaction-button ${comment.is_liked ? 'is-liked' : ''}`}
                aria-label={`إعجاب، ${comment.likes_count ?? 0}`}
              >
                <Heart
                  size={16}
                  fill={comment.is_liked ? 'currentColor' : 'none'}
                  strokeWidth={1.8}
                />
                <span>{comment.likes_count ?? 0}</span>
              </button>

              <button
                type="button"
                onClick={() => void onToggleDislike(comment.id, !!comment.is_disliked)}
                aria-pressed={!!comment.is_disliked}
                className={`comment-reaction-button ${comment.is_disliked ? 'is-disliked' : ''}`}
                aria-label={`عدم إعجاب، ${comment.dislikes_count ?? 0}`}
              >
                <ThumbsDown size={16} strokeWidth={1.8} />
                <span>{comment.dislikes_count ?? 0}</span>
              </button>
            </div>
          </div>

          {comment.image_url && (
            <button
              type="button"
              onClick={() => setExpandedImage(comment.image_url || null)}
              className="mt-2 block overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
            >
              <img
                src={comment.image_url}
                alt="مرفق التعليق"
                className="max-h-64 w-full object-cover transition hover:scale-[1.01]"
              />
            </button>
          )}

          <div className="comment-bottom-actions">
            <button
              type="button"
              onClick={() => onReply(comment)}
              className="comment-reply-button"
              aria-label={`الرد${replyCount ? `، ${replyCount} ردود` : ''}`}
            >
              <Reply size={14} style={{ transform: 'scaleX(-1)' }} />
              <span>رد</span>
              {replyCount > 0 && <span>{replyCount}</span>}
            </button>

            {renderReplies && replyCount > 0 && (
              <div className="comment-replies-toggle">
                <button
                  type="button"
                  onClick={() => setShowReplies((prev) => !prev)}
                  className="comment-replies-button"
                  aria-expanded={showReplies}
                >
                  <span className="comment-thread-divider" aria-hidden="true" />
                  <span>{showReplies ? 'إخفاء الردود' : formatRepliesLabel(replyCount)}</span>
                </button>
              </div>
            )}
          </div>

          {renderReplies && showReplies && replyCount > 0 && (
            <div className="relative mt-1 space-y-1 border-r-[1.5px] border-zinc-700/60 pr-3">
              {flatReplies.map(({ comment: reply, replyTo: replyMention }) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  depth={1}
                  replyTo={replyMention}
                  renderReplies={false}
                  currentUserId={currentUserId}
                  onReply={onReply}
                  onToggleLike={onToggleLike}
                  onToggleDislike={onToggleDislike}
                  onDelete={onDelete}
                  pendingDeleteIds={pendingDeleteIds}
                  storyOwners={storyOwners}
                  highlightCommentId={highlightCommentId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {expandedImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setExpandedImage(null)}
        >
          <div className="relative max-h-[80vh] max-w-3xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 p-2">
            <button
              type="button"
              onClick={() => setExpandedImage(null)}
              className="absolute right-3 top-3 z-10 rounded-full bg-black/70 p-2 text-white"
              aria-label="إغلاق الصورة"
            >
              <X size={16} />
            </button>

            <img
              src={expandedImage}
              alt="صورة مكبرة"
              className="max-h-[80vh] max-w-full rounded-xl object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default CommentItem;
