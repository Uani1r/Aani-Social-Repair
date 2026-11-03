import type { StoryDrawPoint, StoryDrawStroke } from '@/lib/appShared';
import type { StoryTextAlign, StoryTextAnimation } from '@/lib/storyFonts';
import type { Profile } from '@/lib/types';

export type StoryAuthor = Partial<Profile> & Pick<Profile, 'id'>;

export interface StoryTextOverlay {
  id: string;
  type?: 'text';
  text: string;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  fontFamily?: string;
  textColor?: string;
  textAlign?: StoryTextAlign;
  textBackground?: string;
  textAnimation?: StoryTextAnimation;
  scale?: number;
  rotation?: number;
}

export interface StoryDrawingOverlay {
  id: string;
  type: 'drawing';
  startTime: number;
  endTime: number;
  strokes: StoryDrawStroke[];
}

export const STORY_STICKER_SHAPES = ['square', 'circle', 'rectangle', 'triangle', 'heart', 'star', 'diamond', 'hexagon'] as const;
export type StoryStickerShape = typeof STORY_STICKER_SHAPES[number];

export interface StoryImageOverlay {
  id: string;
  type: 'image';
  src: string;
  shape: StoryStickerShape;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  cropX: number;
  cropY: number;
  cropScale: number;
  localFile?: File;
}

export type StoryImageStickerUpdate = Partial<Pick<
  StoryImageOverlay,
  'shape' | 'x' | 'y' | 'scale' | 'rotation' | 'cropX' | 'cropY' | 'cropScale'
>>;

export interface StoryCanvasStyle {
  background: string;
  textBackground: string;
  textColor: string;
  fontFamily: string;
  textAlign: StoryTextAlign;
  textAnimation: StoryTextAnimation;
}

export interface StoryCanvasStyleOverlay extends StoryCanvasStyle {
  id: string;
  type: 'canvas-style';
  startTime: number;
  endTime: number;
}

export type StoryTimedText = StoryTextOverlay | StoryDrawingOverlay | StoryImageOverlay | StoryCanvasStyleOverlay;

export interface StoryRow {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
  is_close_friends: boolean;
  duration_seconds: number;
  timed_texts: StoryTimedText[];
  created_at: string;
  expires_at: string | null;
  filter_key: string | null;
  original_story_id: string | null;
  share_type?: string;
  author: StoryAuthor | null;
}

export type StoriesByUser = Record<string, StoryRow[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isStoryDrawPoint(value: unknown): value is StoryDrawPoint {
  return isRecord(value)
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y);
}

function isStoryDrawStroke(value: unknown): value is StoryDrawStroke {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.color === 'string'
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && Array.isArray(value.points)
    && (value.points as unknown[]).every(isStoryDrawPoint);
}

function isSafeStoryBackground(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^#[0-9a-f]{3,8}$/i.test(value) || value === 'transparent') return true;
  if (/^rgba?\(\s*[\d.%\s,]+\)$/i.test(value)) return true;
  return /^linear-gradient\([\w\s#.,%()-]+\)$/i.test(value)
    && !/(url|var|expression)/i.test(value);
}

function isSafeStoryImageSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return value.startsWith('/') && !value.startsWith('//') && !value.includes('..');
  }
}

const STORY_TEXT_ANIMATIONS: StoryTextAnimation[] = [
  'none', 'typewriter', 'pop', 'slide-up', 'slide-down', 'slide-right', 'slide-left', 'bounce', 'glow',
];

