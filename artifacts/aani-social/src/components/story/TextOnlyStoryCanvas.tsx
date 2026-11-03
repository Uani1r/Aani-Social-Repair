import { useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { ArrowLeft, Check, Paintbrush, Type } from 'lucide-react';

import CloseFriendsSheet from '@/components/CloseFriendsSheet';
import StoryMentionPicker, { type MentionCandidate } from '@/components/StoryMentionPicker';
import StoryMusicSheet from '@/components/StoryMusicSheet';
import { StoryEditorPanels, StoryEditorToolbar, type StoryEditorToolKey } from '@/components/StoryEditorTools';
import StoryTextToolbar from '@/components/StoryTextToolbar';
import StoryCreatorModesBar from '@/components/story/StoryCreatorModesBar';
import type { StoryDrawStroke } from '@/lib/appShared';
import type { StoryAdjustments } from '@/lib/storyFilters';
import type { StoryTextBackgroundPreset, StoryTextAlign, StoryTextAnimation } from '@/lib/storyFonts';
import type { MusicTrack } from '@/lib/music';

interface StoryEditorExtraTool {
  key: string;
  label: string;
  action: () => void;
}

interface StoryFilterOverlay {
  color: string;
  opacity: number;
  blend: string;
}

interface TextOnlyStoryCanvasProps {
  userId: string;
  storyText: string;
  fontFamily: string;
  textColor: string;
  textAlign: StoryTextAlign;
  textAnimation: StoryTextAnimation;
  textBackgroundPreset: StoryTextBackgroundPreset;
  canvasBackground: string;
  editorOpen: boolean;
  keyboardInset: number;
  animationTick: number;
  visibleText: string;
  previewClassName: string;
  editorPreviewMode: boolean;
  storyTextOffset: { x: number; y: number };
  storyTextScale: number;
  storyTextRotation: number;
  textAreaRef: { current: HTMLTextAreaElement | null };
  storyToolsRef: { current: HTMLDivElement | null };
  storyDrawingCanvasRef: { current: HTMLCanvasElement | null };
  storyMoreOpen: boolean;
  storyDurationOpen: boolean;
  extraTools: StoryEditorExtraTool[];
  uploadDuration: number;
  storyFiltersOpen: boolean;
  storyFilterId: string;
  storyFilterAdjustments: StoryAdjustments;
  storyFilterValue: string;
  storyFilterOverlay: StoryFilterOverlay | null;
  storyMusicTrack: { id: string; title: string; artist: string } | null;
  storyDrawingOpen: boolean;
  storyDrawColor: string;
  storyDrawSize: number;
  storyDrawStrokes: StoryDrawStroke[];
  storyMusicOpen: boolean;
  storyMentionsOpen: boolean;
  closeFriendsOpen: boolean;
  uploading: boolean;
  onBackToPicker: () => void;
  onOpenMediaPicker: () => void;
  onPublish: () => void;
  onOpenEditor: () => void;
  onFinishEditing: () => void;
  onTextChange: (value: string) => void;
  onFontFamilyChange: (family: string) => void;
  onTextColorChange: (color: string) => void;
  onCycleAlign: () => void;
  onCycleTextBackground: () => void;
  onAnimationChange: (animation: StoryTextAnimation) => void;
  onInteract: () => void;
  onCanvasBackgroundChange: (background: string) => void;
  onSelectTool: (key: StoryEditorToolKey) => void;
  onToggleMore: () => void;
  onDurationChange: (duration: number) => void;
  onSelectFilter: (id: string) => void;
  onAdjustFilter: (key: keyof StoryAdjustments, value: number) => void;
  onResetFilters: () => void;
  onCloseFilters: () => void;
  onDrawColorChange: (color: string) => void;
  onDrawSizeChange: (size: number) => void;
  onUndoDrawing: () => void;
  onCloseDrawing: () => void;
  onDrawPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onDrawPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onDrawPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onCanvasTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onCanvasTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onCanvasTouchEnd: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onCloseMusic: () => void;
  onSelectMusic: (track: MusicTrack) => void;
  onCloseMentions: () => void;
  onConfirmMentions: (people: MentionCandidate[]) => void;
  onCloseCloseFriends: () => void;
}

const CANVAS_BACKGROUNDS = [
  { label: 'بنفسجي ووردي', value: 'linear-gradient(135deg, #4C1D95 0%, #DB2777 52%, #F97316 100%)' },
  { label: 'أزرق ليلي', value: 'linear-gradient(135deg, #0F172A 0%, #1D4ED8 55%, #38BDF8 100%)' },
  { label: 'غروب', value: 'linear-gradient(135deg, #7C2D12 0%, #EA580C 48%, #FACC15 100%)' },
  { label: 'وردي', value: '#BE185D' },
  { label: 'أخضر', value: 'linear-gradient(135deg, #064E3B 0%, #10B981 100%)' },
  { label: 'أسود', value: '#111827' },
  { label: 'أبيض', value: '#F4F4F5' },
  { label: 'بنفسجي', value: '#6D28D9' },
] as const;

function colorInputValue(background: string): string {
  return /^#[0-9a-f]{6}$/i.test(background) ? background : '#4C1D95';
}

export default function TextOnlyStoryCanvas({
  userId,
  storyText,
  fontFamily,
  textColor,
  textAlign,
  textAnimation,
  textBackgroundPreset,
  canvasBackground,
  editorOpen,
  keyboardInset,
  animationTick,
  visibleText,
  previewClassName,
  editorPreviewMode,
  storyTextOffset,
  storyTextScale,
  storyTextRotation,
  textAreaRef,
  storyToolsRef,
  storyDrawingCanvasRef,
  storyMoreOpen,
  storyDurationOpen,
  extraTools,
  uploadDuration,
  storyFiltersOpen,
  storyFilterId,
  storyFilterAdjustments,
  storyFilterValue,
  storyFilterOverlay,
  storyMusicTrack,
  storyDrawingOpen,
  storyDrawColor,
  storyDrawSize,
  storyDrawStrokes,
  storyMusicOpen,
  storyMentionsOpen,
  closeFriendsOpen,
  uploading,
  onBackToPicker,
  onOpenMediaPicker,
  onPublish,
  onOpenEditor,
  onFinishEditing,
  onTextChange,
  onFontFamilyChange,
  onTextColorChange,
  onCycleAlign,
  onCycleTextBackground,
  onAnimationChange,
  onInteract,
  onCanvasBackgroundChange,
  onSelectTool,
  onToggleMore,
  onDurationChange,
  onSelectFilter,
  onAdjustFilter,
  onResetFilters,
  onCloseFilters,
  onDrawColorChange,
  onDrawSizeChange,
  onUndoDrawing,
  onCloseDrawing,
  onDrawPointerDown,
  onDrawPointerMove,
  onDrawPointerUp,
  onCanvasTouchStart,
  onCanvasTouchMove,
  onCanvasTouchEnd,
  onCloseMusic,
  onSelectMusic,
  onCloseMentions,
  onConfirmMentions,
  onCloseCloseFriends,
}: TextOnlyStoryCanvasProps) {
  const [backgroundPickerOpen, setBackgroundPickerOpen] = useState(false);

  return (
    <div className="aani-page-enter fixed inset-0 z-[140] overflow-hidden bg-black text-white" dir="rtl">
      <div
        className="absolute inset-0 overflow-hidden"
        onTouchStart={onCanvasTouchStart}
        onTouchMove={onCanvasTouchMove}
        onTouchEnd={onCanvasTouchEnd}
        onTouchCancel={onCanvasTouchEnd}
        style={{ touchAction: 'none' }}
      >
        <div className="absolute inset-0" style={{ background: canvasBackground, filter: storyFilterValue }} />
        {storyFilterOverlay && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: storyFilterOverlay.color,
              opacity: storyFilterOverlay.opacity,
              mixBlendMode: storyFilterOverlay.blend as never,
            }}
          />
        )}

        {storyText.trim() && !editorOpen ? (
          <button
            type="button"
            data-story-text="true"
            onClick={onOpenEditor}
            className="absolute left-1/2 top-1/2 z-10 w-[min(78vw,34rem)] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-3xl font-bold leading-snug text-shadow-lg"
            style={{
              transform: `translate(-50%, -50%) translate(${storyTextOffset.x}px, ${storyTextOffset.y}px) scale(${storyTextScale}) rotate(${storyTextRotation}deg)`,
              fontFamily,
              color: textColor,
              textAlign,
              background: textBackgroundPreset.background,
              textShadow: '0 2px 14px rgba(0,0,0,0.42)',
            }}
          >
            <span
              key={`${textAnimation}-${animationTick}`}
              className={textAnimation === 'none' ? undefined : `aani-story-anim-${textAnimation}`}
            >
              {visibleText}
            </span>
          </button>
        ) : !editorOpen ? (
          <button
            type="button"
            onClick={onOpenEditor}
            className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/25 bg-black/20 px-5 py-3 text-sm font-semibold text-white/70 backdrop-blur-sm"
          >
            اكتب قصتك هنا
          </button>
        ) : (
          <div className="absolute inset-x-14 top-1/2 z-10 -translate-y-1/2 px-2">
            <textarea
              ref={textAreaRef}
              data-story-text="true"
              autoFocus
              value={storyText}
              onChange={event => onTextChange(event.target.value)}
              placeholder="اكتب شيئاً..."
              dir="rtl"
              rows={4}
              className="w-full resize-none overflow-hidden rounded-xl bg-transparent px-3 py-2 font-bold outline-none placeholder:text-white/45"
              style={{
                fontFamily,
                color: editorPreviewMode ? 'transparent' : textColor,
                caretColor: textColor,
                WebkitTextFillColor: editorPreviewMode ? 'transparent' : textColor,
                fontSize: 30,
                textAlign,
                lineHeight: 1.35,
                textShadow: editorPreviewMode ? 'none' : '0 2px 12px rgba(0,0,0,0.8)',
                background: textBackgroundPreset.background,
              }}
            />
            {editorPreviewMode && (
              <p
                key={`${textAnimation}-${animationTick}`}
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-3 top-2 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-3xl font-bold leading-snug ${previewClassName}`}
                style={{
                  fontFamily,
                  color: textColor,
                  textAlign,
                  background: textBackgroundPreset.background,
                  textShadow: '0 2px 12px rgba(0,0,0,0.8)',
                }}
              >
                {storyText}
              </p>
            )}
          </div>
        )}

        <canvas
          ref={storyDrawingCanvasRef}
          aria-label="لوحة الرسم على خلفية القصة"
          className={`absolute inset-0 z-20 h-full w-full ${storyDrawingOpen ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
          style={{ touchAction: 'none' }}
          onPointerDown={onDrawPointerDown}
          onPointerMove={onDrawPointerMove}
          onPointerUp={onDrawPointerUp}
          onPointerCancel={onDrawPointerUp}
          onTouchStart={event => event.stopPropagation()}
          onTouchMove={event => event.stopPropagation()}
          onTouchEnd={event => event.stopPropagation()}
          onTouchCancel={event => event.stopPropagation()}
        />
      </div>

      <header
        className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-4 py-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button
          type="button"
          onClick={onBackToPicker}
          aria-label="العودة لاختيار القصة"
          className="flex h-10 items-center gap-1 rounded-full bg-black/35 px-3 text-[11px] text-white backdrop-blur-md"
        >
          <ArrowLeft size={16} />
          رجوع
        </button>
        <span className="text-[13px] font-bold text-white drop-shadow">قصة نصية</span>
        <button
          type="button"
          onClick={onPublish}
          disabled={uploading || !storyText.trim()}
          className="flex h-10 items-center gap-1 rounded-full bg-white px-3 text-[11px] font-bold text-zinc-950 transition active:scale-95 disabled:opacity-45"
        >
          <Check size={15} />
          {uploading ? 'جارٍ النشر' : 'مشاركة'}
        </button>
      </header>

      <button
        type="button"
        onClick={() => setBackgroundPickerOpen(open => !open)}
        aria-label="تغيير خلفية لوحة القصة"
        aria-expanded={backgroundPickerOpen}
        className="absolute left-4 top-[calc(4.25rem+env(safe-area-inset-top))] z-30 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white shadow-lg backdrop-blur-md"
      >
        <Paintbrush size={17} />
      </button>
      {backgroundPickerOpen && (
        <div
          className="absolute left-4 top-[calc(7.25rem+env(safe-area-inset-top))] z-40 w-52 rounded-2xl border border-white/15 bg-[#101014]/95 p-3 shadow-2xl backdrop-blur-xl"
          dir="rtl"
        >
          <div className="grid grid-cols-4 gap-2">
            {CANVAS_BACKGROUNDS.map(background => (
              <button
                key={background.value}
                type="button"
                onClick={() => onCanvasBackgroundChange(background.value)}
                aria-label={background.label}
                aria-pressed={canvasBackground === background.value}
                className={`h-9 w-9 rounded-full border-2 ${canvasBackground === background.value ? 'border-white ring-2 ring-white/30' : 'border-white/30'}`}
                style={{ background: background.value }}
              />
            ))}
          </div>
          <label className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-white/5 px-2.5 py-2 text-[10px] text-white/80">
            <span>لون مخصص</span>
            <input
              type="color"
              value={colorInputValue(canvasBackground)}
              onChange={event => onCanvasBackgroundChange(event.target.value)}
              aria-label="اختيار لون خلفية مخصص"
              className="h-7 w-10 cursor-pointer rounded-lg border border-white/20 bg-transparent p-0"
            />
          </label>
        </div>
      )}

      <StoryEditorToolbar
        storyToolsRef={storyToolsRef}
        storyMoreOpen={storyMoreOpen}
        storyDurationOpen={storyDurationOpen}
        storyExtraTools={extraTools}
        uploadDuration={uploadDuration}
        onSelectTool={onSelectTool}
        onToggleMore={onToggleMore}
        onDurationChange={onDurationChange}
      />

      {(storyFiltersOpen || storyDrawingOpen || storyMusicTrack) && (
        <div
          className="absolute inset-x-3 z-30"
          style={{ bottom: `calc(5.35rem + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
        >
          <StoryEditorPanels
            storyFiltersOpen={storyFiltersOpen}
            editorMediaUrl={null}
            editorIsVideo={false}
            storyFilterId={storyFilterId}
            storyFilterAdjustments={storyFilterAdjustments}
            storyMusicTrack={storyMusicTrack}
            storyDrawingOpen={storyDrawingOpen}
            storyDrawColor={storyDrawColor}
            storyDrawSize={storyDrawSize}
            storyDrawStrokesCount={storyDrawStrokes.length}
            onSelectFilter={onSelectFilter}
            onAdjustFilter={onAdjustFilter}
            onResetFilters={onResetFilters}
            onCloseFilters={onCloseFilters}
            onDrawColorChange={onDrawColorChange}
            onDrawSizeChange={onDrawSizeChange}
            onUndoDrawing={onUndoDrawing}
            onCloseDrawing={onCloseDrawing}
          />
        </div>
      )}

      {editorOpen && (
        <div
          className="absolute inset-x-3 z-40"
          style={{ bottom: `calc(5.35rem + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
        >
          <StoryTextToolbar
            fontFamily={fontFamily}
            onFontFamilyChange={onFontFamilyChange}
            textColor={textColor}
            onTextColorChange={onTextColorChange}
            align={textAlign}
            onCycleAlign={onCycleAlign}
            backgroundLabel={textBackgroundPreset.label}
            backgroundSwatch={textBackgroundPreset.background}
            onCycleBackground={onCycleTextBackground}
            animation={textAnimation}
            onAnimationChange={onAnimationChange}
            onInteract={onInteract}
          />
        </div>
      )}

      <button
        type="button"
        onClick={editorOpen ? onFinishEditing : onOpenEditor}
        aria-label={editorOpen ? 'إنهاء تحرير النص' : 'فتح محرر الكتابة'}
        aria-pressed={editorOpen}
        className="absolute left-1/2 z-40 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full border-2 border-white/90 bg-white text-xl font-black text-zinc-950 shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition active:scale-95"
        style={{ bottom: `calc(4.15rem + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
      >
        <Type size={23} />
        <span className="absolute text-[13px] font-black">Aa</span>
      </button>

      <StoryCreatorModesBar keyboardInset={keyboardInset} onOpenMediaPicker={onOpenMediaPicker} />

      <StoryMusicSheet open={storyMusicOpen} onClose={onCloseMusic} onSelect={onSelectMusic} />
      <StoryMentionPicker
        open={storyMentionsOpen}
        currentUserId={userId}
        onClose={onCloseMentions}
        onConfirm={onConfirmMentions}
      />
      <CloseFriendsSheet open={closeFriendsOpen} currentUserId={userId} onClose={onCloseCloseFriends} />
    </div>
  );
}
