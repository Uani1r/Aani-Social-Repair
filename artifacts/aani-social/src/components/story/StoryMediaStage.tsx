import type { StoryDrawPoint } from '@/lib/appShared';

import type { StoryViewerProps } from './types';

type StoryMediaStageProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'currentStoryFilter'
  | 'currentStoryFilterOverlay'
  | 'storyVideoRef'
  | 'currentTimeSec'
  | 'isStoryOwner'
  | 'replyKeyboardInset'
  | 'onNextStory'
  | 'onPreviousStory'
  | 'onToggleShowUI'
  | 'onPauseChange'
>;

export default function StoryMediaStage({
  currentStory,
  currentStoryFilter,
  currentStoryFilterOverlay,
  storyVideoRef,
  currentTimeSec,
  isStoryOwner,
  replyKeyboardInset,
  onNextStory,
  onPreviousStory,
  onToggleShowUI,
  onPauseChange,
}: StoryMediaStageProps) {
  return (
    <div className="absolute inset-0 flex h-full w-full items-center justify-center bg-zinc-950">
      {currentStory.media_url ? (
        currentStory.media_type === 'video' ? (
          <video
            ref={storyVideoRef}
            key={currentStory.id}
            src={currentStory.media_url}
            autoPlay
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            style={{ filter: currentStoryFilter.css }}
          />
        ) : (
          <img src={currentStory.media_url} alt="" className="h-full w-full object-contain" style={{ filter: currentStoryFilter.css }} />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#1f1f27] p-6 text-center text-base font-bold text-white">
          {currentStory.caption}
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

      {currentStory.timed_texts.map(timedText => {
        if (currentTimeSec < timedText.startTime || currentTimeSec > timedText.endTime) return null;

        if (timedText.type === 'drawing') {
          return (
            <svg
              key={timedText.id || 'story-drawing'}
              className="pointer-events-none absolute inset-0 z-20 h-full w-full"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {timedText.strokes.map((stroke, index) => {
                const points = stroke.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
                if (points.length === 0) return null;
                const first = points[0];
                const path = points.length === 1
                  ? `M ${first.x * 1000} ${first.y * 1000} L ${first.x * 1000 + 0.01} ${first.y * 1000}`
                  : points.map((point: StoryDrawPoint, pointIndex: number) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x * 1000} ${point.y * 1000}`).join(' ');
                const width = Number.isFinite(stroke.size) ? Math.min(24, Math.max(1, stroke.size)) : 5;
                return (
                  <path
                    key={stroke.id || index}
                    d={path}
                    fill="none"
                    stroke={typeof stroke.color === 'string' ? stroke.color : '#FFFFFF'}
                    strokeWidth={width}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
          );
        }

        return (
          <div
            key={timedText.id}
            style={{ top: `${timedText.y}%`, left: `${timedText.x}%`, transform: 'translate(-50%, -50%)' }}
            className="absolute bg-black/70 text-white font-bold px-3 py-1.5 rounded-xl text-xs border border-white/20 backdrop-blur-sm z-20"
          >
            {timedText.text}
          </div>
        );
      })}

      {currentStory.caption && currentStory.media_url && (
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