function isStoryTimedText(value: unknown): value is StoryTimedText {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.startTime !== 'number'
    || !Number.isFinite(value.startTime)
    || typeof value.endTime !== 'number'
    || !Number.isFinite(value.endTime)) {
    return false;
  }

  if (value.type === 'canvas-style') {
    return isSafeStoryBackground(value.background)
      && isSafeStoryBackground(value.textBackground)
      && typeof value.textColor === 'string'
      && /^#[0-9a-f]{3,8}$/i.test(value.textColor)
      && typeof value.fontFamily === 'string'
      && value.fontFamily.length <= 120
      && (value.textAlign === 'left' || value.textAlign === 'center' || value.textAlign === 'right')
      && STORY_TEXT_ANIMATIONS.includes(value.textAnimation as StoryTextAnimation);
  }

  if (value.type === 'drawing') {
    return Array.isArray(value.strokes)
      && (value.strokes as unknown[]).every(isStoryDrawStroke);
  }

  if (value.type === 'image') {
    return isSafeStoryImageSource(value.src)
      && STORY_STICKER_SHAPES.includes(value.shape as StoryStickerShape)
      && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= 100
      && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= 100
      && typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale >= 0.3 && value.scale <= 5
      && typeof value.rotation === 'number' && Number.isFinite(value.rotation) && Math.abs(value.rotation) <= 3600
      && typeof value.cropX === 'number' && Number.isFinite(value.cropX) && Math.abs(value.cropX) <= 150
      && typeof value.cropY === 'number' && Number.isFinite(value.cropY) && Math.abs(value.cropY) <= 150
      && typeof value.cropScale === 'number' && Number.isFinite(value.cropScale) && value.cropScale >= 1 && value.cropScale <= 4;
  }

  const validOptionalTextStyle = (key: string, validate: (candidate: unknown) => boolean) =>
    value[key] === undefined || validate(value[key]);

  return (value.type === undefined || value.type === 'text')
    && typeof value.text === 'string'
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && validOptionalTextStyle('fontFamily', candidate => typeof candidate === 'string' && candidate.length <= 120 && !/(url|expression)/i.test(candidate))
    && validOptionalTextStyle('textColor', candidate => typeof candidate === 'string' && /^#[0-9a-f]{3,8}$/i.test(candidate))
    && validOptionalTextStyle('textAlign', candidate => candidate === 'left' || candidate === 'center' || candidate === 'right')
    && validOptionalTextStyle('textBackground', isSafeStoryBackground)
    && validOptionalTextStyle('textAnimation', candidate => STORY_TEXT_ANIMATIONS.includes(candidate as StoryTextAnimation))
    && validOptionalTextStyle('scale', candidate => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0.3 && candidate <= 5)
    && validOptionalTextStyle('rotation', candidate => typeof candidate === 'number' && Number.isFinite(candidate) && Math.abs(candidate) <= 3600);
}

export function normalizeStoryAuthor(value: unknown): StoryAuthor | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;

  return {
    id: value.id,
    ...(typeof value.username === 'string' ? { username: value.username } : {}),
    ...(typeof value.full_name === 'string' ? { full_name: value.full_name } : {}),
    ...(typeof value.display_name === 'string' || value.display_name === null
      ? { display_name: value.display_name }
      : {}),
    ...(typeof value.avatar_url === 'string' || value.avatar_url === null
      ? { avatar_url: value.avatar_url }
      : {}),
    ...(typeof value.bio === 'string' ? { bio: value.bio } : {}),
    ...(typeof value.is_private === 'boolean' ? { is_private: value.is_private } : {}),
  };
}

export function normalizeStoryRow(value: unknown): StoryRow | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.user_id !== 'string'
    || typeof value.media_type !== 'string'
    || typeof value.created_at !== 'string') {
    return null;
  }

  const duration = typeof value.duration_seconds === 'number' && Number.isFinite(value.duration_seconds)
    ? value.duration_seconds
    : 60;
  const timedTexts = Array.isArray(value.timed_texts)
    ? (value.timed_texts as unknown[]).filter(isStoryTimedText)
    : [];

  return {
    id: value.id,
    user_id: value.user_id,
    media_url: optionalString(value.media_url),
    media_type: value.media_type,
    caption: optionalString(value.caption),
    is_close_friends: value.is_close_friends === true,
    duration_seconds: duration,
    timed_texts: timedTexts,
    created_at: value.created_at,
    expires_at: optionalString(value.expires_at),
    filter_key: optionalString(value.filter_key),
    original_story_id: optionalString(value.original_story_id),
    ...(typeof value.share_type === 'string' ? { share_type: value.share_type } : {}),
    author: null,
  };
}
