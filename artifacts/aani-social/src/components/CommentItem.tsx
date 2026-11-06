import React, { useState } from 'react';
import {
  Ban,
  Copy,
  EyeOff,
  Flag,
  Heart,
  MoreVertical,
  Pencil,
  Pin,
  Reply,
  ShieldCheck,
  ThumbsDown,
  Trash2,
  X,
} from 'lucide-react';
import type { CommentWithDetails } from '../lib/interactions';
import CommentText from './CommentText';
import UserIdentity from './UserIdentity';
import { cleanUsername, displayName } from '../lib/types';

interface CommentItemProps {
  comment: CommentWithDetails;
  currentUserId?: string;
  postOwnerId?: string | null;
  restrictedUserIds?: Set<string>;
  depth?: number;
  /** اسم صاحب التعليق الأصلي الذي يرد عليه هذا الرد (يظهر كإشارة @) */
  replyTo?: string;
  /** في العرض المسطّح تُدار قائمة الردود من التعليق الأساسي فقط */
  renderReplies?: boolean;
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
  pendingDeleteIds?: Record<string, boolean>;
  pendingEditIds?: Record<string, boolean>;
  pendingActionIds?: Record<string, boolean>;
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
  postOwnerId,
  restrictedUserIds = new Set<string>(),
  depth = 0,
  replyTo,
  renderReplies = true,
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
  pendingDeleteIds = {},
  pendingEditIds = {},
  pendingActionIds = {},
  storyOwners = new Set<string>(),
  highlightCommentId,
}) => {
  const flatReplies = flattenReplies(comment.replies ?? []);
  const shouldShowHighlightedReply = Boolean(highlightCommentId && flatReplies.some(reply => reply.comment.id === highlightCommentId));
  const [showReplies, setShowReplies] = useState(shouldShowHighlightedReply);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const [savingEdit, setSavingEdit] = useState(false);

  const replyCount = flatReplies.length;
  const author = comment.profiles;
  const authorName = displayName(author);
  const isReply = depth > 0;
  const hasActiveStory = storyOwners.has(comment.user_id);
  const ringClasses = hasActiveStory
    ? 'ring-[1.5px] ring-[#FF0000]'
    : 'ring-1 ring-zinc-800';
  const isOwnComment = currentUserId === comment.user_id;
  const isPostOwner = Boolean(currentUserId && postOwnerId === currentUserId);
  const canModerate = isPostOwner && !isOwnComment;
  const isDeleting = !!pendingDeleteIds[comment.id];
  const isActionPending = !!pendingActionIds[comment.id] || !!pendingActionIds[comment.user_id] || isDeleting;
  const isAuthorRestricted = restrictedUserIds.has(comment.user_id);
  const canShowMenu = Boolean(currentUserId);

  const saveEdit = async () => {
    if (savingEdit || (!editContent.trim() && !comment.image_url)) return;
    setSavingEdit(true);
    try {
      if (await onEdit(comment, editContent)) setIsEditing(false);
    } finally {
      setSavingEdit(false);
    }
  };

  const selectAction = (action: () => void | Promise<void>) => {
    setShowMenu(false);
    void action();
  };

  return (
    <div
      id={`comment-${comment.id}`}
      className="comment-item relative"
    >
      <div className="comment-row relative flex py-2" dir="rtl">
        <div className="comment-avatar-wrap shrink-0">
          {author?.avatar_url ? (
            <img
              src={author.avatar_url}
              alt={authorName}
              className={`comment-avatar ${ringClasses}`}
            />
          ) : (
            <div className={`comment-avatar comment-avatar-fallback ${ringClasses}`}>
              {buildInitials(authorName)}
            </div>
          )}
        </div>

        <div className="comment-content min-w-0 flex-1">
          <div className="comment-header">
            <div className="comment-author-line">
              <UserIdentity
                name={authorName}
                username={cleanUsername(author?.username)}
                className="comment-author-identity"
                nameClassName="comment-author-name"
                usernameClassName="comment-author-username"
              />
              <div className="comment-author-meta">
                <time className="comment-time">
                  {formatRelativeTime(comment.created_at)}
                </time>
                {canShowMenu && (
                  <div className="comment-options relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowMenu((visible) => !visible)}
                      className="comment-options-button rounded-full transition hover:bg-zinc-800"
                      aria-label="خيارات التعليق"
                      aria-expanded={showMenu}
                      disabled={isActionPending}
                    >
                      <MoreVertical size={14} />
                    </button>
                    {showMenu && (
                      <div className="absolute left-0 top-full z-20 min-w-40 rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                        {isOwnComment ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditContent(comment.content);
                                setIsEditing(true);
                                setShowMenu(false);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                            >
                              <Pencil size={14} /> تعديل التعليق
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => selectAction(() => onDelete(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-red-300 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              <Trash2 size={14} /> حذف التعليق
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAction(() => onCopy(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                            >
                              <Copy size={14} /> نسخ التعليق
                            </button>
                          </>
                        ) : canModerate ? (
                          <>
                            <button
                              type="button"
                              disabled={isActionPending}
                              onClick={() => selectAction(() => onTogglePin(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              <Pin size={14} /> {comment.is_pinned ? 'إلغاء تثبيت التعليق' : 'تثبيت التعليق'}
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => selectAction(() => onDelete(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-red-300 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              <Trash2 size={14} /> حذف التعليق
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAction(() => onReport(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                            >
                              <Flag size={14} /> إبلاغ عن التعليق
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAction(() => onCopy(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                            >
                              <Copy size={14} /> نسخ التعليق
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAction(() => onBlock(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-amber-300 hover:bg-zinc-800"
                            >
                              <Ban size={14} /> حظر الكاتب
                            </button>
                            <button
                              type="button"
                              disabled={isActionPending}
                              onClick={() => selectAction(() => onToggleRestriction(comment.user_id, !isAuthorRestricted))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              <ShieldCheck size={14} /> {isAuthorRestricted ? 'إلغاء تقييد الكاتب' : 'تقييد الكاتب'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => selectAction(() => onCopy(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                            >
                              <Copy size={14} /> نسخ التعليق
                            </button>
                            {!isOwnComment && (
                              <button
                                type="button"
                                onClick={() => selectAction(() => onReport(comment))}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800"
                              >
                                <Flag size={14} /> إبلاغ عن التعليق
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={isActionPending}
                              onClick={() => selectAction(() => onHide(comment))}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              <EyeOff size={14} /> إخفاء من قائمتي
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {comment.is_pinned && (
              <span className="comment-pinned-badge" aria-label="تعليق مثبت">
                <Pin size={12} /> مثبت
              </span>
            )}
          </div>

          <div className="comment-content-row">
            <div className="min-w-0 flex-1">
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={event => setEditContent(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    dir="rtl"
                    aria-label="تعديل التعليق"
                    className="w-full resize-y rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-100 outline-none focus:border-pink-500"
                  />
                  <div className="flex justify-start gap-2">
                    <button
                      type="button"
                      onClick={() => setIsEditing(false)}
                      disabled={savingEdit || !!pendingEditIds[comment.id]}
                      className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveEdit()}
                      disabled={savingEdit || !!pendingEditIds[comment.id] || (!editContent.trim() && !comment.image_url)}
                      className="rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-500 disabled:opacity-50"
                    >
                      {savingEdit || pendingEditIds[comment.id] ? 'جارٍ الحفظ…' : 'حفظ التعديل'}
                    </button>
                  </div>
                </div>
              ) : (
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
              )}
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
                  postOwnerId={postOwnerId}
                  restrictedUserIds={restrictedUserIds}
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
                  pendingDeleteIds={pendingDeleteIds}
                  pendingEditIds={pendingEditIds}
                  pendingActionIds={pendingActionIds}
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
