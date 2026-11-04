import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment } from '@/lib/videoMedia';

type PostVideoPreviewProps = {
  src: string;
  className?: string;
  controls?: boolean;
  muted?: boolean;
  autoPlay?: boolean;
  autoPlayWhenVisible?: boolean;
  showCustomControls?: boolean;
  showMuteToggle?: boolean;
  feedVideo?: boolean;
  loop?: boolean;
};

const formatVideoTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const hasOpenFeedDialog = () => typeof document !== 'undefined' && Boolean(document.querySelector(
  '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
));

export default function PostVideoPreview({
  src,
  className = '',
  controls = true,
  muted = false,
  autoPlay = false,
  autoPlayWhenVisible = false,
  showCustomControls = false,
  showMuteToggle = false,
  feedVideo = false,
  loop = false,
}: PostVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const manuallyPausedRef = useRef(false);
  const timeRange = parseVideoTimeRange(src);
  const cropTransform = getVideoCropTransform(parseVideoCrop(src));
  const mediaSrc = stripVideoEditFragment(src);
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [videoMuted, setVideoMuted] = useState(muted);
  const [currentTime, setCurrentTime] = useState(timeRange?.start ?? 0);
  const [videoDuration, setVideoDuration] = useState(0);
  const rangeStart = timeRange?.start ?? 0;
  const rangeEnd = timeRange
    ? Math.min(timeRange.end, videoDuration || timeRange.end)
    : videoDuration;
  const displayDuration = Math.max(0, rangeEnd - rangeStart);
  const safeCurrentTime = Math.min(rangeEnd, Math.max(rangeStart, currentTime));
  const displayCurrentTime = Math.max(0, safeCurrentTime - rangeStart);

  useEffect(() => {
    setVideoMuted(muted);
  }, [muted]);

  useEffect(() => {
    if (!feedVideo) return;
    const pauseAndMute = () => {
      const video = videoRef.current;
      if (!video) return;
      manuallyPausedRef.current = true;
      video.muted = true;
      setVideoMuted(true);
      video.pause();
    };
    window.addEventListener('aani:pause-feed-videos', pauseAndMute);
    if (hasOpenFeedDialog()) pauseAndMute();
    return () => window.removeEventListener('aani:pause-feed-videos', pauseAndMute);
  }, [feedVideo]);

  useEffect(() => {
    if (!autoPlayWhenVisible) return;
    const video = videoRef.current;
    if (!video) return;

    if (typeof IntersectionObserver === 'undefined') {
      if (!manuallyPausedRef.current && !hasOpenFeedDialog()) void video.play().catch(() => undefined);
      return () => video.pause();
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
        if (!manuallyPausedRef.current && !hasOpenFeedDialog()) void video.play().catch(() => undefined);
      } else {
        video.pause();
        if (!hasOpenFeedDialog()) manuallyPausedRef.current = false;
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

  const seekToStart = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    setVideoDuration(duration);
    if (!timeRange) {
      setCurrentTime(video.currentTime);
      return;
    }
    const end = Math.min(timeRange.end, duration || timeRange.end);
    const start = Math.min(timeRange.start, Math.max(0, end - 0.05));
    video.currentTime = start;
    setCurrentTime(start);
  };

  const enforceEnd = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setCurrentTime(video.currentTime);
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

  const handleControlsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!showCustomControls || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    setControlsVisible(visible => !visible);
  };

  return (
    <div
      className={showCustomControls ? 'relative h-full w-full' : undefined}
      onClick={showCustomControls ? () => setControlsVisible(visible => !visible) : undefined}
      onKeyDown={showCustomControls ? handleControlsKeyDown : undefined}
      role={showCustomControls ? 'group' : undefined}
      tabIndex={showCustomControls ? 0 : undefined}
      aria-label={showCustomControls ? 'الفيديو وعناصر التحكم' : undefined}
    >
      <video
        ref={videoRef}
        src={mediaSrc}
        controls={!showCustomControls && controls}
        muted={showMuteToggle ? videoMuted : muted}
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
        onDurationChange={event => {
          const duration = event.currentTarget.duration;
          setVideoDuration(Number.isFinite(duration) ? duration : 0);
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
        style={{ transform: cropTransform, transformOrigin: 'center' }}
      />

      {showMuteToggle && (
        <button
          type="button"
          onClick={() => {
            const nextMuted = !videoMuted;
            setVideoMuted(nextMuted);
            if (videoRef.current) videoRef.current.muted = nextMuted;
          }}
          className="absolute left-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur transition hover:bg-black/80"
          aria-label={videoMuted ? 'تشغيل الصوت' : 'كتم الصوت'}
          aria-pressed={videoMuted}
        >
          {videoMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      )}

      {showCustomControls && controlsVisible && (
        <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-3 pt-7">
          <button
            type="button"
            onClick={togglePlayback}
            className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
            aria-label={isPlaying ? 'إيقاف الفيديو' : 'تشغيل الفيديو'}
          >
            {isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
          </button>
          <div className="flex items-center gap-2 text-[11px] text-white">
            <span className="min-w-8 text-center tabular-nums">{formatVideoTime(displayCurrentTime)}</span>
            <input
              type="range"
              min={rangeStart}
              max={rangeEnd > rangeStart ? rangeEnd : rangeStart + 0.1}
              step="0.1"
              value={safeCurrentTime}
              onChange={event => {
                const nextTime = Number(event.currentTarget.value);
                setCurrentTime(nextTime);
                if (videoRef.current) videoRef.current.currentTime = nextTime;
              }}
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[#f1a17f]"
              aria-label="تقدم الفيديو"
              disabled={videoDuration <= 0}
            />
            <span className="min-w-8 text-center tabular-nums">{formatVideoTime(displayDuration)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
