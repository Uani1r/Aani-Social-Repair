
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

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diffMs / 60000));
  if (minutes < 60) return `${minutes} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} س`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ي`;
  const months = Math.floor(days / 30);
  return `${months} ش`;
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
      <div
        className="relative flex gap-4 py-2"
        dir="rtl"
      >
        <div className="flex shrink-0">
          {author?.avatar_url ? (
            <img
              src={author.avatar_url}
              alt={displayName}
              className={`rounded-full object-cover ${ringClasses} ${
                isReply ? 'h-8 w-8' : 'h-10 w-10'
              }`}
            />
          ) : (
            <div
              className={`flex items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 font-bold text-white ${ringClasses} ${
                isReply ? 'h-8 w-8 text-[11px]' : 'h-10 w-10 text-sm'
              }`}
            >
              {buildInitials(displayName)}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <UserIdentity
                name={displayName}
                username={author?.username}
                nameClassName={`font-bold text-white ${isReply ? 'text-[13px]' : 'text-[15px]'}`}
                usernameClassName={`text-zinc-500 ${isReply ? 'text-[10px]' : 'text-[11px]'}`}
              />
              <time className="mt-1 block text-[11px] text-zinc-500">
                {formatRelativeTime(comment.created_at)}
              </time>
            </div>

            <div className="flex shrink-0 items-start gap-2">
              {isOwnComment && (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowMenu((visible) => !visible)}
                    className="rounded-full p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                    aria-label="خيارات التعليق"
                    aria-expanded={showMenu}
                  >
                    <MoreHorizontal size={18} />
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
          </div>

          <div
            className={`mt-1 whitespace-pre-wrap break-words text-right font-normal text-zinc-300 ${
              isReply ? 'text-[13px] leading-6' : 'text-[14px] leading-7'
            }`}
            dir="rtl"
            style={{ unicodeBidi: 'isolate' }}
          >
            {isReply && replyTo && (
              <span className="me-1 font-semibold text-pink-400">{replyTo}</span>
            )}
            <CommentText text={comment.content} />
          </div>

          {comment.image_url && (
            <button
              type="button"
              onClick={() => setExpandedImage(comment.image_url || null)}
              className="mt-3 block overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
            >
              <img
                src={comment.image_url}
                alt="مرفق التعليق"
                className="max-h-64 w-full object-cover transition hover:scale-[1.01]"
              />
            </button>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-400">
            <button
              type="button"
              onClick={() => onReply(comment)}
              className="inline-flex items-center gap-1.5 py-1 transition hover:text-zinc-100"
              aria-label={`الرد${replyCount ? `، ${replyCount} ردود` : ''}`}
            >
              <Reply size={17} style={{ transform: 'scaleX(-1)' }} />
              <span>رد</span>
              {replyCount > 0 && <span>{replyCount}</span>}
            </button>

            <button
              type="button"
              onClick={() => void onToggleLike(comment.id, !!comment.is_liked)}
              aria-pressed={!!comment.is_liked}
              className={`inline-flex items-center gap-1.5 py-1 transition ${
                comment.is_liked
                  ? 'text-pink-400'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
              aria-label={`إعجاب، ${comment.likes_count ?? 0}`}
            >
              <Heart
                size={16}
                fill={comment.is_liked ? 'currentColor' : 'none'}
                strokeWidth={1.8}
              />
              <span className="text-[11px]">{comment.likes_count ?? 0}</span>
            </button>

            <button
              type="button"
              onClick={() =>
                void onToggleDislike(comment.id, !!comment.is_disliked)
              }
              aria-pressed={!!comment.is_disliked}
              className={`inline-flex items-center gap-1.5 py-1 transition ${
                comment.is_disliked
                  ? 'text-pink-400'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
              aria-label={`عدم إعجاب، ${comment.dislikes_count ?? 0}`}
            >
              <ThumbsDown size={16} strokeWidth={1.8} />
              <span className="text-[11px]">{comment.dislikes_count ?? 0}</span>
            </button>
          </div>
        </div>
      </div>

      {renderReplies && replyCount > 0 && (
        <div className="px-2 pt-2 text-right">
          <button
            type="button"
            onClick={() => setShowReplies((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-800/90 px-2.5 py-1 text-[10px] text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
            aria-expanded={showReplies}
          >
            {showReplies ? 'إخفاء الردود' : formatRepliesLabel(replyCount)}
          </button>
        </div>
      )}

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
