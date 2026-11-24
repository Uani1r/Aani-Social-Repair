// مشغّل فيديو داخل فقاعة المحادثة: غلاف وزر تشغيل أولاً، ولا تشغيل تلقائي.
//
// - عنصر <video> موجود دائماً بلا src وبلا autoPlay: لا يبدأ أي تنزيل قبل الضغط.
// - أول ضغطة: startChatVideoOnUserTap يُسند المصدر ثم ينادي play() داخل معالج
//   الضغط نفسه (شرط Safari)، لا في useEffect لاحق.
// - تشغيل واحد فقط: تشغيل مقطع يوقف السابق، ويُوقف عند مغادرة المكوّن أو إخفاء الصفحة.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';

import { SignedImage } from '@/components/SignedMedia';
import EmojiText from '@/components/TwemojiText';
import type { ChatVideoPayload } from '@/lib/chatVideo';
import {
  claimChatVideoPlayback,
  clampChatVideoSeek,
  formatChatVideoTime,
  isChatVideoFullscreenSupported,
  nextChatVideoMuteState,
  startChatVideoOnUserTap,
  toggleChatVideoPlayback,
} from '@/lib/chatVideoPlayback';
import { useMediaUrl } from '@/lib/mediaAccess';

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export default function ChatVideoMessage({
  messageId,
  payload,
  isMine,
  createdAt,
}: {
  messageId: string;
  payload: ChatVideoPayload;
  isMine: boolean;
  createdAt: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const releaseClaimRef = useRef<(() => void) | null>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [loadedMs, setLoadedMs] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  const src = useMediaUrl(payload.url);
  const poster = useMediaUrl(payload.posterUrl);
  const totalMs = loadedMs > 0 ? loadedMs : payload.durationMs;

  const stop = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) {
      try {
        video.pause();
      } catch {
        /* قد يكون العنصر أفلت مرجعه */
      }
    }
    setPlaying(false);
    setLoading(false);
  }, []);

  // حجز مشغّل واحد: مقطع جديد يوقف السابق، والتحرير عند المغادرة.
  const claim = useCallback(() => {
    if (!releaseClaimRef.current) releaseClaimRef.current = claimChatVideoPlayback(stop);
  }, [stop]);

  useEffect(() => () => {
    releaseClaimRef.current?.();
    releaseClaimRef.current = null;
    const video = videoRef.current;
    if (!video) return;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* قد يكون العنصر أفلت مرجعه بالفعل */
    }
  }, []);

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [stop]);

  const handlers = {
    onLoading: setLoading,
    onPlaying: setPlaying,
    onError: (error: unknown) => {
      setFailed(true);
      setLoading(false);
      console.warn('[messages] تعذر تشغيل فيديو المحادثة:', error);
    },
  };

  /** كل تشغيل يمر من هنا مباشرة (بلا useEffect): أول ضغطة تُسند المصدر ثم play(). */
  const onPressPlay = () => {
    if (!src) {
      setFailed(true);
      return;
    }
    claim();
    const video = videoRef.current;
    if (!video) {
      setFailed(true);
      return;
    }
    if (!started) {
      setStarted(true);
      void startChatVideoOnUserTap(video, src, handlers).then(result => {
        if (result === 'playing') setFailed(false);
      });
      return;
    }
    void toggleChatVideoPlayback(video, handlers, { reloadOnError: failed }).then(result => {
      if (result === 'playing') setFailed(false);
    });
  };

  const seek = (value: string) => {
    const next = clampChatVideoSeek(Number(value), totalMs);
    setCurrentMs(next);
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = next / 1000;
      } catch {
        /* قد تكون الميتاداتا غير جاهزة بعد */
      }
    }
  };

  const toggleMute = () => {
    const next = nextChatVideoMuteState({ muted, volume });
    setMuted(next.muted);
    setVolume(next.volume);
    const video = videoRef.current;
    if (video) {
      video.muted = next.muted;
      video.volume = next.volume;
    }
  };

  const requestFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (typeof video.requestFullscreen === 'function') void video.requestFullscreen();
      else (video as unknown as { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
    } catch {
      /* ملء الشاشة غير مدعوم على هذا الجهاز */
    }
  };

  const messageTime = formatMessageTime(createdAt);

  return (
    <div className={`messages-chat-video${isMine ? ' is-mine' : ' is-theirs'}`} dir="rtl">
      <div className="messages-chat-video-stage">
        <video
          ref={videoRef}
          className="messages-chat-video-element"
          poster={poster ?? undefined}
          playsInline
          preload="metadata"
          onClick={onPressPlay}
          onPlay={() => { setPlaying(true); setFailed(false); }}
          onPlaying={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onCanPlay={() => setLoading(false)}
          onPause={() => { setPlaying(false); setLoading(false); }}
          onTimeUpdate={event => setCurrentMs(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={event => {
            const duration = event.currentTarget.duration;
            if (Number.isFinite(duration) && duration > 0) setLoadedMs(duration * 1000);
            event.currentTarget.muted = muted;
            event.currentTarget.volume = volume;
          }}
          onEnded={() => { setPlaying(false); setLoading(false); setCurrentMs(0); }}
          onError={() => {
            setLoading(false);
            setPlaying(false);
            setFailed(true);
            console.warn('[messages] تعذر تحميل فيديو المحادثة.');
          }}
        />

        {!started && (
          <button
            type="button"
            className="messages-chat-video-cover"
            aria-label="تشغيل الفيديو"
            onClick={onPressPlay}
            disabled={!src}
          >
            {poster ? <SignedImage src={payload.posterUrl} alt="معاينة الفيديو" loading="lazy" /> : <span className="messages-chat-video-placeholder" />}
            <span className="messages-chat-video-play"><Play size={22} fill="currentColor" /></span>
            <span className="messages-chat-video-duration" dir="ltr">{formatChatVideoTime(payload.durationMs)}</span>
          </button>
        )}
      </div>

      <div className="messages-chat-video-controls" dir="ltr">
        <button
          type="button"
          className="messages-chat-video-button"
          aria-label={playing ? 'إيقاف مؤقت' : failed ? 'إعادة المحاولة' : 'تشغيل'}
          onClick={onPressPlay}
        >
          {loading ? <span className="messages-voice-spinner" aria-hidden="true" />
            : failed ? <RotateCcw size={16} />
              : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <input
          className="messages-chat-video-progress"
          type="range"
          min={0}
          max={Math.max(1, totalMs)}
          step={100}
          value={Math.min(currentMs, totalMs)}
          onChange={event => seek(event.target.value)}
          disabled={!started || !totalMs || failed}
          aria-label="موضع الفيديو"
        />
        <time className="messages-chat-video-time" dir="ltr">
          {formatChatVideoTime(currentMs)} / {formatChatVideoTime(totalMs)}
        </time>
        <button type="button" className="messages-chat-video-button" aria-label={muted ? 'إلغاء الكتم' : 'كتم الصوت'} onClick={toggleMute}>
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        {isChatVideoFullscreenSupported(videoRef.current) && (
          <button type="button" className="messages-chat-video-button" aria-label="ملء الشاشة" onClick={requestFullscreen}>
            <Maximize2 size={16} />
          </button>
        )}
      </div>

      {failed && (
        <span className="messages-chat-video-failed" role="alert">تعذر تشغيل الفيديو. اضغط إعادة المحاولة.</span>
      )}
      {payload.caption && (
        <div className={`messages-image-caption messages-bubble ${isMine ? 'is-mine' : 'is-theirs'}`}>
          <EmojiText text={payload.caption} />
        </div>
      )}
      {messageTime && (
        <span className="messages-chat-video-footer">
          <time dateTime={createdAt}>{messageTime}</time>
          <span className="sr-only">{messageId}</span>
        </span>
      )}
    </div>
  );
}
