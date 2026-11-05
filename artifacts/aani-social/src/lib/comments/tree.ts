import type { CommentWithDetails } from '../interactions/types';

export const countComments = (items: CommentWithDetails[]): number =>
  items.reduce(
    (count, item) => count + 1 + countComments(item.replies ?? []),
    0,
  );

export const insertCommentIntoTree = (
  items: CommentWithDetails[],
  optimistic: CommentWithDetails,
): CommentWithDetails[] => {
  if (!optimistic.parent_id) return [...items, optimistic];

  return items.map((item) =>
    item.id === optimistic.parent_id
      ? {
          ...item,
          replies: [...(item.replies ?? []), optimistic],
        }
      : {
          ...item,
          replies: item.replies
            ? insertCommentIntoTree(item.replies, optimistic)
            : item.replies,
        },
  );
};

export const replaceCommentInTree = (
  items: CommentWithDetails[],
  targetId: string,
  next: CommentWithDetails,
): CommentWithDetails[] =>
  items.map((item) =>
    item.id === targetId
      ? next
      : item.replies
        ? {
            ...item,
            replies: replaceCommentInTree(item.replies, targetId, next),
          }
        : item,
  );

export const removeCommentFromTree = (
  items: CommentWithDetails[],
  targetId: string,
): CommentWithDetails[] =>
  items
    .filter((item) => item.id !== targetId)
    .map((item) =>
      item.replies
        ? { ...item, replies: removeCommentFromTree(item.replies, targetId) }
        : item,
    );

export const patchCommentInTree = (
  items: CommentWithDetails[],
  targetId: string,
  patch: Partial<CommentWithDetails>,
): CommentWithDetails[] =>
  items.map((item) =>
    item.id === targetId
      ? { ...item, ...patch }
      : item.replies
        ? {
            ...item,
            replies: patchCommentInTree(item.replies, targetId, patch),
          }
        : item,
  );

export const findCommentById = (
  items: CommentWithDetails[],
  targetId: string,
): CommentWithDetails | null => {
  for (const item of items) {
    if (item.id === targetId) return item;

    const inReplies = findCommentById(item.replies ?? [], targetId);
    if (inReplies) return inReplies;
  }

  return null;
};

const sortPinnedFirst = (items: CommentWithDetails[]): CommentWithDetails[] =>
  items.sort((a, b) => {
    const pinOrder = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
    return pinOrder || a.created_at.localeCompare(b.created_at);
  });

export const buildCommentTree = (
  comments: CommentWithDetails[],
): CommentWithDetails[] => {
  const commentMap = new Map<string, CommentWithDetails>();

  comments.forEach((comment) => {
    commentMap.set(comment.id, comment);
  });

  const rootComments: CommentWithDetails[] = [];

  comments.forEach((comment) => {
    if (comment.parent_id) {
      const parent = commentMap.get(comment.parent_id);

      if (parent) {
        parent.replies!.push(comment);
        return;
      }
    }

    rootComments.push(comment);
  });

  const sortTree = (items: CommentWithDetails[]) => {
    sortPinnedFirst(items);
    items.forEach((item) => sortTree(item.replies ?? []));
    return items;
  };

  return sortTree(rootComments);
};
