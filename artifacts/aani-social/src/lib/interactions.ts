/**
 * Public compatibility facade for the focused interaction modules.
 * Existing components can keep importing from `lib/interactions`.
 */
export {
  readInteractionState,
  readLocalFlags,
  snapshotFromPost,
} from "./interactions/store";

export {
  decoratePost,
  decoratePosts,
  hydratePostIds,
  hydratePostRows,
  hydratePosts,
  hydrateSavesCount,
  syncCommentCount,
} from "./interactions/hydration";

export {
  buildPostUrl,
  postShareText,
  postShareUrl,
  recordShare,
  toggleBookmark,
  toggleLike,
  toggleRepost,
  toggleSavePost,
} from "./interactions/mutations";

export {
  fetchCommentsWithReplies,
  toggleCommentDislike,
  toggleCommentLike,
  translateText,
  uploadCommentImage,
  usePostComments,
} from "./interactions/comments";

export { createComment, deleteComment } from "./interactions/commentWrites";
export { useInteractionRealtime } from "./interactions/realtime";
export { useInteractionsVersion, usePostInteractions } from "./interactions/hooks";
export { fetchSavedPosts, useSavedPosts } from "./interactions/saved";

export type {
  CommentAuthor,
  CommentWithDetails,
  InteractionSnapshot,
  PostCommentRow,
  PostComments,
  PostInteractions,
  SavedPostsState,
  UploadedCommentImage,
} from "./interactions/types";
