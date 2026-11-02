import { supabase, supabaseConfigured } from './supabase';
import type { Post, Profile } from './types';

export type StoryViewerProfile = {
  id: string;
  username: string;
  full_name: string;
  display_name?: string | null;
  avatar_url: string | null;
  is_private?: boolean;
};

export const STORY_VIEWER_PLACEHOLDER_NAMES = new Set([
  'new member',
  'member',
  'عضو جديد',
  'عضو آني',
  'مستخدم',
]);

export function storyViewerDisplayName(profile: StoryViewerProfile | null): string {
  for (const candidate of [profile?.full_name, profile?.display_name]) {
    const name = candidate?.trim();
    if (name && !STORY_VIEWER_PLACEHOLDER_NAMES.has(name.toLowerCase())) return name;
  }

  return profile?.username?.trim() || 'مستخدم';
}

export type StoryViewerEntry = {
  user_id: string;
  viewed_at: string;
  viewer: StoryViewerProfile | null;
  is_liked: boolean;
  is_following: boolean;
  follow_request_pending: boolean;
};

export type StoryViewerPreviewRow = {
  user_id: string;
  viewed_at: string;
  viewer: StoryViewerProfile | null;
};

export type StoryViewerPreviewSession = {
  profileIds: string[];
  createdAt: number;
  expiresAt: number;
  expired?: boolean;
};

export type StoryViewerPreviewState = {
  storyId: string;
  storageKey: string;
  createdAt: number;
  expiresAt: number;
  rows: StoryViewerPreviewRow[];
};

export const STORY_VIEWER_PREVIEW_TTL_MS = 60 * 60 * 1000;
export const STORY_VIEWER_PREVIEW_LIMIT = 4;

export type StoryDrawPoint = { x: number; y: number };
export type StoryDrawStroke = { id: string; color: string; size: number; points: StoryDrawPoint[] };

export const STORY_DRAW_COLORS = ['#FFFFFF', '#FF3B30', '#FFCC00', '#34C759', '#007AFF', '#AF52DE'];
export const STORY_DRAW_SIZES = [3, 6, 10];

export type StoryGestureTarget = 'text' | 'image' | 'canvas';

export type StoryGestureState = {
  target: StoryGestureTarget;
  touchCount: number;
  startX: number;
  startY: number;
  startDist: number;
  startAngle: number;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  moved: boolean;
  startTime: number;
};

export type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: Profile | null;
  onSignOut: () => void;
};

export type NotificationItem = {
  id: string;
  content: string;
  type: string;
  is_read: boolean;
  created_at: string;
  actor_id?: string | null;
  entity_id?: string | null;
  actor?: Profile | null;
};

export function clampCanvas(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export function getStoryDrawPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): StoryDrawPoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0,
    y: rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0,
  };
}

/**
 * Avoids stealing horizontal gestures from inputs, dialogs, videos, and scrollable regions.
 */
export function isHorizontalGestureArea(target: EventTarget | null): boolean {
  let node = target as HTMLElement | null;

  while (node && node !== document.body) {
    const tag = node.tagName;

    if ((tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement === node) {
      return true;
    }

    if (tag === 'VIDEO') return true;

    const role = node.getAttribute('role');
    if (role === 'dialog' || role === 'listbox') return true;

    const overflowX = window.getComputedStyle(node).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 4) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

export async function hydratePostInteractions(posts: Post[], currentUserId: string): Promise<Post[]> {
  if (!supabaseConfigured || posts.length === 0) return posts;

  const postIds = posts.map(post => post.id);
  const { data, error } = await supabase.rpc('get_post_interactions', { p_post_ids: postIds });
  if (error) {
    // فشل الـ RPC: نحسب جميع العدّادات مباشرة من الجداول
    // (تعليقات، إعادات نشر، مشاركات، إعجابات) حتى لا تبقى الأرقام صفرًا
    const [likesRes, commentsRes, repostsRes, sharesRes, feedbackRes] = await Promise.all([
      supabase.from('likes').select('post_id,user_id').in('post_id', postIds).limit(20000),
      supabase.from('comments').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('reposts').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_shares').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_feedback').select('post_id,feedback').eq('user_id', currentUserId).in('post_id', postIds),
    ]);

    const countByPostDirect = (rows: any[] | null): Map<string, number> => {
      const counts = new Map<string, number>();
      (rows || []).forEach(row => counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1));
      return counts;
    };

    const likeCounts = countByPostDirect(likesRes.data);
    const commentCounts = countByPostDirect(commentsRes.data);
    const repostCounts = countByPostDirect(repostsRes.data);
    const shareCounts = countByPostDirect(sharesRes.data);
    const likesRows = (likesRes.data || []) as Array<{ post_id: string; user_id: string }>;
    const feedbackByPost = new Map(((feedbackRes.data || []) as any[]).map(row => [row.post_id, row.feedback]));

    return posts.map(post => ({
      ...post,
      likes_count: likeCounts.get(post.id) ?? post.likes_count ?? 0,
      comments_count: commentCounts.get(post.id) ?? post.comments_count ?? 0,
      reposts_count: repostCounts.get(post.id) ?? post.reposts_count ?? 0,
      shares_count: shareCounts.get(post.id) ?? (post as any).shares_count ?? 0,
      liked_by_me: likesRows.some(l => l.post_id === post.id && l.user_id === currentUserId),
      reposted_by_me: Boolean(post.reposted_by_me),
      saved_by_me: Boolean(post.saved_by_me),
      feedback_by_me: (feedbackByPost.get(post.id) as Post['feedback_by_me']) || null,
    }));
  }
  const interactionRows = (data || []) as Array<{
    post_id: string;
    likes_count: number;
    comments_count: number;
    reposts_count: number;
    liked_by_me: boolean;
    reposted_by_me: boolean;
    saved_by_me: boolean;
    feedback_by_me: string | null;
  }>;
  const interactionByPost = new Map(interactionRows.map(row => [row.post_id, row]));

  return posts.map(post => {
    const interaction = interactionByPost.get(post.id);
    return {
      ...post,
      likes_count: Number(interaction?.likes_count || 0),
      comments_count: Number(interaction?.comments_count || 0),
      reposts_count: Number(interaction?.reposts_count || 0),
      liked_by_me: Boolean(interaction?.liked_by_me),
      reposted_by_me: Boolean(interaction?.reposted_by_me),
      saved_by_me: Boolean(interaction?.saved_by_me),
      feedback_by_me: (interaction?.feedback_by_me as Post['feedback_by_me']) || null,
    };
  });
}
