import type { LucideIcon } from 'lucide-react';
import { AtSign, ChevronDown, Clock, ImagePlus, Music2, Pencil, Sparkles, Star, Type } from 'lucide-react';

import StoryExpirySlider from '@/components/StoryExpirySlider';
import StoryFilterBar from '@/components/StoryFilterBar';
import StoryTextToolbar from '@/components/StoryTextToolbar';
import StoryTypedPreview from '@/components/StoryTypedPreview';
import { STORY_DRAW_COLORS, STORY_DRAW_SIZES } from '@/lib/appShared';
import type { StoryAdjustments } from '@/lib/storyFilters';
import type { StoryTextAlign, StoryTextAnimation } from '@/lib/storyFonts';

export type StoryEditorToolKey = 'text' | 'image' | 'music' | 'effects' | 'mention' | 'draw';

type StoryEditorExtraTool = { key: string; label: string; action: () => void };
type StoryBackgroundPreset = { label: string; background: string };

type StoryEditorToolbarProps = {
  storyToolsRef: { current: HTMLDivElement | null };
  storyMoreOpen: boolean;
  storyDurationOpen: boolean;
  storyExtraTools: StoryEditorExtraTool[];
  uploadDuration: number;
  onSelectTool: (key: StoryEditorToolKey) => void;
  onToggleMore: () => void;
  onDurationChange: (duration: number) => void;
};

