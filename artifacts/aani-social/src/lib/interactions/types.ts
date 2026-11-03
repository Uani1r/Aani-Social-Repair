import type { Post, Profile } from "../types";

export type InteractionSnapshot = {
  likes: number;
  comments: number;
  reposts: number;
  shares: number;
  saves: number;
  liked: boolean;
  bookmarked: boolean;
  reposted: boolean;
  shared: boolean;
  feedback?: Post["feedback_by_me"];
  hydrated: boolean;
};

export type CommentAuthor = Partial<Profile> | null;

export type PostCommentRow = {
  id: string;
  post_id: string;
  user_id: string;
  content: string;
  created_at: string;
  author: CommentAuthor;
};

export interface CommentWithDetails {
  id: string;
  post_id: string;
  user_id: string;
  parent_id: string | null;
  content: string;
  image_url: string | null;
  created_at: string;
  profiles: {
    full_name: string;
    username: string;
    avatar_url: string | null;
  } | null;
  likes_count?: number;
  dislikes_count?: number;
  is_liked?: boolean;
  is_disliked?: boolean;
  replies?: CommentWithDetails[];
}

export type RawRow = Record<string, any>;

export type LocalPostState = {
  liked?: boolean;
  bookmarked?: boolean;
  reposted?: boolean;
  shared?: boolean;
  likes?: number;
  reposts?: number;
  shares?: number;
  comments?: number;
};

export type LocalFlags = Record<string, LocalPostState>;

export type PostInteractions = InteractionSnapshot & {
  pending: boolean;
  toggleLike: () => Promise<void>;
  toggleBookmark: () => Promise<void>;
  toggleRepost: () => Promise<void>;
  share: () => Promise<void>;
};

export type UploadedCommentImage = {
  publicUrl: string;
  path: string;
};

export type PostComments = {
  comments: PostCommentRow[] | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
  load: () => Promise<void>;
  add: (content: string) => Promise<boolean>;
  remove: (commentId: string) => Promise<void>;
};

export type SavedPostsState = {
  posts: Post[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
