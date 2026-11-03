import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AtSign, ChevronDown, Clock, ImagePlus, Music2, Pencil, Sparkles, Star, Type, X } from 'lucide-react';

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
  onClose: () => void;
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
  onClose,
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
      className="fixed right-2.5 z-[120] flex pointer-events-none flex-col items-center gap-2.5"
      style={{ top: 'calc(3.75rem + env(safe-area-inset-top))' }}
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onPointerCancel={event => event.stopPropagation()}
      onTouchStart={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
      onTouchEnd={event => event.stopPropagation()}
      onTouchCancel={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="إغلاق محرر القصة"
        title="إغلاق"
        onClick={onClose}
        className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
      >
        <X size={17} />
      </button>
      {tools.map(tool => {
        const Icon = tool.icon;
        return (
          <button
            key={tool.key}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onClick={() => onSelectTool(tool.key)}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
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
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
        >
          <ChevronDown
            size={17}
            className={`transition-transform duration-200 ${storyMoreOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {storyMoreOpen && (
          <div
            className="pointer-events-auto absolute left-1/2 top-full z-[130] mt-2 flex w-9 -translate-x-1/2 flex-col items-stretch gap-1 rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur-xl"
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
                    className={`pointer-events-auto flex h-9 w-full items-center justify-center rounded-lg transition hover:bg-white/10 ${item.key === 'close-friends' ? 'text-emerald-400' : 'text-white/85'}`}
                  >
                    <Icon size={19} fill={item.key === 'close-friends' ? 'currentColor' : 'none'} />
                  </button>
                  {item.key === 'duration' && storyDurationOpen && (
                    <div className="pointer-events-auto absolute right-full top-0 z-[140] mr-2">
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

type StoryTextTransform = { x: number; y: number; scale: number; rotation: number };

type StoryTextGesture = StoryTextTransform & {
  active: boolean;
  touchCount: number;
  startX: number;
  startY: number;
  startDistance: number;
  startAngle: number;
  startedOnTextarea: boolean;
  startTime: number;
};

type StoryTextEditorPanelProps = {
  storyTextEditorOpen: boolean;
  storyText: string;
  storyKeyboardInset: number;
  storyEditorPreviewMode: boolean;
  storyAnimationTick: number;
  storyPreviewClassName: string;
  storyTextAnimation: StoryTextAnimation;
  storyTextFontSize?: number;
  storyFontFamily: string;
  storyTextColor: string;
  storyTextAlign: StoryTextAlign;
  storyTextTransform?: StoryTextTransform;
  storyHasBackground: boolean;
  storyBackgroundPreset: StoryBackgroundPreset;
  storyTextAreaRef: { current: HTMLTextAreaElement | null };
  onCloseStory: () => void;
  onStoryTextChange: (value: string) => void;
  onFinishTextEditing: () => void;
  onFontFamilyChange: (family: string) => void;
  onTextColorChange: (color: string) => void;
  onCycleAlign: () => void;
  onCycleBackground: () => void;
  onAnimationChange: (animation: StoryTextAnimation) => void;
  onTextFontSizeChange?: (fontSize: number) => void;
  onTextTransformChange?: (transform: StoryTextTransform) => void;
  onTextTransformGestureEnd?: () => void;
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
  storyTextFontSize,
  storyFontFamily,
  storyTextColor,
  storyTextAlign,
  storyTextTransform,
  storyHasBackground,
  storyBackgroundPreset,
  storyTextAreaRef,
  onCloseStory,
  onStoryTextChange,
  onFinishTextEditing,
  onFontFamilyChange,
  onTextColorChange,
  onCycleAlign,
  onCycleBackground,
  onAnimationChange,
  onTextFontSizeChange,
  onTextTransformChange,
  onTextTransformGestureEnd,
  onInteract,
}: StoryTextEditorPanelProps) {
  const textGestureRef = useRef<StoryTextGesture | null>(null);
  const fontSizePointerIdRef = useRef<number | null>(null);
  const lastTextGestureAtRef = useRef(0);
  const activeTransform = storyTextTransform || { x: 0, y: 0, scale: 1, rotation: 0 };
  const latestTransformRef = useRef<StoryTextTransform>(activeTransform);

  useEffect(() => {
    latestTransformRef.current = { ...activeTransform };
  }, [activeTransform.x, activeTransform.y, activeTransform.scale, activeTransform.rotation]);

  useEffect(() => {
    if (!storyTextEditorOpen || storyTextFontSize === undefined) return;
    const field = storyTextAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [storyTextEditorOpen, storyTextFontSize, storyTextAreaRef]);

  if (!storyTextEditorOpen) return null;

  const minFontSize = 12;
  const maxFontSize = 96;
  const activeFontSize = Math.min(maxFontSize, Math.max(minFontSize, storyTextFontSize ?? 30));
  const currentTransform = (): StoryTextTransform => ({ ...latestTransformRef.current });
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  const updateFontSizeFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, 1 - (event.clientY - bounds.top) / bounds.height));
    onTextFontSizeChange?.(minFontSize + progress * (maxFontSize - minFontSize));
  };
  const handleFontSizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    fontSizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFontSizeFromPointer(event);
  };
  const handleFontSizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (fontSizePointerIdRef.current !== event.pointerId) return;
    event.stopPropagation();
    updateFontSizeFromPointer(event);
  };
  const handleFontSizePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (fontSizePointerIdRef.current !== event.pointerId) return;
    event.stopPropagation();
    fontSizePointerIdRef.current = null;
  };
  const handleFontSizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const increments: Record<string, number> = {
      ArrowUp: 2,
      ArrowRight: 2,
      ArrowDown: -2,
      ArrowLeft: -2,
      PageUp: 10,
      PageDown: -10,
    };
    if (event.key === 'Home') {
      event.preventDefault();
      onTextFontSizeChange?.(minFontSize);
    } else if (event.key === 'End') {
      event.preventDefault();
      onTextFontSizeChange?.(maxFontSize);
    } else if (increments[event.key]) {
      event.preventDefault();
      onTextFontSizeChange?.(Math.min(maxFontSize, Math.max(minFontSize, activeFontSize + increments[event.key])));
    }
  };
  const emitTransform = (transform: StoryTextTransform) => {
    latestTransformRef.current = transform;
    onTextTransformChange?.(transform);
  };
  const touchMetrics = (touches: React.TouchList) => {
    const first = touches[0];
    const second = touches[1];
    return {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
      distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
      angle: (Math.atan2(second.clientY - first.clientY, second.clientX - first.clientX) * 180) / Math.PI,
    };
  };
  const beginTextGesture = (touches: React.TouchList, base: StoryTextTransform) => {
    const metrics = touchMetrics(touches);
    textGestureRef.current = {
      ...base,
      active: true,
      touchCount: 2,
      startX: metrics.x,
      startY: metrics.y,
      startDistance: metrics.distance,
      startAngle: metrics.angle,
      startedOnTextarea: false,
      startTime: Date.now(),
    };
  };
  const handleTextGestureStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const interactiveTarget = target.closest('input, button, select, [data-story-text-editor-control]');
    if (interactiveTarget) {
      textGestureRef.current = null;
      event.stopPropagation();
      return;
    }

    if (!target.closest('[data-story-text-transform-surface]')) {
      textGestureRef.current = null;
      return;
    }

    if (event.touches.length >= 2) {
      const everyTouchStartedOnText = Array.from(event.touches).every(touch => {
        const touchTarget = touch.target as Element | null;
        return Boolean(touchTarget?.closest('[data-story-text-transform-surface]'));
      });
      if (!everyTouchStartedOnText || !textGestureRef.current) {
        textGestureRef.current = null;
        return;
      }
      beginTextGesture(event.touches, currentTransform());
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const startedOnTextarea = Boolean(target.closest('textarea'));
      textGestureRef.current = {
        ...currentTransform(),
        active: false,
        touchCount: 1,
        startX: touch.clientX,
        startY: touch.clientY,
        startDistance: 0,
        startAngle: 0,
        startedOnTextarea,
        startTime: Date.now(),
      };
    }
  };
  const handleTextGestureMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, button, select, [data-story-text-editor-control]')) {
      event.stopPropagation();
      return;
    }
    const gesture = textGestureRef.current;
    if (!gesture) return;
    if (!gesture.active) {
      if (event.touches.length >= 2) {
        beginTextGesture(event.touches, currentTransform());
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dragDistance = Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
      if (dragDistance < 8 || (gesture.startedOnTextarea && Date.now() - gesture.startTime > 450)) return;
      gesture.active = true;
    }
    if (event.touches.length < 1) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.touches.length !== gesture.touchCount) {
      if (event.touches.length >= 2) {
        const metrics = touchMetrics(event.touches);
        textGestureRef.current = {
          ...currentTransform(),
          active: true,
          touchCount: 2,
          startX: metrics.x,
          startY: metrics.y,
          startDistance: metrics.distance,
          startAngle: metrics.angle,
          startedOnTextarea: false,
          startTime: Date.now(),
        };
      } else {
        const touch = event.touches[0];
        textGestureRef.current = {
          ...currentTransform(),
          active: true,
          touchCount: 1,
          startX: touch.clientX,
          startY: touch.clientY,
          startDistance: 0,
          startAngle: 0,
          startedOnTextarea: false,
          startTime: Date.now(),
        };
      }
      return;
    }

    if (event.touches.length >= 2) {
      const metrics = touchMetrics(event.touches);
      const rawAngle = metrics.angle - gesture.startAngle;
      const angleDelta = ((rawAngle + 540) % 360) - 180;
      const next: StoryTextTransform = {
        x: clamp(gesture.x + metrics.x - gesture.startX, window.innerWidth * 0.45),
        y: clamp(gesture.y + metrics.y - gesture.startY, window.innerHeight * 0.4),
        scale: Math.min(5, Math.max(0.3, gesture.scale * (gesture.startDistance > 0 ? metrics.distance / gesture.startDistance : 1))),
        rotation: gesture.rotation + angleDelta,
      };
      emitTransform(next);
      return;
    }

    const touch = event.touches[0];
    emitTransform({
      ...currentTransform(),
      x: clamp(gesture.x + touch.clientX - gesture.startX, window.innerWidth * 0.45),
      y: clamp(gesture.y + touch.clientY - gesture.startY, window.innerHeight * 0.4),
    });
  };
  const handleTextGestureEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, button, select, [data-story-text-editor-control]')) {
      event.stopPropagation();
      return;
    }
    const gesture = textGestureRef.current;
    if (!gesture) return;
    if (event.touches.length === 0) {
      if (gesture.active) lastTextGestureAtRef.current = Date.now();
      textGestureRef.current = null;
      onTextTransformGestureEnd?.();
      return;
    }
    if (!gesture.active) return;

    if (event.touches.length >= 2) {
      const metrics = touchMetrics(event.touches);
      textGestureRef.current = {
        ...currentTransform(),
        active: true,
        touchCount: 2,
        startX: metrics.x,
        startY: metrics.y,
        startDistance: metrics.distance,
        startAngle: metrics.angle,
        startedOnTextarea: false,
        startTime: Date.now(),
      };
    } else {
      const touch = event.touches[0];
      textGestureRef.current = {
        ...currentTransform(),
        active: true,
        touchCount: 1,
        startX: touch.clientX,
        startY: touch.clientY,
        startDistance: 0,
        startAngle: 0,
        startedOnTextarea: false,
        startTime: Date.now(),
      };
    }
  };

  return (
    <div
      className={`${storyTextTransform ? 'fixed' : 'absolute'} inset-0 z-[110] flex flex-col bg-black/70 backdrop-blur-sm`}
      dir="rtl"
      onTouchStartCapture={event => {
        const target = event.target as HTMLElement;
        if (target.closest('input, button, select, [data-story-text-editor-control]')) {
          textGestureRef.current = null;
        }
      }}
      onTouchStart={onTextTransformChange ? handleTextGestureStart : undefined}
      onTouchMove={onTextTransformChange ? handleTextGestureMove : undefined}
      onTouchEnd={onTextTransformChange ? handleTextGestureEnd : undefined}
      onTouchCancel={onTextTransformChange ? handleTextGestureEnd : undefined}
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onPointerCancel={event => event.stopPropagation()}
      onClick={event => {
        if (Date.now() - lastTextGestureAtRef.current < 500) return;
        if (event.target === event.currentTarget) onFinishTextEditing();
      }}
    >
      <div
        className={`${storyTextTransform ? 'pointer-events-none relative z-[60]' : ''} flex items-center justify-between px-4 py-3`}
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="إغلاق محرر القصة"
            title="إغلاق القصة"
            onClick={onCloseStory}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white transition active:scale-95"
          >
            <X size={18} />
          </button>
          <span className="text-[12px] text-white/60">محرر النص</span>
        </div>
        <button
          type="button"
          onClick={onFinishTextEditing}
          className="pointer-events-auto rounded-full bg-white px-4 py-1.5 text-[12px] font-bold text-[#121212]"
        >
          تم
        </button>
      </div>

      {onTextFontSizeChange && (
        <div
          data-story-text-editor-control="true"
          className="pointer-events-auto fixed left-2 top-1/2 z-[70] flex -translate-y-1/2 flex-col items-center gap-2 rounded-full border border-white/15 bg-black/45 px-1.5 py-3 text-[10px] font-bold text-white/80 shadow-xl backdrop-blur-md"
        >
          <span aria-hidden="true">A+</span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="حجم خط الستوري"
            aria-orientation="vertical"
            aria-valuemin={minFontSize}
            aria-valuemax={maxFontSize}
            aria-valuenow={Math.round(activeFontSize)}
            onPointerDown={handleFontSizePointerDown}
            onPointerMove={handleFontSizePointerMove}
            onPointerUp={handleFontSizePointerEnd}
            onPointerCancel={handleFontSizePointerEnd}
            onKeyDown={handleFontSizeKeyDown}
            className="relative flex h-48 w-8 cursor-ns-resize touch-none items-center justify-center outline-none"
            style={{ touchAction: 'none' }}
          >
            <span className="h-full w-1 rounded-full bg-white/25" />
            <span
              className="absolute h-4 w-4 rounded-full border-2 border-white bg-[#4f46e5] shadow-lg"
              style={{ bottom: `${((activeFontSize - minFontSize) / (maxFontSize - minFontSize)) * 100}%` }}
            />
          </div>
          <span aria-hidden="true">A−</span>
        </div>
      )}

      <div className={`flex min-h-[96px] flex-1 items-start justify-center ${storyTextTransform ? 'pl-12 pr-4' : 'px-6'} pt-2`}>
        <div
          className={`relative flex w-full items-start justify-center ${storyTextTransform ? 'z-10 max-w-[90vw]' : 'max-w-md'}`}
          style={storyTextTransform ? {
            width: '90vw',
            maxWidth: '90vw',
            transform: `translate3d(${activeTransform.x}px, ${activeTransform.y}px, 0) scale(${activeTransform.scale}) rotate(${activeTransform.rotation}deg)`,
            transformOrigin: 'center center',
          } : undefined}
        >
          {/* معاينة حيّة للنص بنفس خط/لون/خلفية/حركة القصة */}
          {storyEditorPreviewMode && (
            <p
              key={`${storyTextAnimation}-${storyAnimationTick}`}
              aria-hidden="true"
              className={`${storyPreviewClassName} w-full whitespace-pre-wrap break-words`}
              style={{
                fontFamily: storyFontFamily,
                color: storyTextColor,
                fontSize: activeFontSize,
                textAlign: storyTextAlign,
                direction: 'rtl',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
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
            data-story-text-transform-surface="true"
            autoFocus
            value={storyText}
            onChange={event => onStoryTextChange(event.target.value)}
            placeholder="اكتب شيئاً..."
            dir="rtl"
            rows={3}
            className="relative w-full min-w-0 max-w-none resize-none whitespace-pre-wrap break-words overflow-hidden bg-transparent font-bold outline-none placeholder:text-white/40"
            style={{
              fontFamily: storyFontFamily,
              color: storyEditorPreviewMode ? 'transparent' : storyTextColor,
              caretColor: storyTextColor,
              WebkitTextFillColor: storyEditorPreviewMode ? 'transparent' : storyTextColor,
              fontSize: activeFontSize,
              textAlign: storyTextAlign,
              direction: 'rtl',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
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
        className={`${storyTextTransform ? 'pointer-events-none relative z-[60]' : ''} px-3`}
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
    <div className="pointer-events-none">
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
        <div className="pointer-events-auto mb-3 rounded-2xl border border-white/15 bg-black/75 p-2.5 text-white shadow-xl backdrop-blur-xl" dir="rtl" data-story-editor-control="true" onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
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
    </div>
  );
}
