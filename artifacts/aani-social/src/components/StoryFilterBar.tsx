import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

import {
  STORY_FILTERS,
  buildStoryFilterCss,
  type StoryAdjustments,
} from '@/lib/storyFilters';

interface StoryFilterBarProps {
  previewUrl: string | null;
  isVideo: boolean;
  activeId: string;
  onSelect: (id: string) => void;
  adjustments: StoryAdjustments;
  onAdjust: (key: keyof StoryAdjustments, value: number) => void;
  onReset: () => void;
  onClose: () => void;
}

const SLIDERS: { key: keyof StoryAdjustments; label: string; min: number; max: number }[] = [
  { key: 'brightness', label: 'سطوع', min: -60, max: 60 },
  { key: 'contrast', label: 'تباين', min: -60, max: 60 },
  { key: 'saturation', label: 'تشبع', min: -80, max: 80 },
  { key: 'warmth', label: 'حرارة', min: -50, max: 50 },
  { key: 'clarity', label: 'وضوح', min: 0, max: 70 },
];

export default function StoryFilterBar({
  previewUrl,
  isVideo,
  activeId,
  onSelect,
  adjustments,
  onAdjust,
  onReset,
  onClose,
}: StoryFilterBarProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);

  return (
    <div className="pointer-events-auto rounded-t-2xl border-t border-white/10 bg-black/75 px-2 pt-2 backdrop-blur-xl" dir="rtl" data-story-editor-control="true" onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()} onTouchCancel={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[11px] font-bold text-white/80">الفلاتر</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAdjustOpen(open => !open)}
            className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition ${
              adjustOpen ? 'bg-white text-[#121212]' : 'bg-white/10 text-white/75'
            }`}
          >
            <SlidersHorizontal size={12} />
            تعديل
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/75 transition active:scale-95"
          >
            إعادة
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق الفلاتر"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/80 transition active:scale-95"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {adjustOpen && (
        <div className="mb-2 space-y-1.5 rounded-xl bg-white/5 px-3 py-2">
          {SLIDERS.map(slider => (
            <label key={slider.key} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[10px] text-white/60">{slider.label}</span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                value={adjustments[slider.key]}
                onChange={event => onAdjust(slider.key, Number(event.target.value))}
                className="h-1 flex-1 accent-white"
              />
              <span className="w-7 text-right text-[9px] tabular-nums text-white/50">
                {adjustments[slider.key]}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="aani-hscroll flex gap-2 overflow-x-auto pb-2">
        {STORY_FILTERS.map(filter => {
          const active = filter.id === activeId;
          return (
            <button
              key={filter.id}
              type="button"
              onClick={() => onSelect(filter.id)}
              className="flex w-16 shrink-0 flex-col items-center gap-1"
            >
              <span
                className={`relative h-16 w-16 overflow-hidden rounded-xl border-2 transition ${
                  active ? 'border-white' : 'border-white/15'
                }`}
              >
                {previewUrl && !isVideo ? (
                  <img
                    src={previewUrl}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                    style={{ filter: buildStoryFilterCss(filter.id, adjustments) }}
                  />
                ) : (
                  <span
                    className="block h-full w-full"
                    style={{
                      background: 'linear-gradient(135deg, #FFB199 0%, #FF0844 45%, #2F80ED 100%)',
                      filter: buildStoryFilterCss(filter.id, adjustments),
                    }}
                  />
                )}
                {filter.overlay && (
                  <span
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background: filter.overlay.color,
                      opacity: filter.overlay.opacity,
                      mixBlendMode: filter.overlay.blend as never,
                    }}
                  />
                )}
              </span>
              <span className={`w-16 truncate text-center text-[9px] ${active ? 'text-white' : 'text-white/55'}`}>
                {filter.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
