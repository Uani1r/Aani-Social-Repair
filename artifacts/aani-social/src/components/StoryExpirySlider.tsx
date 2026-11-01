import { useMemo } from 'react';

interface StoryExpirySliderProps {
  durationSeconds: number | null;
  onChange: (durationSeconds: number | null) => void;
}

export const STORY_EXPIRY_STEPS = [
  5, 10, 20, 30, 40, 50, 60,
  ...Array.from({ length: 59 }, (_, index) => (index + 2) * 60),
];

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '24 ساعة (افتراضي)';
  if (seconds < 60) return `${seconds} ثانية`;
  return `${Math.floor(seconds / 60)} دقيقة`;
}

export default function StoryExpirySlider({ durationSeconds, onChange }: StoryExpirySliderProps) {
  const valueIndex = useMemo(() => {
    if (durationSeconds === null) return STORY_EXPIRY_STEPS.length;
    const index = STORY_EXPIRY_STEPS.indexOf(durationSeconds);
    return index >= 0 ? index : STORY_EXPIRY_STEPS.length;
  }, [durationSeconds]);

  return (
    <div className="mt-2 w-full rounded-xl border border-white/10 bg-black/70 p-3" dir="rtl">
      <div className="mb-2 flex items-center justify-between text-[10px] text-white/75">
        <span>مدة انتهاء القصة</span>
        <span className="font-bold text-white">{formatDuration(durationSeconds)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={STORY_EXPIRY_STEPS.length}
        step={1}
        value={valueIndex}
        onChange={event => {
          const index = Number(event.target.value);
          onChange(index === STORY_EXPIRY_STEPS.length ? null : STORY_EXPIRY_STEPS[index]);
        }}
        aria-label="مدة انتهاء القصة"
        className="h-1 w-full accent-emerald-400"
      />
      <div className="mt-1 flex justify-between text-[9px] text-white/40">
        <span>5 ثوانٍ</span>
        <span>60 دقيقة</span>
        <span>24 ساعة</span>
      </div>
    </div>
  );
}
