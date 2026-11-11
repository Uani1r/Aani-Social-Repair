import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type SyntheticEvent } from 'react';

import { useFeedVideoGestures } from '@/hooks/useFeedVideoGestures';
import {
  isBackgroundMediaSuspended,
  playExclusive,
  releaseActiveVideo,
  subscribeBackgroundMediaSuspension,
} from '@/lib/activeVideo';
import { appendVideoTrimFragment, getVideoCropTransform, parseVideoCrop, parseVideoTimeRange, stripVideoEditFragment, type VideoTimeRange } from '@/lib/videoMedia';
import { isFeedVideoSelected, subscribeFeedVideoPool, updateFeedVideoCandidate } from '@/lib/feedVideoPool';
import { releaseVideoPreloadCandidate, setVideoPreloadCandidate } from '@/lib/mediaPreload';

type PostVideoPreviewProps = {
  src: string;
  className?: string;
  /** صورة الغلاف تظهر قبل تشغيل الفيديو (poster) */
  poster?: string;
  controls?: boolean;
  muted?: boolean;
  autoPlay?: boolean;
  autoPlayWhenVisible?: boolean;
  showCustomControls?: boolean;
  showMuteToggle?: boolean;
  feedVideo?: boolean;
  loop?: boolean;
  restoreTime?: number;
  /** معرّف فريد لهذا الفيديو — يُستخدم في مدير الفيديو النشط الموحد */
  videoId?: string;
  /** مسار صوت بديل للمنشور؛ عند وجوده يُكتم المسار الصوتي الأصلي للفيديو */
  replacementAudioSrc?: string | null;
  /** حدود قص بديلة من أعمدة المنشور (تُستخدم إن خلا العنوان من ترميز #t=) */
  trimRange?: VideoTimeRange | null;
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

let nextFeedVideoPoolId = 0;

export default function PostVideoPreview({
  src,
  className = '',
  poster,
  controls = true,
  muted = false,
  autoPlay = false,
  autoPlayWhenVisible = false,
  showCustomControls = false,
  showMuteToggle = false,
  feedVideo = false,
  loop = false,
  restoreTime,
  videoId,
  replacementAudioSrc,
  trimRange,
  onExpand,
}: PostVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replacementAudioRef = useRef<HTMLAudioElement>(null);
  const poolIdRef = useRef('');
  if (!poolIdRef.current) poolIdRef.current = `feed-video-pool-${++nextFeedVideoPoolId}`;
  const poolId = poolIdRef.current;
  const hasPoolLease = useSyncExternalStore(
    subscribeFeedVideoPool,
    () => isFeedVideoSelected(poolId),
    () => false,
  );
  const backgroundMediaSuspended = useSyncExternalStore(
    subscribeBackgroundMediaSuspension,
    isBackgroundMediaSuspended,
    () => false,
  );
  const manuallyPausedRef = useRef(false);
  const modalPlaybackStateRef = useRef<{ wasPlaying: boolean; wasMuted: boolean; wasManuallyPaused: boolean } | null>(null);
  // حدود القص: ترميز #t= في العنوان أولاً ثم عمودا المنشور trim_start/trim_end
  const timeRange = parseVideoTimeRange(src) ?? trimRange ?? null;
  const cropTransform = getVideoCropTransform(parseVideoCrop(src));
  const hasReplacementAudio = Boolean(replacementAudioSrc);
  const replacementAudioRange = replacementAudioSrc ? parseVideoTimeRange(replacementAudioSrc) : null;
  // تمرير المقطع للمتصفح بترميز HTML5 (#t=start,end) — يقيّد التشغيل للمقطع المختار
  const mediaSrc = timeRange
    ? appendVideoTrimFragment(src, timeRange)
    : stripVideoEditFragment(src);
  const gestureEnabled = feedVideo && Boolean(onExpand);
  const [videoMuted, setVideoMuted] = useState(feedVideo ? false : muted);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);
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

  const syncReplacementAudio = (video: HTMLVideoElement, restart = false, shouldPlay = false) => {
    if (!hasReplacementAudio) return;
    video.muted = true;
    video.volume = 0;
    const audio = replacementAudioRef.current;
    if (!audio) return;
    audio.muted = videoMuted;
    audio.volume = videoMuted ? 0 : 1;
    const targetTime = replacementAudioRange
      ? (restart || audio.currentTime < replacementAudioRange.start || audio.currentTime >= replacementAudioRange.end
        ? replacementAudioRange.start
        : audio.currentTime)
      : Math.max(0, video.currentTime - rangeStart);
    if (restart || Math.abs(audio.currentTime - targetTime) > 0.5) {
      try { audio.currentTime = targetTime; } catch { /* the audio may not be ready to seek yet */ }
    }
    if (shouldPlay && !backgroundMediaSuspended) void playBackgroundMedia(audio);
  };

  const expandVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = hasReplacementAudio;
    video.volume = hasReplacementAudio ? 0 : 1;
    setVideoMuted(hasReplacementAudio ? videoMuted : false);
    if (hasReplacementAudio) replacementAudioRef.current?.pause();
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
  }, [hasPoolLease, restoreTime, src]);

  useEffect(() => {
    if (!feedVideo) setVideoMuted(muted);
  }, [feedVideo, muted]);

  useEffect(() => {
    setHasVideoFrame(false);
  }, [backgroundMediaSuspended, hasPoolLease, mediaSrc]);

  useEffect(() => {
    if (!feedVideo || backgroundMediaSuspended) {
      updateFeedVideoCandidate(poolId, null);
      releaseVideoPreloadCandidate(poolId);
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    let isNearViewport = false;
    let frame: number | null = null;
    const updateCandidate = () => {
      frame = null;
      if (!isNearViewport) {
        updateFeedVideoCandidate(poolId, null);
        releaseVideoPreloadCandidate(poolId);
        return;
      }
      const rect = container.getBoundingClientRect();
      const height = Math.max(1, rect.height);
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const visibleRatio = visibleHeight / height;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - window.innerHeight / 2);
      const priority: 0 | 1 = visibleRatio >= 0.6 ? 0 : 1;
      updateFeedVideoCandidate(poolId, { priority, distance });
      setVideoPreloadCandidate(poolId, mediaSrc, priority, distance);
    };
    const scheduleCandidateUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateCandidate);
    };
    const observer = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(entries => {
          isNearViewport = Boolean(entries[0]?.isIntersecting);
          scheduleCandidateUpdate();
        }, { rootMargin: '100% 0px 100% 0px', threshold: 0 });

    if (observer) observer.observe(container);
    else {
      isNearViewport = true;
      scheduleCandidateUpdate();
    }
    window.addEventListener('scroll', scheduleCandidateUpdate, true);
    window.addEventListener('resize', scheduleCandidateUpdate);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', scheduleCandidateUpdate, true);
      window.removeEventListener('resize', scheduleCandidateUpdate);
      if (frame !== null) window.cancelAnimationFrame(frame);
      updateFeedVideoCandidate(poolId, null);
      releaseVideoPreloadCandidate(poolId);
    };
  }, [backgroundMediaSuspended, feedVideo, mediaSrc, poolId]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    if (!video) return;
    if (hasReplacementAudio) {
      video.muted = true;
      video.volume = 0;
      if (!video.paused) syncReplacementAudio(video, false, true);
    } else {
      video.muted = showMuteToggle ? videoMuted : muted;
      video.volume = video.muted ? 0 : 1;
      audio?.pause();
    }
  }, [backgroundMediaSuspended, hasPoolLease, hasReplacementAudio, muted, replacementAudioSrc, showMuteToggle, videoMuted]);

  useEffect(() => {
    if (!feedVideo || !hasPoolLease) return;
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    if (!video) return;
    return () => {
      video.pause();
      audio?.pause();
      try {
        video.src = '';
        video.load();
        if (audio) {
          audio.src = '';
          audio.load();
        }
      } catch { /* detached media can reject */ }
      if (videoId) releaseActiveVideo(videoId);
    };
  }, [feedVideo, hasPoolLease, videoId]);

  useEffect(() => {
    if (!feedVideo) return;
    const pauseForModal = () => {
      const video = videoRef.current;
      if (!video) return;
      if (!modalPlaybackStateRef.current) {
        modalPlaybackStateRef.current = {
          wasPlaying: !video.paused,
          wasMuted: hasReplacementAudio ? videoMuted : video.muted,
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
      video.muted = hasReplacementAudio || previousState.wasMuted;
      video.volume = video.muted ? 0 : 1;
      setVideoMuted(previousState.wasMuted);
      manuallyPausedRef.current = previousState.wasManuallyPaused;
      if (previousState.wasPlaying && !isBackgroundMediaSuspended()) playExclusive(videoId, video);
    };
    window.addEventListener('aani:pause-feed-videos', pauseForModal);
    window.addEventListener('aani:resume-feed-videos', resumeAfterModal);
    if (hasOpenFeedDialog()) pauseForModal();
    return () => {
      window.removeEventListener('aani:pause-feed-videos', pauseForModal);
      window.removeEventListener('aani:resume-feed-videos', resumeAfterModal);
    };
  }, [feedVideo, hasReplacementAudio, videoId, videoMuted]);

  useEffect(() => {
    if (!autoPlayWhenVisible || (feedVideo && !hasPoolLease)) return;
    const video = videoRef.current;
    if (!video) return;

    if (typeof IntersectionObserver === 'undefined') {
      if (!manuallyPausedRef.current && !hasOpenFeedDialog()) playExclusive(videoId, video);
      return () => video.pause();
    }

    // مراقبة الظهور: لا تشغيل إلا عند ظهور 60% على الأقل،
    // وخروجه من الظهور يوقف الفيديو فوراً (توقف الصوت معه)
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        if (!manuallyPausedRef.current && !hasOpenFeedDialog()) playExclusive(videoId, video);
      } else {
        video.pause();
        if (videoId) releaseActiveVideo(videoId);
        if (!hasOpenFeedDialog()) manuallyPausedRef.current = false;
      }
    }, { threshold: [0, 0.6] });

    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
      if (videoId) releaseActiveVideo(videoId);
    };
  }, [autoPlayWhenVisible, backgroundMediaSuspended, feedVideo, hasPoolLease, mediaSrc, videoId]);

  // تنظيف نهائي عند إزالة المكوّن: إيقاف صريح وتفريغ المصدر
  // — Safari/WebKit قد يواصل تشغيل صوت عنصر منزوع من الشجرة إن بقي مرجعاً
  useEffect(() => () => {
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    audio?.pause();
    try {
      if (audio) {
        audio.src = '';
        audio.load();
      }
      if (!video) return;
      video.pause();
      video.src = '';
      video.load();
    } catch {
      /* العنصر قد يكون أفلت مرجعه بالفعل */
    }
  }, []);

  const seekToStart = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    video.muted = hasReplacementAudio || (showMuteToggle ? videoMuted : muted);
    video.volume = video.muted ? 0 : 1;
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
  const hasVideoPlayer = !feedVideo || (hasPoolLease && !backgroundMediaSuspended);

  return (
    <div
      ref={containerRef}
      className={showCustomControls || feedVideo ? 'relative h-full w-full' : undefined}
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
      {poster && (feedVideo || showCustomControls) && (
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 z-[1] h-full w-full object-cover transition-opacity duration-200"
          style={{ filter: 'blur(18px)', transform: 'scale(1.06)', opacity: hasVideoFrame ? 0 : 1 }}
        />
      )}
      {hasVideoPlayer ? (
        <video
          ref={videoRef}
          src={feedVideo && backgroundMediaSuspended ? undefined : mediaSrc}
          data-aani-background-media={feedVideo ? '' : undefined}
          data-aani-video-id={feedVideo ? videoId : undefined}
          poster={poster || undefined}
          controls={!showCustomControls && controls}
          muted={hasReplacementAudio || (showMuteToggle ? videoMuted : muted)}
          autoPlay={autoPlay && !autoPlayWhenVisible && !backgroundMediaSuspended}
          playsInline
          preload={feedVideo ? 'none' : 'auto'}
          onLoadedMetadata={seekToStart}
          onLoadedData={() => setHasVideoFrame(true)}
          onSeeking={event => {
            const video = event.currentTarget;
            if (timeRange) {
              const end = Math.min(timeRange.end, video.duration || timeRange.end);
              if (video.currentTime < timeRange.start || video.currentTime > end) {
                video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
              }
            }
            if (hasReplacementAudio) syncReplacementAudio(video, true);
          }}
          onVolumeChange={event => {
            if (!hasReplacementAudio) return;
            const video = event.currentTarget;
            video.muted = true;
            video.volume = 0;
          }}
          onTimeUpdate={event => {
            enforceEnd(event);
            const video = event.currentTarget;
            const audio = replacementAudioRef.current;
            if (hasReplacementAudio && audio && !audio.paused && !replacementAudioRange) {
              syncReplacementAudio(video);
            }
          }}
          onPlay={event => {
            const video = event.currentTarget;
            if (hasReplacementAudio) syncReplacementAudio(video, true, true);
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
          onPause={() => replacementAudioRef.current?.pause()}
          onEnded={event => {
            if (!loop) return;
            const video = event.currentTarget;
            if (timeRange) {
              const end = Math.min(timeRange.end, video.duration || timeRange.end);
              video.currentTime = Math.min(timeRange.start, Math.max(0, end - 0.05));
            } else {
              video.currentTime = 0;
            }
            playExclusive(videoId, video);
          }}
          className={className}
          style={{
            transform: cropTransform,
            transformOrigin: 'center',
            touchAction: feedVideo ? 'pan-y' : undefined,
            position: poster && (feedVideo || showCustomControls) ? 'relative' : undefined,
            zIndex: poster && (feedVideo || showCustomControls) ? 0 : undefined,
          }}
        />
      ) : (
        <div
          className={className}
          aria-hidden="true"
          style={{ backgroundColor: '#101014', backgroundImage: poster ? `url("${poster}")` : undefined, backgroundPosition: 'center', backgroundSize: 'cover' }}
        />
      )}
      {hasReplacementAudio && hasVideoPlayer && (
        <audio
          ref={replacementAudioRef}
          src={backgroundMediaSuspended ? undefined : replacementAudioSrc || undefined}
          data-aani-background-media=""
          loop={!replacementAudioRange}
          preload="none"
          aria-hidden="true"
          className="hidden"
          onTimeUpdate={event => {
            const audio = event.currentTarget;
            if (!replacementAudioRange || audio.currentTime < replacementAudioRange.end - 0.04) return;
            try { audio.currentTime = replacementAudioRange.start; } catch { /* wait for metadata */ }
          }}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (video && !video.paused) syncReplacementAudio(video, true, true);
          }}
        />
      )}

      {showMuteToggle && (
        <button
          type="button"
          onClick={() => {
            revealControlsBriefly();
            const nextMuted = !videoMuted;
            setVideoMuted(nextMuted);
            if (hasReplacementAudio) {
              const audio = replacementAudioRef.current;
              if (audio) {
                audio.muted = nextMuted;
                audio.volume = nextMuted ? 0 : 1;
              }
              if (videoRef.current) {
                videoRef.current.muted = true;
                videoRef.current.volume = 0;
              }
            } else if (videoRef.current) {
              videoRef.current.muted = nextMuted;
              videoRef.current.volume = nextMuted ? 0 : 1;
            }
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
