
export type ProfileNotificationSettings = {
  messages: boolean;
  followers: boolean;
  interactions: boolean;
  stories: boolean;
};

export type Profile = {
  id: string;
  username: string;
  full_name: string;
  display_name?: string | null;
  avatar_url: string | null;
  cover_url?: string | null;
  cover_position_x?: number | null;
  cover_position_y?: number | null;
  location?: string | null;
  city?: string | null;
  job?: string | null;
  birth_date?: string | null;
  show_city?: boolean | null;
  show_job?: boolean | null;
  show_birth_date?: boolean | null;
  website?: string | null;
  bio: string;
  is_private?: boolean;
  notification_settings?: ProfileNotificationSettings | null;
  appearance_preference?: 'dark' | 'light' | 'system' | null;
  language_preference?: 'ar' | 'en' | null;
  hd_uploads?: boolean | null;
  data_saver?: boolean | null;
  font_preference?: 'alexandria' | 'ibm-plex-sans-arabic' | 'tajawal' | 'cairo' | 'noto-sans-arabic' | null;
  created_at?: string | null;
};

export type PostMetadataTag = {
  kind: 'location' | 'link' | 'mention';
  label: string;
  href: string;
  profileId?: string;
};

export type VideoTrimRange = {
  start: number;
  end: number;
  duration: number;
};

export type VideoAspectRatio = 'free' | '4:5' | '1:1' | '9:16';

export type VideoCropTransform = {
  zoom: number;
  x: number;
  y: number;
  aspectRatio?: VideoAspectRatio;
  sourceAspectRatio?: number;
};

export const normalizePostMetadata = (value: unknown): PostMetadataTag[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): PostMetadataTag[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const kind = row.kind;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    if (!label || (kind !== 'location' && kind !== 'link' && kind !== 'mention')) return [];

    if (kind === 'mention') {
      const profileId = typeof row.profileId === 'string' ? row.profileId.trim() : '';
      if (!profileId) return [];
      return [{ kind, label: label.replace(/^@+/, ''), href: `/profile/${encodeURIComponent(profileId)}`, profileId }];
    }

    if (typeof row.href !== 'string') return [];
    try {
      const parsed = new URL(row.href);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return [];
      return [{ kind, label, href: parsed.href }];
    } catch {
      return [];
    }
  });
};

export type PostVisibility = 'public' | 'private';
export type CommentPrivacy = 'public' | 'followers' | 'custom';
export type PostDestination = 'feed' | 'reels';

export type Post = {
  id: string;
  user_id: string;
  content: string;
  post_metadata?: PostMetadataTag[];
  media_url: string | null;
  media_urls?: string[] | null;
  type: "text" | "photo" | "reel";
  destination?: PostDestination;
  visibility?: PostVisibility;
  created_at: string;
  author: Profile | null;

  likes_count?: number;
  comments_count?: number;
  reposts_count?: number;
  shares_count?: number;
  saves_count?: number;
  reposted_at?: string | null;
  reposter_id?: string | null;
  repost_attribution?: Profile | null;

  /** Owner can close the comment thread for a single post. */
  comments_disabled?: boolean;
  hide_likes?: boolean;
  hide_comments?: boolean;
  comment_privacy?: CommentPrivacy;
  /** Optional audio / music attached to the post. */
  audio_url?: string | null;
  audio_title?: string | null;
  /** Viewer feedback used by the "مهتم / غير مهتم" menu. */
  feedback?: PostFeedback | null;

  liked_by_me?: boolean;
  saved_by_me?: boolean;
  reposted_by_me?: boolean;
  feedback_by_me?: 'interested' | 'not_interested' | null;

  likes?: { user_id: string }[];
  comments?: PostComment[];
};

export const getPostDestination = (post: Pick<Post, 'type' | 'destination'>): PostDestination =>
  post.destination ?? 'feed';

export type PostRow = Pick<
  Post,
  'id' | 'user_id' | 'content' | 'media_url' | 'media_urls' | 'post_metadata' | 'type' | 'destination' | 'visibility' | 'created_at'
> & {
  hide_likes?: boolean;
  hide_comments?: boolean;
  comment_privacy?: CommentPrivacy;
  reposter_id?: string | null;
};

export type PostFeedback = "interested" | "not_interested";

export type PostComment = {
  id: string;
  post_id?: string;
  user_id?: string;
  userId?: string;
  content?: string;
  text?: string;
  created_at?: string;
  createdAt?: string;
};

const PLACEHOLDER_PROFILE_NAMES = new Set([
  'new member',
  'new user',
  'member',
  'user',
  'unknown',
  'unknown user',
  'username',
  'عضو جديد',
  'عضو آني',
  'مستخدم',
  'مستخدم جديد',
  'مستخدم آني',
]);

export const cleanUsername = (username?: string | null): string =>
  (username || '').trim().replace(/^@+/, '').trim();

type DisplayNameProfile = {
  full_name?: string | null;
  display_name?: string | null;
  username?: string | null;
};

export const displayName = (
  profile?: DisplayNameProfile | null,
): string => {
  const name = [profile?.full_name, profile?.display_name]
    .map(value => value?.trim() || '')
    .find(value => value && !PLACEHOLDER_PROFILE_NAMES.has(value.toLowerCase()));
  return name || cleanUsername(profile?.username) || 'عضو آني';
};

export const normalizeProfile = (
  value: unknown,
): Profile | null => {
  const row = Array.isArray(value) ? value[0] : value;

  if (!row || typeof row !== "object") return null;

  return row as Profile;
};

export const formatCount = (value?: number | null): string => {
  const count = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")} ألف`;
  }
  const millions = count / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")} مليون`;
};

export const formatDate = (value: string): string => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};
