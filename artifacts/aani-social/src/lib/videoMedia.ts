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
  const aspectRatio = crop.aspectRatio === 'free' || crop.aspectRatio === '4:5' || crop.aspectRatio === '1:1' || crop.aspectRatio === '9:16'
    ? crop.aspectRatio
    : undefined;
  const sourceAspectRatio = Number.isFinite(crop.sourceAspectRatio) && crop.sourceAspectRatio! >= 0.2 && crop.sourceAspectRatio! <= 5
    ? crop.sourceAspectRatio
    : undefined;
  return {
    zoom: clamp(Number.isFinite(crop.zoom) ? crop.zoom : 1, 1, 3),
    x: clamp(Number.isFinite(crop.x) ? crop.x : 0, -1, 1),
    y: clamp(Number.isFinite(crop.y) ? crop.y : 0, -1, 1),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(sourceAspectRatio ? { sourceAspectRatio } : {}),
  };
}

export function parseVideoCrop(src: string): VideoCropTransform {
  const cropMatch = src.match(new RegExp(`[#&]crop=${numberPattern},${numberPattern},${numberPattern}(?=&|$)`));
  const aspectMatch = src.match(/[#&]ar=(free|4:5|1:1|9:16)(?=&|$)/);
  const sourceAspectMatch = src.match(new RegExp(`[#&]ratio=${numberPattern}(?=&|$)`));
  const [zoom, x, y] = cropMatch ? cropMatch.slice(1).map(Number) : [1, 0, 0];
  const sourceAspectRatio = sourceAspectMatch ? Number(sourceAspectMatch[1]) : undefined;
  if (![zoom, x, y].every(Number.isFinite) || (sourceAspectRatio !== undefined && !Number.isFinite(sourceAspectRatio))) {
    return DEFAULT_VIDEO_CROP;
  }
  return normalizeVideoCrop({
    zoom,
    x,
    y,
    ...(aspectMatch ? { aspectRatio: aspectMatch[1] as VideoCropTransform['aspectRatio'] } : {}),
    ...(sourceAspectRatio !== undefined ? { sourceAspectRatio } : {}),
  });
}

export function getVideoAspectRatio(crop: VideoCropTransform | null | undefined): number | undefined {
  const normalized = normalizeVideoCrop(crop);
  if (normalized.aspectRatio === 'free') return normalized.sourceAspectRatio;
  if (normalized.aspectRatio === '1:1') return 1;
  if (normalized.aspectRatio === '9:16') return 9 / 16;
  if (normalized.aspectRatio === '4:5') return 4 / 5;
  return undefined;
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
  if (normalizedCrop.aspectRatio) edits.push(`ar=${normalizedCrop.aspectRatio}`);
  if (normalizedCrop.aspectRatio === 'free' && normalizedCrop.sourceAspectRatio) {
    edits.push(`ratio=${normalizedCrop.sourceAspectRatio.toFixed(5)}`);
  }

  const baseUrl = stripVideoEditFragment(src);
  return edits.length > 0 ? `${baseUrl}#${edits.join('&')}` : baseUrl;
}

// ===== قوالب قص الصور القياسية (4:5 / 3:4 / 9:16) =====
export const IMAGE_ASPECT_OPTIONS = [
  { label: '4:5', value: 4 / 5, suffix: '4x5' },
  { label: '3:4', value: 3 / 4, suffix: '3x4' },
  { label: '9:16', value: 9 / 16, suffix: '9x16' },
] as const;

export type ImageAspectLabel = (typeof IMAGE_ASPECT_OPTIONS)[number]['label'];

export const DEFAULT_IMAGE_ASPECT_LABEL: ImageAspectLabel = '4:5';

export function imageAspectLabelFromFilename(filename: string): ImageAspectLabel | null {
  const match = filename.toLowerCase().match(/-(4x5|3x4|9x16)\.[a-z0-9]+$/);
  if (!match) return null;
  return match[1] === '4x5' ? '4:5' : match[1] === '3x4' ? '3:4' : '9:16';
}

// إلحاق نسبة القص المختارة بروابط الوسائط المحفوظة في قاعدة البيانات
export function appendImageMediaAspect(url: string, filename: string): string {
  const label = imageAspectLabelFromFilename(filename);
  if (!label || /[#&]ar=/.test(url)) return url;
  return `${url}#ar=${label}`;
}

// قراءة نسبة الأبعاد المخزنة مع رابط صورة المنشور عند العرض
export function getImageMediaAspectRatio(url: string): number | undefined {
  const match = url.match(/[#&]ar=(4:5|3:4|9:16)(?=&|$)/);
  if (!match) return undefined;
  if (match[1] === '3:4') return 3 / 4;
  if (match[1] === '9:16') return 9 / 16;
  return 4 / 5;
}
