import { displayName } from './types';
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

export function storyViewerDisplayName(profile: StoryViewerProfile | null): string {
  return displayName(profile);
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
export type StoryDrawTool = 'smooth' | 'arrow' | 'highlighter' | 'neon' | 'eraser';
export type StoryDrawStroke = {
  id: string;
  color: string;
  size: number;
  points: StoryDrawPoint[];
  tool?: StoryDrawTool;
};

export function drawStoryStroke(
  context: CanvasRenderingContext2D,
  stroke: StoryDrawStroke,
  width: number,
  height: number,
): void {
  const points = stroke.points.map(point => ({ x: point.x * width, y: point.y * height }));
  if (!points.length) return;

  const tool = stroke.tool || 'smooth';
  const lineWidth = Math.max(1, stroke.size * (tool === 'highlighter' ? 2.8 : tool === 'eraser' ? 2.5 : 1));
  context.save();
  context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  context.globalAlpha = tool === 'highlighter' ? 0.34 : 1;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.shadowColor = tool === 'neon' ? stroke.color : 'transparent';
  context.shadowBlur = tool === 'neon' ? stroke.size * 2.5 : 0;

  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, Math.max(1, lineWidth / 2), 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (next) {
      context.quadraticCurveTo(
        current.x,
        current.y,
        (current.x + next.x) / 2,
        (current.y + next.y) / 2,
      );
    } else {
      context.lineTo(current.x, current.y);
    }
  }
  context.stroke();

  if (tool === 'arrow') {
    const tip = points[points.length - 1];
    const tail = points[points.length - 2];
    const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
    const arrowSize = Math.max(12, stroke.size * 3.5);
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(tip.x - arrowSize * Math.cos(angle - Math.PI / 6), tip.y - arrowSize * Math.sin(angle - Math.PI / 6));
    context.lineTo(tip.x - arrowSize * Math.cos(angle + Math.PI / 6), tip.y - arrowSize * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  context.restore();
}

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
  onProfileUpdate: (next: Profile) => void;
  onOpenNotifications: () => void;
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
  content_kind?: string | null;
  metadata?: Record<string, unknown> | null;
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

