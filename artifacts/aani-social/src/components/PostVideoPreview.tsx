import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment } from '@/lib/videoMedia';

type PostVideoPreviewProps = {
  src: string;
  className?: string;
  controls?: boolean;
  muted?: boolean;
  autoPlay?: boolean;
  autoPlayWhenVisible?: boolean;
  tapToToggle?: boolean;
  loop?: boolean;
};

export default function PostVideoPreview({
  src,
  className = '',
  controls = true,
  muted = false,
  autoPlay = false,
  autoPlayWhenVisible = false,
  tapToToggle = false,
  loop = false,
}: PostVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const manuallyPausedRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const timeRange = parseVideoTimeRange(src);
  const cropTransform = getVideoCropTransform(parseVideoCrop(src));
  const mediaSrc = stripVideoEditFragment(src);

  useEffect(() => {
    if (!autoPlayWhenVisible) return;
    const video = videoRef.current;
    if (!video) return;

    if (typeof IntersectionObserver === 'undefined') {
      void video.play().catch(() => undefined);
      return () => video.pause();
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
        if (!manuallyPausedRef.current) void video.play().catch(() => undefined);
      } else {
        video.pause();
        manuallyPausedRef.current = false;
      }
    }, { threshold: [0, 0.45] });

    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, [autoPlayWhenVisible, mediaSrc]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      manuallyPausedRef.current = false;
      void video.play().catch(() => undefined);
    } else {
      manuallyPausedRef.current = true;
      video.pause();
    }
  };

  const handlePlaybackKeyDown = (event: KeyboardEvent<HTMLVideoElement>) => {
    if (!tapToToggle || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    togglePlayback();
  };

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
      muted={muted || autoPlayWhenVisible}
      autoPlay={autoPlay && !autoPlayWhenVisible}
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
        setIsPlaying(true);
        const video = event.currentTarget;
        if (!timeRange) return;
        const end = Math.min(timeRange.end, video.duration || timeRange.end);
        if (video.currentTime >= end - 0.04) {
          video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
        }
      }}
      onPause={() => setIsPlaying(false)}
      onClick={tapToToggle ? togglePlayback : undefined}
      onKeyDown={tapToToggle ? handlePlaybackKeyDown : undefined}
      role={tapToToggle ? 'button' : undefined}
      tabIndex={tapToToggle ? 0 : undefined}
      aria-label={tapToToggle ? (isPlaying ? 'إيقاف الفيديو' : 'تشغيل الفيديو') : undefined}
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
      style={{ transform: cropTransform, transformOrigin: 'center' }}
    />
  );
}
