import { Clock } from 'lucide-react';

interface StoryExpirySliderProps {
  durationSeconds: number;
  onChange: (durationSeconds: number) => void;
}

export default function StoryExpirySlider({ durationSeconds, onChange }: StoryExpirySliderProps) {
  return (
    <div
      className="flex w-48 max-w-[calc(100vw-8rem)] items-center gap-3 rounded-2xl border border-white/10 bg-[#101014]/95 px-3 py-3 shadow-2xl backdrop-blur-xl"
      dir="ltr"
    >
      <Clock size={17} className="shrink-0 text-white/75" aria-hidden="true" />
      <input
        type="range"
        min={5}
        max={120}
        step={1}
        value={durationSeconds}
        onChange={event => onChange(Number(event.target.value))}
        aria-label="مدة عرض الستوري بالثواني"
        className="h-1 min-w-0 flex-1 accent-emerald-400"
      />
      <span className="min-w-[2.5rem] text-center text-[11px] font-semibold tabular-nums text-white" aria-live="polite">
        {durationSeconds}s
      </span>
    </div>
  );
}
