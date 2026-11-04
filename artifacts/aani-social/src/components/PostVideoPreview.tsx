import { useRef, type SyntheticEvent } from 'react';

type PostVideoPreviewProps = {
  src: string;
  className?: string;
  controls?: boolean;
  muted?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
};

type TimeRange = { start: number; end: number } | null;

function getTimeRange(src: string): TimeRange {
  const match = src.match(/#t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

export default function PostVideoPreview({
  src,
  className = '',
  controls = true,
  muted = false,
  autoPlay = false,
  loop = false,
}: PostVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timeRange = getTimeRange(src);
  const mediaSrc = timeRange ? src.replace(/#t=[^#&]*/, '') : src;

  const seekToStart = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!timeRange) return;
    const end = Math.min(timeRange.end, video.duration || timeRange.end);
    video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
  };

  const enforceEnd = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!timeRange) return;
    const end = Math.min(timeRange.end, video.duration || timeRange.end);
    if (video.currentTime < end - 0.04) return;
    if (loop) {
      video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
    } else {
      video.currentTime = end;
      video.pause();
    }
  };

  return (
    <video
      ref={videoRef}
      src={mediaSrc}
      controls={controls}
      muted={muted}
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      onLoadedMetadata={seekToStart}
      onSeeking={event => {
        const video = event.currentTarget;
        if (!timeRange) return;
        const end = Math.min(timeRange.end, video.duration || timeRange.end);
        if (video.currentTime < timeRange.start || video.currentTime > end) {
          video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
        }
      }}
      onTimeUpdate={enforceEnd}
      onPlay={event => {
        const video = event.currentTarget;
        if (!timeRange) return;
        const end = Math.min(timeRange.end, video.duration || timeRange.end);
        if (video.currentTime >= end - 0.04) {
          video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
        }
      }}
      onEnded={event => {
        if (!loop) return;
        const video = event.currentTarget;
        if (timeRange) {
          const end = Math.min(timeRange.end, video.duration || timeRange.end);
          video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
        } else {
          video.currentTime = 0;
        }
        void video.play().catch(() => undefined);
      }}
      className={className}
    />
  );
}
