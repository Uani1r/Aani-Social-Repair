import { useRef, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Star, Trash2, X } from 'lucide-react';

import CloseFriendsSheet from '@/components/CloseFriendsSheet';
import Avatar from '@/components/Avatar';
import { StoryDrawingOverlay, StoryEditorPanels, StoryEditorToolbar, StoryTextEditorPanel, type StoryEditorToolKey } from '@/components/StoryEditorTools';
import StoryCropOverlay, { type StoryCropApplyResult } from '@/components/StoryCropOverlay';
import type { StoryDrawTool } from '@/lib/appShared';
import StoryImageSticker from '@/components/StoryImageSticker';
import StoryAlignmentGuides from '@/components/StoryAlignmentGuides';
import { displayName, type Profile } from '@/lib/types';
import type { StoryAdjustments } from '@/lib/storyFilters';
import type { StoryTextAlign, StoryTextAnimation } from '@/lib/storyFonts';
import StoryMusicSheet from '@/components/StoryMusicSheet';
import StoryMentionPicker, { type MentionCandidate } from '@/components/StoryMentionPicker';
import StoryErrorDiagnosticPanel from '@/components/story/StoryErrorDiagnosticPanel';
import type { StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import type { StoryImageStickerUpdate, StoryTimedText } from '@/components/stories/types';
import type { MusicTrack } from '@/lib/music';

type Point = { x: number; y: number };
type StoryEditorExtraTool = { key: string; label: string; action: () => void };
type StoryBackgroundPreset = { background: string };
type StoryFilterOverlay = { color: string; opacity: number; blend: string };

type StoryCreationEditorProps = {
  editorMediaUrl: string | null;
  editorIsVideo: boolean;
  reshareStory: StoryDmCardStory | null;
  reshareScaledDown: boolean;
  currentProfile: Profile | null;
  storyCanvasOffset: Point;
  storyCanvasScale: number;
  storyMediaOffset: Point;
  storyMediaZoom: number;
  storyMediaRotate: number;
  storyFilterValue: string;
  storyFilterOverlay?: StoryFilterOverlay | null;
  storyText: string;
  storyTextLayers: StoryTimedText[];
  storyTextEditorOpen: boolean;
  storyTextAnimation: StoryTextAnimation;
  storyTextOffset: Point;
  storyTextScale: number;
  storyTextRotation: number;
  storyTextFontSize: number;
  storyAlignmentGuides: { vertical: boolean; horizontal: boolean };
  storyFontFamily: string;
  storyTextColor: string;
  storyTextAlign: StoryTextAlign;
  storyHasBackground: boolean;
  storyBackgroundPreset: StoryBackgroundPreset;
  visibleStoryText: string;
  storyDrawingOpen: boolean;
  storyDrawTool: StoryDrawTool;
  storyCropOpen: boolean;
  storyDrawingCanvasRef: { current: HTMLCanvasElement | null };
  storyToolsRef: { current: HTMLDivElement | null };
  storyMoreOpen: boolean;
  storyDurationOpen: boolean;
  storyExtraTools: StoryEditorExtraTool[];
  uploadDuration: number;
  storyKeyboardInset: number;
  storyEditorPreviewMode: boolean;
  storyAnimationTick: number;
  storyPreviewClassName: string;
  storyTextAreaRef: { current: HTMLTextAreaElement | null };
  storyFiltersOpen: boolean;
  storyFilterId: string;
  storyFilterAdjustments: StoryAdjustments;
  storyMusicTrack: { id: string; title: string; artist: string } | null;
  storyDrawColor: string;
  storyDrawSize: number;
  storyDrawStrokesCount: number;
  storyFile: File | null;
  uploading: boolean;
  userId: string;
  storyMusicOpen: boolean;
  storyMentionsOpen: boolean;
  closeFriendsOpen: boolean;
  onCloseMusic: () => void;
  onSelectMusic: (track: MusicTrack) => void;
  onClearMusic?: () => void;
  onCloseMentions: () => void;
  onConfirmMentions: (people: MentionCandidate[]) => void;
  onCloseCloseFriends: () => void;
  onClose: () => void;
  onMediaClick: () => void;
  onCreateTextLayer: () => void;
  onEditTextLayer: (id: string) => void;
  onUpdateImageSticker: (id: string, update: StoryImageStickerUpdate) => void;
  onActivateImageSticker: (id: string) => void;
  draggingStoryStickerId: string | null;
  storyStickerOverDeleteZone: boolean;
  onStoryStickerDragChange: (id: string, dragging: boolean, overDeleteZone: boolean) => void;
  onVideoMetadata: (durationSeconds: number) => void;
  onCanvasTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onCanvasTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onCanvasTouchEnd: (event: ReactTouchEvent<HTMLDivElement>) => void;
  onDrawPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onDrawPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onDrawPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onSelectStoryTool: (key: StoryEditorToolKey) => void;
  onToggleMore: () => void;
  onDurationChange: (duration: number) => void;
  onStoryTextChange: (value: string) => void;
  onFinishTextEditing: () => void;
  onTextFontSizeChange: (fontSize: number) => void;
  onTextTransformChange: (transform: { x: number; y: number; scale: number; rotation: number }) => void;
  onFontFamilyChange: (family: string) => void;
  onTextColorChange: (color: string) => void;
  onCycleAlign: () => void;
  onCycleBackground: () => void;
  onAnimationChange: (animation: StoryTextAnimation) => void;
  onInteract: () => void;
  onSelectFilter: (id: string) => void;
  onAdjustFilter: (key: keyof StoryAdjustments, value: number) => void;
  onResetFilters: () => void;
  onCloseFilters: () => void;
  onDrawColorChange: (color: string) => void;
  onDrawSizeChange: (size: number) => void;
  onDrawToolChange: (tool: StoryDrawTool) => void;
  onUndoDrawing: () => void;
  onCloseDrawing: () => void;
  onCloseCrop: () => void;
  onApplyCrop: (result: StoryCropApplyResult) => void;
  onQuickPublish: (closeFriends: boolean) => void;
};

export default function StoryCreationEditor({
  editorMediaUrl,
  editorIsVideo,
  reshareStory,
  reshareScaledDown,
  currentProfile,
  storyCanvasOffset,
  storyCanvasScale,
  storyMediaOffset,
  storyMediaZoom,
  storyMediaRotate,
  storyFilterValue,
  storyFilterOverlay,
  storyText,
  storyTextLayers,
  storyTextEditorOpen,
  storyTextAnimation,
  storyTextOffset,
  storyTextScale,
  storyTextRotation,
  storyTextFontSize,
  storyAlignmentGuides,
  storyFontFamily,
  storyTextColor,
  storyTextAlign,
  storyHasBackground,
  storyBackgroundPreset,
  visibleStoryText,
  storyDrawingOpen,
  storyDrawTool,
  storyCropOpen,
  storyDrawingCanvasRef,
  storyToolsRef,
  storyMoreOpen,
  storyDurationOpen,
  storyExtraTools,
  uploadDuration,
  storyKeyboardInset,
  storyEditorPreviewMode,
  storyAnimationTick,
  storyPreviewClassName,
  storyTextAreaRef,
  storyFiltersOpen,
  storyFilterId,
  storyFilterAdjustments,
  storyMusicTrack,
  storyDrawColor,
  storyDrawSize,
  storyDrawStrokesCount,
  storyFile,
  uploading,
  userId,
  storyMusicOpen,
  storyMentionsOpen,
  closeFriendsOpen,
  onCloseMusic,
  onSelectMusic,
  onClearMusic,
  onCloseMentions,
  onConfirmMentions,
  onCloseCloseFriends,
  onClose,
  onMediaClick,
  onCreateTextLayer,
  onEditTextLayer,
  onUpdateImageSticker,
  onActivateImageSticker,
  draggingStoryStickerId,
  storyStickerOverDeleteZone,
  onStoryStickerDragChange,
  onVideoMetadata,
  onCanvasTouchStart,
  onCanvasTouchMove,
  onCanvasTouchEnd,
  onDrawPointerDown,
  onDrawPointerMove,
  onDrawPointerUp,
  onSelectStoryTool,
  onToggleMore,
  onDurationChange,
  onStoryTextChange,
  onFinishTextEditing,
  onTextFontSizeChange,
  onTextTransformChange,
  onFontFamilyChange,
  onTextColorChange,
  onCycleAlign,
  onCycleBackground,
  onAnimationChange,
  onInteract,
  onSelectFilter,
  onAdjustFilter,
  onResetFilters,
  onCloseFilters,
  onDrawColorChange,
  onDrawSizeChange,
  onDrawToolChange,
  onUndoDrawing,
  onCloseDrawing,
  onCloseCrop,
  onApplyCrop,
  onQuickPublish,
}: StoryCreationEditorProps) {
  const stickerDeleteZoneRef = useRef<HTMLDivElement | null>(null);
  const isPointerOverDeleteZone = (point: Point) => {
    const bounds = stickerDeleteZoneRef.current?.getBoundingClientRect();
    return Boolean(bounds
      && point.x >= bounds.left && point.x <= bounds.right
      && point.y >= bounds.top && point.y <= bounds.bottom);
  };

  return (
    <div
      className="aani-page-enter fixed inset-0 z-[130] overflow-hidden bg-black text-white"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="معاينة القصة"
    >
      {/* الوسيط يملأ الشاشة بالكامل، والنص داخل لوحة تُسحب وتُكبَّر كوحدة واحدة */}
      {editorMediaUrl ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          onClick={event => {
            const target = event.target as HTMLElement | null;
            if (reshareStory || storyDrawingOpen || target?.closest('[data-story-text], button, input, textarea')) return;
            onCreateTextLayer();
          }}
          onTouchStart={onCanvasTouchStart}
          onTouchMove={onCanvasTouchMove}
          onTouchEnd={onCanvasTouchEnd}
          onTouchCancel={onCanvasTouchEnd}
          style={{ touchAction: 'none' }}
        >
          <div
            className={reshareStory
              ? 'relative overflow-hidden rounded-[28px] transition-[width,height,border-radius] duration-300'
              : 'absolute inset-0'}
            onClick={event => {
              event.stopPropagation();
              onMediaClick();
            }}
            style={reshareStory ? {
              width: reshareScaledDown ? 'min(78vw, 360px)' : '100vw',
              height: reshareScaledDown ? '76vh' : '100dvh',
              transform: `translate3d(${storyCanvasOffset.x}px, ${storyCanvasOffset.y}px, 0) scale(${storyCanvasScale})`,
            } : {
              transform: `translate3d(${storyCanvasOffset.x}px, ${storyCanvasOffset.y}px, 0) scale(${storyCanvasScale})`,
            }}
          >
            {/* الصورة: تُقفل الإيماءة عليها إذا بدأ اللمس منها */}
            {editorIsVideo ? (
              <video
                src={editorMediaUrl}
                autoPlay
                loop
                playsInline
                // كتم صوت الفيديو الأصلي عند وجود صوت مختار كي يُسمع الصوت المختار فقط
                muted={Boolean(storyMusicTrack)}
                onLoadedMetadata={event => onVideoMetadata(Number(event.currentTarget.duration))}
                data-story-media="true"
                className="h-full w-full object-cover"
                style={{
                  touchAction: 'none',
                  filter: storyFilterValue,
                  transform: `translate(${storyMediaOffset.x}px, ${storyMediaOffset.y}px) scale(${storyMediaZoom}) rotate(${storyMediaRotate}deg)`,
                }}
              />
            ) : (
              <img
                src={editorMediaUrl}
                alt=""
                data-story-media="true"
                className="h-full w-full object-cover"
                style={{
                  touchAction: 'none',
                  filter: storyFilterValue,
                  transform: `translate(${storyMediaOffset.x}px, ${storyMediaOffset.y}px) scale(${storyMediaZoom}) rotate(${storyMediaRotate}deg)`,
                }}
              />
            )}

            {/* طبقة لون الفلتر */}
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

            {/* طبقة تعتيم متدرجة لإبراز الأدوات فوق الصورة */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.78) 100%)',
              }}
            />

            {/* كل عبارة طبقة مستقلة؛ النقر يفتح تحرير هذه الطبقة فقط */}
            {storyTextLayers.map((layer, index) => {
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
                <div key={layer.id} className="pointer-events-none absolute inset-0" dir="rtl">
                  <button
                    type="button"
                    data-story-text="true"
                    data-story-text-id={layer.id}
                    onClick={event => {
                      event.stopPropagation();
                      onEditTextLayer(layer.id);
                    }}
                    className={`pointer-events-auto absolute w-[82vw] max-w-[82vw] cursor-grab whitespace-pre-wrap break-words rounded-lg px-2 py-1 text-3xl font-bold active:cursor-grabbing ${layer.textAnimation && layer.textAnimation !== 'none' ? `aani-story-anim-${layer.textAnimation}` : ''}`}
                    style={{
                      left: `${layer.x}%`,
                      top: `${layer.y}%`,
                      touchAction: 'none',
                      transform: `translate(-50%, -50%) scale(${layer.scale ?? 1}) rotate(${layer.rotation ?? 0}deg)`,
                      zIndex: layerOrder,
                      fontFamily: layer.fontFamily || 'Cairo',
                      color: layer.textColor || '#FFFFFF',
                      fontSize: layer.fontSize ?? 30,
                      textAlign: layer.textAlign || 'center',
                      overflowWrap: 'anywhere',
                      lineHeight: 1.35,
                      background: layer.textBackground || 'transparent',
                      textShadow: '0 2px 14px rgba(0,0,0,0.9)',
                    }}
                  >
                    {layer.text}
                  </button>
                </div>
              );
            })}
            <canvas
              ref={storyDrawingCanvasRef}
              aria-label="لوحة الرسم على الستوري"
              className={`absolute inset-0 z-10 h-full w-full ${storyDrawingOpen ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
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
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-400">
          اختر وسيطاً من الاستوديو لعرضه هنا
        </div>
      )}

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

      {/* الشريط العلوي */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex items-center justify-between px-4 py-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق معاينة القصة"
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-xl border border-red-300/35 bg-red-500/20 text-red-100 shadow-lg backdrop-blur-md transition hover:bg-red-500/30 active:scale-95"
        >
          <X size={22} />
        </button>
        {reshareStory ? (
          <div className="flex min-w-0 flex-col items-center gap-1">
            <div className="flex items-center gap-1.5 text-white">
              <Avatar profile={currentProfile} />
              <span className="max-w-[42vw] truncate text-[11px] font-bold">{displayName(currentProfile)}</span>
            </div>
            <div className="flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-white/85 backdrop-blur-sm">
              {reshareStory.author?.avatar_url ? (
                <img src={reshareStory.author.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
              ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[7px] font-bold">
                  {displayName(reshareStory.author).replace('@', '').charAt(0)}
                </span>
              )}
              <span className="max-w-[48vw] truncate text-[9px]">
                من قصة {displayName(reshareStory.author)}
              </span>
            </div>
          </div>
        ) : (
          <span className="text-[13px] font-semibold text-white/85">معاينة القصة</span>
        )}
        <span className="w-9" />
      </div>

      {!storyDrawingOpen && !storyCropOpen && (
        <StoryEditorToolbar
          storyToolsRef={storyToolsRef}
          storyMoreOpen={storyMoreOpen}
          storyDurationOpen={storyDurationOpen}
          storyExtraTools={storyExtraTools}
          uploadDuration={uploadDuration}
          onSelectTool={onSelectStoryTool}
          onToggleMore={onToggleMore}
          onDurationChange={onDurationChange}
        />
      )}

      <StoryTextEditorPanel
        storyTextEditorOpen={storyTextEditorOpen}
        storyText={storyText}
        storyKeyboardInset={storyKeyboardInset}
        storyEditorPreviewMode={storyEditorPreviewMode}
        storyAnimationTick={storyAnimationTick}
        storyPreviewClassName={storyPreviewClassName}
        storyTextAnimation={storyTextAnimation}
        storyTextFontSize={storyTextFontSize}
        storyAlignmentGuides={storyAlignmentGuides}
        storyTextTransform={{
          x: storyTextOffset.x,
          y: storyTextOffset.y,
          scale: storyTextScale,
          rotation: storyTextRotation,
        }}
        storyFontFamily={storyFontFamily}
        storyTextColor={storyTextColor}
        storyTextAlign={storyTextAlign}
        storyTextLayerWidth="82vw"
        storyHasBackground={storyHasBackground}
        storyBackgroundPreset={storyBackgroundPreset}
        storyTextAreaRef={storyTextAreaRef}
        onCloseStory={onClose}
        onStoryTextChange={onStoryTextChange}
        onFinishTextEditing={onFinishTextEditing}
        onTextFontSizeChange={onTextFontSizeChange}
        onTextTransformChange={onTextTransformChange}
        onFontFamilyChange={onFontFamilyChange}
        onTextColorChange={onTextColorChange}
        onCycleAlign={onCycleAlign}
        onCycleBackground={onCycleBackground}
        onAnimationChange={onAnimationChange}
        onInteract={onInteract}
      />

      {/* أسفل الشاشة: قصتك (يمين) + الأصدقاء المقربون (يسار) */}
      {!storyDrawingOpen && !storyCropOpen && (
        <div className="fixed inset-x-0 bottom-0 z-[120] pointer-events-none px-4 pt-2" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <StoryEditorPanels
          storyFiltersOpen={storyFiltersOpen}
          editorMediaUrl={editorMediaUrl}
          editorIsVideo={editorIsVideo}
          storyFilterId={storyFilterId}
          storyFilterAdjustments={storyFilterAdjustments}
          storyMusicTrack={storyMusicTrack}
          onClearMusic={onClearMusic}
          onSelectFilter={onSelectFilter}
          onAdjustFilter={onAdjustFilter}
          onResetFilters={onResetFilters}
          onCloseFilters={onCloseFilters}
        />
        <div className="flex items-stretch gap-2.5">
          <button
            type="button"
            onClick={() => onQuickPublish(false)}
            disabled={uploading || (!storyFile && !reshareStory?.media_url)}
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
            onClick={() => onQuickPublish(true)}
            disabled={uploading || (!storyFile && !reshareStory?.media_url)}
            className="pointer-events-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/60 bg-black/40 px-3 text-[12px] font-bold text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-[0.98] disabled:opacity-40"
          >
            <Star size={15} style={{ color: '#4CAF50' }} fill="#4CAF50" />
            الأصدقاء المقربون
          </button>
        </div>
        </div>
      )}
      <StoryDrawingOverlay
        open={storyDrawingOpen}
        color={storyDrawColor}
        size={storyDrawSize}
        tool={storyDrawTool}
        strokesCount={storyDrawStrokesCount}
        onColorChange={onDrawColorChange}
        onSizeChange={onDrawSizeChange}
        onToolChange={onDrawToolChange}
        onUndo={onUndoDrawing}
        onDone={onCloseDrawing}
      />
      {storyCropOpen && editorMediaUrl && (
        <StoryCropOverlay
          mediaUrl={editorMediaUrl}
          isVideo={editorIsVideo}
          initialZoom={storyMediaZoom}
          initialOffset={storyMediaOffset}
          initialRotation={storyMediaRotate}
          onCancel={onCloseCrop}
          onApply={onApplyCrop}
        />
      )}
      <StoryMusicSheet
        open={storyMusicOpen}
        onClose={onCloseMusic}
        onSelect={onSelectMusic}
      />
      <StoryMentionPicker
        open={storyMentionsOpen}
        currentUserId={userId}
        onClose={onCloseMentions}
        onConfirm={onConfirmMentions}
      />
      <CloseFriendsSheet
        open={closeFriendsOpen}
        currentUserId={userId}
        onClose={onCloseCloseFriends}
      />
      {/* لوحة تشخيص نشر القصص — Portal مستقل، للتطوير فقط (لا تظهر في الإنتاج) */}
      {import.meta.env.DEV && <StoryErrorDiagnosticPanel />}
    </div>
  );
}
