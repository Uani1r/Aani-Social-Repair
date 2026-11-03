import type { StoryViewerProps } from './types';

type StoryProgressBarProps = Pick<StoryViewerProps, 'activeStories' | 'activeStoryIndex' | 'progress'>;

export default function StoryProgressBar({
  activeStories,
  activeStoryIndex,
  progress,
}: StoryProgressBarProps) {
  return (
    <div className="absolute inset-x-2 z-30 flex gap-1 px-1" style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}>
      {activeStories.map((story, index) => (
        <div key={story.id} className="h-0.5 flex-1 bg-white/[0.18] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#d0d0d8] transition-all duration-75 ease-linear"
            style={{ width: index < activeStoryIndex ? '100%' : index === activeStoryIndex ? `${progress}%` : '0%' }}
          />
        </div>
      ))}
    </div>
  );
}