export function StoryEditorToolbar({
  storyToolsRef,
  storyMoreOpen,
  storyDurationOpen,
  storyExtraTools,
  uploadDuration,
  onSelectTool,
  onToggleMore,
  onDurationChange,
}: StoryEditorToolbarProps) {
  const tools: { key: StoryEditorToolKey; icon: LucideIcon; label: string }[] = [
    { key: 'text', icon: Type, label: 'نص' },
    { key: 'image', icon: ImagePlus, label: 'ملصق صورة' },
    { key: 'music', icon: Music2, label: 'موسيقى' },
    { key: 'effects', icon: Sparkles, label: 'فلاتر' },
    { key: 'mention', icon: AtSign, label: 'إشارة' },
    { key: 'draw', icon: Pencil, label: 'رسم' },
  ];

  return (
    <div
      ref={storyToolsRef}
      className="absolute right-2.5 z-20 flex flex-col items-center gap-2.5"
      style={{ top: 'calc(3.75rem + env(safe-area-inset-top))' }}
    >
      {tools.map(tool => {
        const Icon = tool.icon;
        return (
          <button
            key={tool.key}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onClick={() => onSelectTool(tool.key)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
          >
            <Icon size={17} />
          </button>
        );
      })}

      {/* الزر السابع: قائمة أدوات إضافية قابلة للتوسعة */}
      <div className="relative">
        <button
          type="button"
          aria-label="أدوات إضافية"
          aria-expanded={storyMoreOpen}
          onClick={onToggleMore}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
        >
          <ChevronDown
            size={17}
            className={`transition-transform duration-200 ${storyMoreOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {storyMoreOpen && (
          <div
            className="absolute left-1/2 top-full z-30 mt-2 flex w-9 -translate-x-1/2 flex-col items-stretch gap-1 rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur-xl"
            dir="rtl"
            role="menu"
          >
            {storyExtraTools.map(item => {
              const Icon = item.key === 'close-friends' ? Star : Clock;
              return (
                <div key={item.key} className="relative">
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={item.label}
                    aria-expanded={item.key === 'duration' ? storyDurationOpen : undefined}
                    onClick={item.action}
                    className={`flex h-9 w-full items-center justify-center rounded-lg transition hover:bg-white/10 ${item.key === 'close-friends' ? 'text-emerald-400' : 'text-white/85'}`}
                  >
                    <Icon size={19} fill={item.key === 'close-friends' ? 'currentColor' : 'none'} />
                  </button>
                  {item.key === 'duration' && storyDurationOpen && (
                    <div className="absolute right-full top-0 z-40 mr-2">
                      <StoryExpirySlider durationSeconds={uploadDuration} onChange={onDurationChange} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

type StoryTextEditorPanelProps = {
  storyTextEditorOpen: boolean;
  storyText: string;
  storyKeyboardInset: number;
  storyEditorPreviewMode: boolean;
  storyAnimationTick: number;
  storyPreviewClassName: string;
  storyTextAnimation: StoryTextAnimation;
  storyFontFamily: string;
  storyTextColor: string;
  storyTextAlign: StoryTextAlign;
  storyHasBackground: boolean;
  storyBackgroundPreset: StoryBackgroundPreset;
  storyTextAreaRef: { current: HTMLTextAreaElement | null };
  onStoryTextChange: (value: string) => void;
  onFinishTextEditing: () => void;
  onFontFamilyChange: (family: string) => void;
  onTextColorChange: (color: string) => void;
  onCycleAlign: () => void;
  onCycleBackground: () => void;
  onAnimationChange: (animation: StoryTextAnimation) => void;
  onInteract: () => void;
};

export function StoryTextEditorPanel({
  storyTextEditorOpen,
  storyText,
  storyKeyboardInset,
  storyEditorPreviewMode,
  storyAnimationTick,
  storyPreviewClassName,
  storyTextAnimation,
  storyFontFamily,
  storyTextColor,
  storyTextAlign,
  storyHasBackground,
  storyBackgroundPreset,
  storyTextAreaRef,
  onStoryTextChange,
  onFinishTextEditing,
  onFontFamilyChange,
  onTextColorChange,
  onCycleAlign,
  onCycleBackground,
  onAnimationChange,
  onInteract,
}: StoryTextEditorPanelProps) {
  if (!storyTextEditorOpen) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-black/70 backdrop-blur-sm"
      dir="rtl"
      onClick={event => {
        if (event.target === event.currentTarget) onFinishTextEditing();
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <span className="text-[12px] text-white/60">محرر النص</span>
        <button
          type="button"
          onClick={onFinishTextEditing}
          className="rounded-full bg-white px-4 py-1.5 text-[12px] font-bold text-[#121212]"
        >
          تم
        </button>
      </div>

      <div className="flex min-h-[96px] flex-1 items-start justify-center px-6 pt-2">
        <div className="relative flex w-full max-w-md items-start justify-center">
          {/* معاينة حيّة للنص بنفس خط/لون/خلفية/حركة القصة */}
          {storyEditorPreviewMode && (
            <p
              key={`${storyTextAnimation}-${storyAnimationTick}`}
              aria-hidden="true"
              className={storyPreviewClassName}
              style={{
                fontFamily: storyFontFamily,
                color: storyTextColor,
                fontSize: 30,
                textAlign: storyTextAlign,
                lineHeight: 1.35,
                padding: storyHasBackground ? '2px 10px' : undefined,
                borderRadius: storyHasBackground ? 8 : undefined,
                background: storyHasBackground ? storyBackgroundPreset.background : 'transparent',
                textShadow: '0 2px 12px rgba(0,0,0,0.9)',
              }}
            >
              <StoryTypedPreview
                key={storyAnimationTick}
                text={storyText}
                animate={storyTextAnimation === 'typewriter'}
              />
            </p>
          )}

          <textarea
            ref={storyTextAreaRef}
            autoFocus
            value={storyText}
            onChange={event => onStoryTextChange(event.target.value)}
            placeholder="اكتب شيئاً..."
            dir="rtl"
            rows={3}
            className="relative w-full max-w-md resize-none overflow-hidden bg-transparent font-bold outline-none placeholder:text-white/40"
            style={{
              fontFamily: storyFontFamily,
              color: storyEditorPreviewMode ? 'transparent' : storyTextColor,
              caretColor: storyTextColor,
              WebkitTextFillColor: storyEditorPreviewMode ? 'transparent' : storyTextColor,
              fontSize: 30,
              textAlign: storyTextAlign,
              lineHeight: 1.35,
              padding: 0,
              background: 'transparent',
              textShadow: storyEditorPreviewMode ? 'none' : '0 2px 12px rgba(0,0,0,0.9)',
            }}
          />
        </div>
      </div>

      {/* شريط أدوات النص بنمط إنستغرام: الخيارات تنبثق فوقه مباشرة */}
      <div
        className="px-3"
        style={{ paddingBottom: `calc(0.8rem + env(safe-area-inset-bottom) + ${storyKeyboardInset}px)` }}
      >
        <StoryTextToolbar
          fontFamily={storyFontFamily}
          onFontFamilyChange={onFontFamilyChange}
          textColor={storyTextColor}
          onTextColorChange={onTextColorChange}
          align={storyTextAlign}
          onCycleAlign={onCycleAlign}
          backgroundLabel={storyBackgroundPreset.label}
          backgroundSwatch={storyBackgroundPreset.background}
          onCycleBackground={onCycleBackground}
          animation={storyTextAnimation}
          onAnimationChange={onAnimationChange}
          onInteract={onInteract}
        />
      </div>
    </div>
  );
}

type StoryEditorPanelsProps = {
  storyFiltersOpen: boolean;
  editorMediaUrl: string | null;
  editorIsVideo: boolean;
  storyFilterId: string;
  storyFilterAdjustments: StoryAdjustments;
  storyMusicTrack: { id: string; title: string; artist: string } | null;
  storyDrawingOpen: boolean;
  storyDrawColor: string;
  storyDrawSize: number;
  storyDrawStrokesCount: number;
  onSelectFilter: (id: string) => void;
  onAdjustFilter: (key: keyof StoryAdjustments, value: number) => void;
  onResetFilters: () => void;
  onCloseFilters: () => void;
  onDrawColorChange: (color: string) => void;
  onDrawSizeChange: (size: number) => void;
  onUndoDrawing: () => void;
  onCloseDrawing: () => void;
};

export function StoryEditorPanels({
  storyFiltersOpen,
  editorMediaUrl,
  editorIsVideo,
  storyFilterId,
  storyFilterAdjustments,
  storyMusicTrack,
  storyDrawingOpen,
  storyDrawColor,
  storyDrawSize,
  storyDrawStrokesCount,
  onSelectFilter,
  onAdjustFilter,
  onResetFilters,
  onCloseFilters,
  onDrawColorChange,
  onDrawSizeChange,
  onUndoDrawing,
  onCloseDrawing,
}: StoryEditorPanelsProps) {
  return (
    <>
      {storyFiltersOpen && (
        <StoryFilterBar
          previewUrl={editorMediaUrl}
          isVideo={editorIsVideo}
          activeId={storyFilterId}
          onSelect={onSelectFilter}
          adjustments={storyFilterAdjustments}
          onAdjust={onAdjustFilter}
          onReset={onResetFilters}
          onClose={onCloseFilters}
        />
      )}
      {storyMusicTrack && (
        <div className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[10px] text-white backdrop-blur-sm">
          <Music2 size={12} />
          <span className="max-w-[55vw] truncate">{storyMusicTrack.title}</span>
        </div>
      )}
      {storyDrawingOpen && (
        <div className="mb-3 rounded-2xl border border-white/15 bg-black/75 p-2.5 text-white shadow-xl backdrop-blur-xl" dir="rtl">
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[10px] font-semibold text-white/70">لون القلم</span>
            <div className="flex items-center gap-2" dir="ltr">
              {STORY_DRAW_COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  aria-label={`لون الرسم ${color}`}
                  aria-pressed={storyDrawColor === color}
                  onClick={() => onDrawColorChange(color)}
                  className={`h-6 w-6 rounded-full border-2 transition ${storyDrawColor === color ? 'border-white scale-110' : 'border-white/30'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="shrink-0 text-[10px] font-semibold text-white/70">حجم القلم</span>
            <div className="flex items-center gap-2" dir="ltr">
              {STORY_DRAW_SIZES.map(size => (
                <button
                  key={size}
                  type="button"
                  aria-label={`حجم القلم ${size}`}
                  aria-pressed={storyDrawSize === size}
                  onClick={() => onDrawSizeChange(size)}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${storyDrawSize === size ? 'border-white bg-white/15' : 'border-white/20'}`}
                >
                  <span className="rounded-full bg-white" style={{ width: size, height: size }} />
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onUndoDrawing}
              disabled={storyDrawStrokesCount === 0}
              className="h-9 flex-1 rounded-full border border-white/25 text-[11px] font-semibold disabled:opacity-40"
            >
              تراجع
            </button>
            <button
              type="button"
              onClick={onCloseDrawing}
              className="h-9 flex-1 rounded-full bg-white text-[11px] font-bold text-[#121212]"
            >
              تم
            </button>
          </div>
        </div>
      )}
    </>
  );
}
