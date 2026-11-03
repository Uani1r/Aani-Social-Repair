import { useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Paintbrush, Star, Trash2 } from 'lucide-react';

import CloseFriendsSheet from '@/components/CloseFriendsSheet';
import StoryMentionPicker, { type MentionCandidate } from '@/components/StoryMentionPicker';
import StoryMusicSheet from '@/components/StoryMusicSheet';
import { StoryEditorPanels, StoryEditorToolbar, StoryTextEditorPanel, type StoryEditorToolKey } from '@/components/StoryEditorTools';
import StoryImageSticker from '@/components/StoryImageSticker';
import StoryAlignmentGuides from '@/components/StoryAlignmentGuides';
import type { StoryImageStickerUpdate, StoryTimedText } from '@/components/stories/types';
import type { StoryDrawStroke } from '@/lib/appShared';
import type { StoryAdjustments } from '@/lib/storyFilters';
import type { StoryTextBackgroundPreset, StoryTextAlign, StoryTextAnimation } from '@/lib/storyFonts';
import { displayName, type Profile } from '@/lib/types';
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

type StickerPoint = { x: number; y: number };

interface TextOnlyStoryCanvasProps {
  userId: string;
  currentProfile: Profile | null;
  storyText: string;
  textLayers: StoryTimedText[];
  onUpdateImageSticker: (id: string, update: StoryImageStickerUpdate) => void;
  draggingStoryStickerId: string | null;
  storyStickerOverDeleteZone: boolean;
  onStoryStickerDragChange: (id: string, dragging: boolean, overDeleteZone: boolean) => void;
  onClose: () => void;
  onActivateImageSticker: (id: string) => void;
  onCanvasTap: (id?: string) => void;
  fontFamily: string;
  textColor: string;
  textAlign: StoryTextAlign;
  textAnimation: StoryTextAnimation;
  textBackgroundPreset: StoryTextBackgroundPreset;
  canvasBackground: string;
  storyTextOffset: { x: number; y: number };
  storyTextScale: number;
  storyTextFontSize: number;
  storyTextRotation: number;
  storyAlignmentGuides: { vertical: boolean; horizontal: boolean };
  editorOpen: boolean;
  keyboardInset: number;
  animationTick: number;
  previewClassName: string;
  editorPreviewMode: boolean;
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
  onPublish: (closeFriends: boolean) => void;
  onOpenTextEditor: (id?: string) => void;
  onFinishEditing: () => void;
  onTextChange: (value: string) => void;
  onFontFamilyChange: (family: string) => void;
  onTextColorChange: (color: string) => void;
  onCycleAlign: () => void;
  onCycleTextBackground: () => void;
  onAnimationChange: (animation: StoryTextAnimation) => void;
  onTextFontSizeChange: (fontSize: number) => void;
  onTextTransformChange: (transform: { x: number; y: number; scale: number; rotation: number }) => void;
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
  { label: 'أسود ملكي', value: '#000000' },
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
  currentProfile,
  storyText,
  textLayers,
  onUpdateImageSticker,
  draggingStoryStickerId,
  storyStickerOverDeleteZone,
  onStoryStickerDragChange,
  onClose,
  onActivateImageSticker,
  onCanvasTap,
  fontFamily,
  textColor,
  textAlign,
  textAnimation,
  textBackgroundPreset,
  canvasBackground,
  storyTextOffset,
  storyTextScale,
  storyTextFontSize,
  storyTextRotation,
  storyAlignmentGuides,
  editorOpen,
  keyboardInset,
  animationTick,
  previewClassName,
  editorPreviewMode,
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
  onPublish,
  onOpenTextEditor,
  onFinishEditing,
  onTextChange,
  onFontFamilyChange,
  onTextColorChange,
  onCycleAlign,
  onCycleTextBackground,
  onAnimationChange,
  onTextFontSizeChange,
  onTextTransformChange,
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
  const stickerDeleteZoneRef = useRef<HTMLDivElement | null>(null);
  const isPointerOverDeleteZone = (point: StickerPoint) => {
    const bounds = stickerDeleteZoneRef.current?.getBoundingClientRect();
    return Boolean(bounds
      && point.x >= bounds.left && point.x <= bounds.right
      && point.y >= bounds.top && point.y <= bounds.bottom);
  };
  const [backgroundPickerOpen, setBackgroundPickerOpen] = useState(false);
  const lastCanvasTouchRef = useRef(0);
  const handleCanvasTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    lastCanvasTouchRef.current = Date.now();
    if (backgroundPickerOpen) {
      setBackgroundPickerOpen(false);
      return;
    }
    onCanvasTouchEnd(event);
  };

  return (
    <div className="aani-page-enter fixed inset-0 z-[140] overflow-hidden bg-black text-white" dir="rtl">
      <div
        className="absolute inset-0 overflow-hidden"
        onTouchStart={onCanvasTouchStart}
        onTouchMove={onCanvasTouchMove}
        onTouchEnd={handleCanvasTouchEnd}
        onTouchCancel={onCanvasTouchEnd}
        style={{ touchAction: 'none' }}
      >
        <div
          className="absolute inset-0"
          style={{ background: canvasBackground, filter: storyFilterValue }}
          onClick={event => {
            if (event.target !== event.currentTarget || Date.now() - lastCanvasTouchRef.current <= 500) return;
            if (backgroundPickerOpen) {
              setBackgroundPickerOpen(false);
              return;
            }
            onCanvasTap();
          }}
        />
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

        {textLayers.map((layer, index) => {
          const layerOrder = layer.layerOrder ?? index + 10;
          if (layer.type === 'image') {
            return (
              <StoryImageSticker
                key={layer.id}
                sticker={layer}
                layerOrder={layerOrder}
                onChange={update => onUpdateImageSticker(layer.id, update)}
                onActivate={() => onActivateImageSticker(layer.id)}
                onDragMove={point => onStoryStickerDragChange(layer.id, true, isPointerOverDeleteZone(point))}
                onDragEnd={(point, cancelled) => onStoryStickerDragChange(
                  layer.id,
                  false,
                  !cancelled && isPointerOverDeleteZone(point),
                )}
              />
            );
          }
          if (layer.type === 'drawing' || layer.type === 'canvas-style' || layer.type === 'media-transform') return null;

          return (
            <button
              key={layer.id}
              type="button"
              data-story-text="true"
              data-story-text-id={layer.id}
              onClick={event => {
                event.stopPropagation();
                if (Date.now() - lastCanvasTouchRef.current > 500) onOpenTextEditor(layer.id);
              }}
              dir="rtl"
              className="absolute z-10 w-[90vw] max-w-[90vw] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-3xl font-bold leading-snug text-shadow-lg"
              style={{
                left: `${layer.x}%`,
                top: `${layer.y}%`,
                transform: `translate(-50%, -50%) scale(${layer.scale ?? 1}) rotate(${layer.rotation ?? 0}deg)`,
                zIndex: layerOrder,
                fontFamily: layer.fontFamily || 'Cairo',
                fontSize: layer.fontSize ?? 30,
                color: layer.textColor || '#FFFFFF',
                textAlign: layer.textAlign || 'center',
                overflowWrap: 'anywhere',
                lineHeight: 1.35,
                background: layer.textBackground || 'transparent',
                textShadow: '0 2px 14px rgba(0,0,0,0.42)',
              }}
            >
              <span className={layer.textAnimation && layer.textAnimation !== 'none' ? `aani-story-anim-${layer.textAnimation}` : undefined}>
                {layer.text}
              </span>
            </button>
          );
        })}

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

      <StoryAlignmentGuides vertical={storyAlignmentGuides.vertical} horizontal={storyAlignmentGuides.horizontal} />

      <div
        ref={stickerDeleteZoneRef}
        aria-hidden={!draggingStoryStickerId}
        className={`pointer-events-none absolute z-[100] flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-full border text-white shadow-2xl backdrop-blur-md transition-colors duration-150 ${draggingStoryStickerId ? 'opacity-100' : 'opacity-0'} ${storyStickerOverDeleteZone ? 'border-red-200 bg-red-600' : 'border-white/25 bg-black/75'}`}
        style={{ left: '1.25rem', bottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        <Trash2 size={22} />
        <span className="text-[9px] font-bold">حذف</span>
      </div>

      <button
        type="button"
        onClick={() => setBackgroundPickerOpen(open => !open)}
        aria-label="تغيير خلفية لوحة القصة"
        aria-expanded={backgroundPickerOpen}
        className="fixed left-4 top-[calc(4.25rem+env(safe-area-inset-top))] z-[120] flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white shadow-lg backdrop-blur-md"
      >
        <Paintbrush size={17} />
      </button>
      {backgroundPickerOpen && (
        <div
          className="fixed left-4 top-[calc(7.25rem+env(safe-area-inset-top))] z-[120] w-52 rounded-2xl border border-white/15 bg-[#101014]/95 p-3 shadow-2xl backdrop-blur-xl"
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
        onClose={onClose}
        onToggleMore={onToggleMore}
        onDurationChange={onDurationChange}
      />

      {(storyFiltersOpen || storyDrawingOpen || storyMusicTrack) && (
        <div
          className="fixed inset-x-3 z-[120] pointer-events-none"
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

      <StoryTextEditorPanel
        storyTextEditorOpen={editorOpen}
        storyText={storyText}
        storyKeyboardInset={keyboardInset}
        storyEditorPreviewMode={editorPreviewMode}
        storyAnimationTick={animationTick}
        storyPreviewClassName={previewClassName}
        storyTextAnimation={textAnimation}
        storyTextFontSize={storyTextFontSize}
        storyAlignmentGuides={storyAlignmentGuides}
        storyFontFamily={fontFamily}
        storyTextColor={textColor}
        storyTextAlign={textAlign}
        storyTextLayerWidth="90vw"
        storyTextTransform={{
          x: storyTextOffset.x,
          y: storyTextOffset.y,
          scale: storyTextScale,
          rotation: storyTextRotation,
        }}
        storyHasBackground={textBackgroundPreset.key !== 'none'}
        storyBackgroundPreset={textBackgroundPreset}
        storyTextAreaRef={textAreaRef}
        onCloseStory={onClose}
        onStoryTextChange={onTextChange}
        onFinishTextEditing={onFinishEditing}
        onFontFamilyChange={onFontFamilyChange}
        onTextColorChange={onTextColorChange}
        onCycleAlign={onCycleAlign}
        onCycleBackground={onCycleTextBackground}
        onAnimationChange={onAnimationChange}
        onTextFontSizeChange={onTextFontSizeChange}
        onTextTransformChange={onTextTransformChange}
        onInteract={onInteract}
      />

      <div
        className="fixed inset-x-0 bottom-0 z-[120] pointer-events-none px-4 pt-2"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-stretch gap-2.5">
          <button
            type="button"
            onClick={() => onPublish(false)}
            disabled={uploading || (!textLayers.length && !storyText.trim())}
            className="pointer-events-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white px-3 text-[12px] font-bold text-[#121212] shadow-lg transition hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40"
          >
            {currentProfile?.avatar_url ? (
              <img src={currentProfile.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-white">
                {displayName(currentProfile).replace('@', '').charAt(0)}
              </span>
            )}
            {uploading ? 'جارٍ النشر...' : 'قصتك'}
          </button>
          <button
            type="button"
            onClick={() => onPublish(true)}
            disabled={uploading || (!textLayers.length && !storyText.trim())}
            className="pointer-events-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/60 bg-black/40 px-3 text-[12px] font-bold text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-[0.98] disabled:opacity-40"
          >
            <Star size={15} style={{ color: '#4CAF50' }} fill="#4CAF50" />
            الأصدقاء المقربون
          </button>
        </div>
      </div>

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
