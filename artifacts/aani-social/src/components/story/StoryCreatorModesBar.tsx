import { ImagePlus } from 'lucide-react';

type StoryCreatorModesBarProps = {
  keyboardInset: number;
  onOpenMediaPicker: () => void;
};

const MODES = ['POST', 'STORY', 'INSTANTS', 'REEL'] as const;

export default function StoryCreatorModesBar({ keyboardInset, onOpenMediaPicker }: StoryCreatorModesBarProps) {
  return (
    <div
      className="absolute inset-x-3 bottom-0 z-50 flex items-center justify-between gap-2"
      style={{ paddingBottom: `calc(0.55rem + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
      dir="ltr"
    >
      <button
        type="button"
        onClick={onOpenMediaPicker}
        aria-label="اختيار وسائط من المعرض"
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-black/45 px-3 text-[10px] font-semibold text-white/90 backdrop-blur-xl transition active:scale-95"
      >
        <ImagePlus size={16} />
        <span>MEDIA</span>
      </button>

      <nav
        aria-label="أنواع إنشاء المحتوى"
        className="flex min-w-0 items-center justify-center gap-1 rounded-full border border-white/10 bg-black/45 p-1 backdrop-blur-xl"
      >
        {MODES.map(mode => (
          <span
            key={mode}
            aria-current={mode === 'STORY' ? 'page' : undefined}
            className={`rounded-full px-2.5 py-2 text-[9px] font-bold tracking-wide transition sm:px-3 ${
              mode === 'STORY'
                ? 'bg-white text-zinc-950 shadow-sm'
                : 'text-white/55'
            }`}
          >
            {mode}
          </span>
        ))}
      </nav>
    </div>
  );
}
