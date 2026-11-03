import type { Profile } from './types';

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
  liked_at?: string | null;
  is_viewer?: boolean;
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

