import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { useFeedVideoGestures } from '@/hooks/useFeedVideoGestures';
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
  restoreTime?: number;
  onExpand?: (currentTime: number) => void;
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
  restoreTime,
  onExpand,
}: PostVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const manuallyPausedRef = useRef(false);
  const modalPlaybackStateRef = useRef<{ wasPlaying: boolean; wasMuted: boolean; wasManuallyPaused: boolean } | null>(null);
  const timeRange = parseVideoTimeRange(src);
  const cropTransform = getVideoCropTransform(parseVideoCrop(src));
  const mediaSrc = stripVideoEditFragment(src);
  const gestureEnabled = feedVideo && Boolean(onExpand);
  const [videoMuted, setVideoMuted] = useState(feedVideo ? false : muted);
  const [currentTime, setCurrentTime] = useState(timeRange?.start ?? 0);
  const [videoDuration, setVideoDuration] = useState(0);
  const rangeStart = timeRange?.start ?? 0;
  const rangeEnd = timeRange
    ? Math.min(timeRange.end, videoDuration || timeRange.end)
    : videoDuration;
  const displayDuration = Math.max(0, rangeEnd - rangeStart);
  const safeCurrentTime = Math.min(rangeEnd, Math.max(rangeStart, currentTime));
  const displayCurrentTime = Math.max(0, safeCurrentTime - rangeStart);
  const progressPercent = displayDuration > 0 ? Math.min(100, (displayCurrentTime / displayDuration) * 100) : 0;

  const expandVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.volume = 1;
    setVideoMuted(false);
    onExpand?.(video.currentTime);
  };

  const {
    controlsVisible,
    revealControlsBriefly,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useFeedVideoGestures(videoRef, gestureEnabled, expandVideo, {
    allowVerticalScroll: feedVideo,
    capturePointer: !feedVideo,
  });

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video || typeof restoreTime !== 'number' || !Number.isFinite(restoreTime)) return;
    const range = parseVideoTimeRange(src);
    const start = range?.start ?? 0;
    const end = range
      ? Math.min(range.end, video.duration || range.end)
      : video.duration;
    const maxTime = Number.isFinite(end) && end > start ? Math.max(start, end - 0.05) : restoreTime;
    const nextTime = Math.min(maxTime, Math.max(start, restoreTime));
    video.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, [restoreTime, src]);

  useEffect(() => {
    if (!feedVideo) setVideoMuted(muted);
  }, [feedVideo, muted]);

  useEffect(() => {
    if (!feedVideo) return;
    const pauseForModal = () => {
      const video = videoRef.current;
      if (!video) return;
      if (!modalPlaybackStateRef.current) {
        modalPlaybackStateRef.current = {
          wasPlaying: !video.paused,
          wasMuted: video.muted,
          wasManuallyPaused: manuallyPausedRef.current,
        };
      }
      manuallyPausedRef.current = true;
      video.pause();
    };
    const resumeAfterModal = () => {
      const video = videoRef.current;
      const previousState = modalPlaybackStateRef.current;
      if (!video || !previousState) return;
      modalPlaybackStateRef.current = null;
      video.muted = previousState.wasMuted;
      setVideoMuted(previousState.wasMuted);
      manuallyPausedRef.current = previousState.wasManuallyPaused;
      if (previousState.wasPlaying) void video.play().catch(() => undefined);
    };
    window.addEventListener('aani:pause-feed-videos', pauseForModal);
    window.addEventListener('aani:resume-feed-videos', resumeAfterModal);
    if (hasOpenFeedDialog()) pauseForModal();
    return () => {
      window.removeEventListener('aani:pause-feed-videos', pauseForModal);
      window.removeEventListener('aani:resume-feed-videos', resumeAfterModal);
    };
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
    revealControlsBriefly();
  };

  return (
    <div
      className={showCustomControls ? 'relative h-full w-full' : undefined}
      style={feedVideo ? { touchAction: 'pan-y' } : undefined}
      onClick={showCustomControls && !gestureEnabled ? revealControlsBriefly : undefined}
      onPointerDown={gestureEnabled ? onPointerDown : undefined}
      onPointerMove={gestureEnabled ? onPointerMove : undefined}
      onPointerUp={gestureEnabled ? onPointerUp : undefined}
      onPointerCancel={gestureEnabled ? onPointerCancel : undefined}
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
        preload="auto"
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
        style={{ transform: cropTransform, transformOrigin: 'center', touchAction: feedVideo ? 'pan-y' : undefined }}
      />

      {showMuteToggle && (
        <button
          type="button"
          onClick={() => {
            revealControlsBriefly();
            const nextMuted = !videoMuted;
            setVideoMuted(nextMuted);
            if (videoRef.current) videoRef.current.muted = nextMuted;
          }}
          className="absolute bottom-3 left-3 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur transition hover:bg-black/80"
          aria-label={videoMuted ? 'تشغيل الصوت' : 'كتم الصوت'}
          aria-pressed={videoMuted}
        >
          {videoMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      )}

      {showCustomControls && controlsVisible && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-gradient-to-t from-black/90 via-black/45 to-transparent">
            <div className="absolute inset-x-3 bottom-2 flex items-center justify-between text-[11px] text-white/90">
              <span className="tabular-nums">{formatVideoTime(displayCurrentTime)}</span>
              <span className="tabular-nums">{formatVideoTime(displayDuration)}</span>
            </div>
          </div>
          <div className="feed-video-timeline absolute inset-x-0 bottom-0 z-30 h-[3px] bg-white/30" aria-label="شريط تقدم الفيديو">
            <div className="h-full bg-white" style={{ width: `${progressPercent}%` }} />
            <input
              type="range"
              min={rangeStart}
              max={rangeEnd > rangeStart ? rangeEnd : rangeStart + 0.1}
              step="0.1"
              value={safeCurrentTime}
              onPointerDown={revealControlsBriefly}
              onChange={event => {
                const nextTime = Number(event.currentTarget.value);
                setCurrentTime(nextTime);
                if (videoRef.current) videoRef.current.currentTime = nextTime;
              }}
              className="feed-video-timeline-input"
              aria-label="تقدم الفيديو"
              disabled={videoDuration <= 0}
            />
          </div>
        </>
      )}
    </div>
  );
}
