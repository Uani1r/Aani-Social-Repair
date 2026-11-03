export type MentionCandidate = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
};

export type CommentComposerProfile = {
  full_name: string;
  username: string;
  avatar_url: string | null;
} | null;
