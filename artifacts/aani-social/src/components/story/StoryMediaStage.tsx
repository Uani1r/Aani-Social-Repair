import { useEffect, useRef } from 'react';

import { drawStoryStroke, type StoryDrawStroke } from '@/lib/appShared';
import StoryImageSticker from '@/components/StoryImageSticker';
import type { StoryCanvasStyleOverlay, StoryImageOverlay, StoryMediaTransformOverlay, StoryTextOverlay } from '@/components/stories/types';
import type { StoryViewerProps } from './types';

type StoryMediaStageProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'currentStoryFilter'
  | 'currentStoryFilterOverlay'
  | 'storyVideoRef'
  | 'currentTimeSec'
  | 'isStoryOwner'
  | 'isPaused'
  | 'showUI'
  | 'replyKeyboardInset'
  | 'onNextStory'
  | 'onPreviousStory'
  | 'onToggleShowUI'
  | 'onPauseChange'
  | 'onVideoMetadata'
  | 'onVideoTimeUpdate'
  | 'onVideoEnded'
>;

export default function StoryMediaStage({
  currentStory,
  currentStoryFilter,
  currentStoryFilterOverlay,
  storyVideoRef,
  currentTimeSec,
  isStoryOwner,
  isPaused,
  showUI,
  replyKeyboardInset,
  onNextStory,
  onPreviousStory,
  onToggleShowUI,
  onPauseChange,
  onVideoMetadata,
  onVideoTimeUpdate,
  onVideoEnded,
}: StoryMediaStageProps) {
  const canvasStyle = currentStory.timed_texts.find(
    (item): item is StoryCanvasStyleOverlay => item.type === 'canvas-style'
      && currentTimeSec >= item.startTime
      && currentTimeSec <= item.endTime,
  );
  const mediaTransform = currentStory.timed_texts.find(
    (item): item is StoryMediaTransformOverlay => item.type === 'media-transform'
      && currentTimeSec >= item.startTime
      && currentTimeSec <= item.endTime,
  );
  const mediaTransformCss = mediaTransform
    ? `translate(${mediaTransform.x}%, ${mediaTransform.y}%) scale(${mediaTransform.scale}) rotate(${mediaTransform.rotation}deg)`
    : undefined;
  const visibleTextLayers = currentStory.timed_texts.filter(
    (item): item is StoryTextOverlay => (item.type === undefined || item.type === 'text')
      && currentTimeSec >= item.startTime
      && currentTimeSec <= item.endTime,
  );

  useEffect(() => {
    const video = storyVideoRef.current;
    if (!video) return;
    if (isPaused) {
      video.pause();
      return;
    }
    if (video.readyState >= 1) void video.play().catch(() => {});
  }, [currentStory.id, isPaused, storyVideoRef]);

  // إيقاف الصوت وإطلاق موارده عند مغادرة عارض القصص:
  // Safari قد يواصل تشغيل صوت عنصر فيديو منزوع من الشجرة.
  useEffect(() => () => {
    const video = storyVideoRef.current;
    if (!video) return;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* العنصر قد يكون أفلت مرجعه بالفعل */
    }
  }, []);

  return (
    <div className="absolute inset-0 flex h-full w-full items-center justify-center bg-zinc-950">
      {currentStory.media_url ? (
        currentStory.media_type === 'video' ? (
          <video
            ref={storyVideoRef}
            key={currentStory.id}
            src={currentStory.media_url}
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            style={{ filter: currentStoryFilter.css, transform: mediaTransformCss, transformOrigin: 'center' }}
            onLoadedMetadata={event => {
              const video = event.currentTarget;
              onVideoMetadata(currentStory.id, video.duration);
              if (!isPaused) void video.play().catch(() => {});
            }}
            onTimeUpdate={event => {
              const video = event.currentTarget;
              onVideoTimeUpdate(currentStory.id, video.currentTime, video.duration);
            }}
            onEnded={() => onVideoEnded(currentStory.id)}
          />
        ) : (
          <img src={currentStory.media_url} alt="" className="h-full w-full object-contain" style={{ filter: currentStoryFilter.css, transform: mediaTransformCss, transformOrigin: 'center' }} />
        )
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: canvasStyle?.background || '#1f1f27', filter: currentStoryFilter.css }}
        >
          {visibleTextLayers.length === 0 && currentStory.caption && (
            <div
              className={`absolute left-1/2 top-1/2 w-[min(82vw,40rem)] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap break-words text-center text-2xl font-bold text-white ${canvasStyle?.textAnimation && canvasStyle.textAnimation !== 'none' ? `aani-story-anim-${canvasStyle.textAnimation}` : ''}`}
              style={canvasStyle ? {
                color: canvasStyle.textColor,
                fontFamily: canvasStyle.fontFamily,
                textAlign: canvasStyle.textAlign,
                background: canvasStyle.textBackground,
                textShadow: '0 2px 14px rgba(0,0,0,0.42)',
              } : undefined}
            >
              {currentStory.caption}
            </div>
          )}
        </div>
      )}

      {currentStoryFilterOverlay && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: currentStoryFilterOverlay.color,
            opacity: currentStoryFilterOverlay.opacity,
            mixBlendMode: currentStoryFilterOverlay.blend as never,
          }}
        />
      )}

      {currentStory.timed_texts.map((timedText, index) => {
        if (currentTimeSec < timedText.startTime || currentTimeSec > timedText.endTime) return null;
        if (timedText.type === 'canvas-style' || timedText.type === 'media-transform') return null;
        const layerOrder = timedText.layerOrder ?? index + 10;

        if (timedText.type === 'drawing') {
          return <StoryDrawingLayer key={timedText.id || 'story-drawing'} strokes={timedText.strokes} layerOrder={layerOrder} />;
        }

        if (timedText.type === 'image') {
          return (
            <StoryImageSticker
              key={timedText.id}
              sticker={timedText as StoryImageOverlay}
              interactive={false}
              layerOrder={layerOrder}
            />
          );
        }

        const textLayer = timedText as StoryTextOverlay;
        return (
          <div
            key={textLayer.id}
            className={`absolute ${currentStory.media_type === 'text' ? 'w-[90vw] max-w-[90vw]' : 'w-[82vw] max-w-[82vw]'} whitespace-pre-wrap break-words px-3 py-2 text-2xl font-bold ${textLayer.textAnimation && textLayer.textAnimation !== 'none' ? `aani-story-anim-${textLayer.textAnimation}` : ''}`}
            dir={currentStory.media_type === 'text' ? 'rtl' : undefined}
            style={{
              top: `${textLayer.y}%`,
              left: `${textLayer.x}%`,
              transform: `translate(-50%, -50%) scale(${textLayer.scale ?? 1}) rotate(${textLayer.rotation ?? 0}deg)`,
              zIndex: layerOrder,
              color: textLayer.textColor || '#FFFFFF',
              fontFamily: textLayer.fontFamily || 'Cairo',
              fontSize: textLayer.fontSize ?? (currentStory.media_type === 'text' ? 30 : undefined),
              textAlign: textLayer.textAlign || 'center',
              overflowWrap: 'anywhere',
              lineHeight: 1.35,
              background: textLayer.textBackground || 'transparent',
              textShadow: '0 2px 14px rgba(0,0,0,0.42)',
            }}
          >
            {textLayer.text}
          </div>
        );
      })}

      {showUI && currentStory.caption && currentStory.media_url && (
        <div
          className="absolute inset-x-4 z-10 rounded-xl bg-black/60 p-3 text-center text-xs text-white backdrop-blur-md"
          style={{ bottom: isStoryOwner
            ? 'calc(4.5rem + env(safe-area-inset-bottom))'
            : `calc(5.5rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
        >
          {currentStory.caption}
        </div>
      )}

      <div className="absolute inset-y-0 left-0 w-1/3 z-20" onClick={onNextStory} />
      <div className="absolute inset-y-0 right-0 w-1/3 z-20" onClick={onPreviousStory} />
      <div
        className="absolute inset-y-0 left-1/3 w-1/3 z-20"
        onClick={onToggleShowUI}
        onMouseDown={() => onPauseChange(true)}
        onMouseUp={() => onPauseChange(false)}
        onTouchStart={() => onPauseChange(true)}
        onTouchEnd={() => onPauseChange(false)}
      />
    </div>
  );
}



function StoryDrawingLayer({ strokes, layerOrder }: { strokes: StoryDrawStroke[]; layerOrder: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const redraw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;

      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      strokes.forEach(stroke => drawStoryStroke(context, stroke, width, height));
    };

    redraw();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(redraw);
    observer?.observe(canvas);
    window.addEventListener('resize', redraw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', redraw);
    };
  }, [strokes]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: layerOrder }}
      aria-hidden="true"
    />
  );
}
