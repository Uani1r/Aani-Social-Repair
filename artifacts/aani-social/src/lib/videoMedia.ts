import type { VideoCropTransform, VideoTrimRange } from '@/lib/types';

export type VideoTimeRange = Pick<VideoTrimRange, 'start' | 'end'>;

export const DEFAULT_VIDEO_CROP: VideoCropTransform = { zoom: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const numberPattern = '(-?(?:\\d+\\.?\\d*|\\.\\d+))';

export function parseVideoTimeRange(src: string): VideoTimeRange | null {
  const match = src.match(new RegExp(`[#&]t=${numberPattern},${numberPattern}(?=&|$)`));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start ? { start, end } : null;
}

export function normalizeVideoCrop(crop: VideoCropTransform | null | undefined): VideoCropTransform {
  if (!crop) return DEFAULT_VIDEO_CROP;
  return {
    zoom: clamp(Number.isFinite(crop.zoom) ? crop.zoom : 1, 1, 3),
    x: clamp(Number.isFinite(crop.x) ? crop.x : 0, -1, 1),
    y: clamp(Number.isFinite(crop.y) ? crop.y : 0, -1, 1),
  };
}

export function parseVideoCrop(src: string): VideoCropTransform {
  const match = src.match(new RegExp(`[#&]crop=${numberPattern},${numberPattern},${numberPattern}(?=&|$)`));
  if (!match) return DEFAULT_VIDEO_CROP;
  const [zoom, x, y] = match.slice(1).map(Number);
  if (![zoom, x, y].every(Number.isFinite)) return DEFAULT_VIDEO_CROP;
  return normalizeVideoCrop({ zoom, x, y });
}

export function stripVideoEditFragment(src: string): string {
  return src.replace(/#.*$/, '');
}

export function getVideoCropTransform(crop: VideoCropTransform | null | undefined): string | undefined {
  const normalized = normalizeVideoCrop(crop);
  if (normalized.zoom <= 1.001) return undefined;
  const x = normalized.x * (normalized.zoom - 1) * 50;
  const y = normalized.y * (normalized.zoom - 1) * 50;
  return `translate(${x.toFixed(3)}%, ${y.toFixed(3)}%) scale(${normalized.zoom})`;
}

export function buildVideoMediaUrl(
  src: string,
  range: VideoTrimRange | null,
  crop: VideoCropTransform | null,
): string {
  const edits: string[] = [];
  if (range && (range.start > 0.01 || range.end < range.duration - 0.05)) {
    edits.push(`t=${range.start.toFixed(2)},${range.end.toFixed(2)}`);
  }

  const normalizedCrop = normalizeVideoCrop(crop);
  if (normalizedCrop.zoom > 1.001 || Math.abs(normalizedCrop.x) > 0.01 || Math.abs(normalizedCrop.y) > 0.01) {
    edits.push(`crop=${normalizedCrop.zoom.toFixed(3)},${normalizedCrop.x.toFixed(3)},${normalizedCrop.y.toFixed(3)}`);
  }

  const baseUrl = stripVideoEditFragment(src);
  return edits.length > 0 ? `${baseUrl}#${edits.join('&')}` : baseUrl;
}
