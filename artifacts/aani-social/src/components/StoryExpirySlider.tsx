interface StoryExpirySliderProps {
  durationSeconds: number;
  onChange: (durationSeconds: number) => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} ثانية`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} دقيقة و${remainingSeconds} ثانية` : `${minutes} دقيقة`;
}

export default function StoryExpirySlider({ durationSeconds, onChange }: StoryExpirySliderProps) {
  return (
    <div className="mt-2 w-full rounded-xl border border-white/10 bg-black/70 p-3" dir="rtl">
      <div className="mb-2 flex items-center justify-between text-[10px] text-white/75">
        <span>مدة عرض الستوري على الشاشة</span>
        <span className="font-bold text-white">{formatDuration(durationSeconds)}</span>
      </div>
      <input
        type="range"
        min={1}
        max={120}
        step={1}
        value={durationSeconds}
        onChange={event => onChange(Number(event.target.value))}
        aria-label="مدة عرض الستوري على الشاشة بالثواني"
        className="h-1 w-full accent-emerald-400"
      />
      <div className="mt-1 flex justify-between text-[9px] text-white/40">
        <span>1 ثانية</span>
        <span>60 ثانية</span>
        <span>120 ثانية</span>
      </div>
    </div>
  );
}
