import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Check, Crop, RotateCw, Sparkles, Sticker, Type, X } from 'lucide-react';

import StoryAlignmentGuides from '@/components/StoryAlignmentGuides';
import StoryCropOverlay from '@/components/StoryCropOverlay';
import { StoryDrawingOverlay } from '@/components/StoryEditorTools';
import StoryFilterBar from '@/components/StoryFilterBar';
import StoryTextToolbar from '@/components/StoryTextToolbar';
import StoryTypedPreview from '@/components/StoryTypedPreview';
import { useStoryViewportLock } from '@/components/stories/useStoryViewportLock';
import { drawStoryStroke, getStoryDrawPoint, type StoryDrawStroke, type StoryDrawTool } from '@/lib/appShared';
import {
  buildStoryFilterCss,
  DEFAULT_ADJUSTMENTS,
  getStoryFilterOverlay,
  type StoryAdjustments,
} from '@/lib/storyFilters';
import {
  nextStoryTextAlign,
  STORY_TEXT_BACKGROUNDS,
  type StoryTextAlign,
  type StoryTextAnimation,
} from '@/lib/storyFonts';

const STICKER_CHOICES = [
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '✨', '🔥', '😂', '🥹',
  '🫶', '🌙', '🌸', '⭐', '🎉', '😎', '🥰', '😍', '🌷', '☀️', '🦋', '🌈',
  '🎂', '🎈', '💫', '💖', '😇', '🙏', '💯', '👑', '💐', '🍓', '☕', '⚡',
  '💬', '🧸', '🐱', '🐶',
];

type Point = { x: number; y: number };
type TextStyle = {
  fontFamily: string;
  textColor: string;
  textAlign: StoryTextAlign;
  textBackground: string;
  fontSize: number;
  animation: StoryTextAnimation;
};
type TextLayer = TextStyle & {
  id: string;
  text: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  order: number;
};
type StickerLayer = {
  id: string;
  value: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  order: number;
};
type LayerKind = 'text' | 'sticker';
type LayerGesture = {
  id: string;
  kind: LayerKind;
  touchCount: number;
  pointerId: number | null;
  startX: number;
  startY: number;
  startDistance: number;
  startAngle: number;
  baseX: number;
  baseY: number;
  baseScale: number;
  baseRotation: number;
  moved: boolean;
};

const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Cairo',
  textColor: '#FFFFFF',
  textAlign: 'center',
  textBackground: STORY_TEXT_BACKGROUNDS[0].background,
  fontSize: 30,
  animation: 'none',
};

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  text.split('\n').forEach(paragraph => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      return;
    }
    let line = '';
    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    lines.push(line);
  });
  return lines;
}

function makeLayerId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getTouchMetrics(touches: TouchList) {
  const first = touches[0];
  const second = touches[1];
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
    angle: (Math.atan2(second.clientY - first.clientY, second.clientX - first.clientX) * 180) / Math.PI,
  };
}

function angleDifference(current: number, start: number): number {
  return ((current - start + 540) % 360) - 180;
}

function drawRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawStoryTextLayer(context: CanvasRenderingContext2D, layer: TextLayer, scaleX: number): void {
  const fontSize = layer.fontSize * scaleX;
  const maxTextWidth = context.canvas.width * 0.82;
  const paddingX = 10 * scaleX;
  const paddingY = 3 * scaleX;
  context.save();
  context.translate(context.canvas.width * (layer.x / 100), context.canvas.height * (layer.y / 100));
  context.rotate((layer.rotation * Math.PI) / 180);
  context.scale(layer.scale, layer.scale);
  context.direction = /[\u0600-\u06ff]/.test(layer.text) ? 'rtl' : 'ltr';
  context.textAlign = layer.textAlign;
  context.textBaseline = 'middle';
  context.font = `700 ${fontSize}px ${layer.fontFamily}, sans-serif`;
  context.shadowColor = 'rgba(0,0,0,.68)';
  context.shadowBlur = 10 * scaleX;

  const lines = wrapText(context, layer.text, Math.max(1, maxTextWidth - paddingX * 2));
  const lineHeight = fontSize * 1.3;
  const contentWidth = Math.min(maxTextWidth - paddingX * 2, Math.max(1, ...lines.map(line => context.measureText(line).width)));
  const blockWidth = Math.min(maxTextWidth, contentWidth + paddingX * 2);
  const blockHeight = lines.length * lineHeight + paddingY * 2;
  const background = layer.textBackground;
  if (background && background !== 'transparent') {
    context.shadowBlur = 0;
    if (background.startsWith('linear-gradient')) {
      const colors = background.match(/#[\da-f]{3,8}/gi) || [];
      if (colors.length >= 2) {
        const gradient = context.createLinearGradient(-blockWidth / 2, 0, blockWidth / 2, 0);
        colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
        context.fillStyle = gradient;
      } else {
        context.fillStyle = 'rgba(0,0,0,.65)';
      }
    } else {
      context.fillStyle = background;
    }
    drawRoundedRect(context, -blockWidth / 2, -blockHeight / 2, blockWidth, blockHeight, 8 * scaleX);
    context.fill();
  }

  context.fillStyle = layer.textColor;
  const textX = layer.textAlign === 'left'
    ? -blockWidth / 2 + paddingX
    : layer.textAlign === 'right'
      ? blockWidth / 2 - paddingX
      : 0;
  const startY = -blockHeight / 2 + paddingY + lineHeight / 2;
  lines.forEach((line, index) => context.fillText(line, textX, startY + index * lineHeight, maxTextWidth - paddingX * 2));
  context.restore();
}

export default function ChatPhotoEditor({
  file,
  quality,
  onCancel,
  onSave,
}: {
  file: File;
  quality: number;
  onCancel: () => void;
  onSave: (file: File) => void;
}) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const layerGestureRef = useRef<LayerGesture | null>(null);
  const suppressLayerClickUntilRef = useRef(0);
  const layerOrderRef = useRef(10);
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [stickerLayers, setStickerLayers] = useState<StickerLayer[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedStickerId, setSelectedStickerId] = useState<string | null>(null);
  const [textEditingId, setTextEditingId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [textOpen, setTextOpen] = useState(false);
  const [textStyle, setTextStyle] = useState<TextStyle>(DEFAULT_TEXT_STYLE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawColor, setDrawColor] = useState('#FFFFFF');
  const [drawSize, setDrawSize] = useState(6);
  const [drawTool, setDrawTool] = useState<StoryDrawTool>('smooth');
  const [strokes, setStrokes] = useState<StoryDrawStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<StoryDrawStroke | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [filterId, setFilterId] = useState('original');
  const [adjustments, setAdjustments] = useState<StoryAdjustments>(DEFAULT_ADJUSTMENTS);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [cropOpen, setCropOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [alignmentGuides, setAlignmentGuides] = useState({ vertical: false, horizontal: false });
  const alignmentGuideTimerRef = useRef<number | null>(null);

  useStoryViewportLock(textOpen);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  useEffect(() => () => {
    if (alignmentGuideTimerRef.current !== null) window.clearTimeout(alignmentGuideTimerRef.current);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateStageSize = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width && bounds.height) {
        setStageSize(current => current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height });
      }
    };
    updateStageSize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateStageSize) : null;
    observer?.observe(stage);
    window.addEventListener('resize', updateStageSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateStageSize);
    };
  }, []);

  useEffect(() => {
    if (!textOpen) {
      setKeyboardInset(0);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateInset = () => setKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    updateInset();
    viewport.addEventListener('resize', updateInset);
    viewport.addEventListener('scroll', updateInset);
    return () => {
      viewport.removeEventListener('resize', updateInset);
      viewport.removeEventListener('scroll', updateInset);
    };
  }, [textOpen]);

  useEffect(() => {
    if (textOpen) textInputRef.current?.focus({ preventScroll: true });
  }, [textEditingId, textOpen]);

  const redrawCanvas = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(bounds.width * pixelRatio);
    canvas.height = Math.round(bounds.height * pixelRatio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    strokes.forEach(stroke => drawStoryStroke(context, stroke, bounds.width, bounds.height));
    if (activeStroke) drawStoryStroke(context, activeStroke, bounds.width, bounds.height);
  }, [activeStroke, strokes]);

  useEffect(() => {
    redrawCanvas();
    const canvas = drawingCanvasRef.current;
    const observer = canvas && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redrawCanvas) : null;
    if (canvas) observer?.observe(canvas);
    window.addEventListener('resize', redrawCanvas);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', redrawCanvas);
    };
  }, [redrawCanvas]);

  const findLayer = (kind: LayerKind, id: string) => kind === 'text'
    ? textLayers.find(layer => layer.id === id)
    : stickerLayers.find(layer => layer.id === id);

  const createTextLayer = (id: string, text: string, style: TextStyle): TextLayer => ({
    ...style,
    id,
    text,
    x: 50,
    y: 50,
    scale: 1,
    rotation: 0,
    order: layerOrderRef.current++,
  });

  const updateActiveTextLayer = (updates: Partial<TextLayer>) => {
    const id = textEditingId;
    if (!id) return;
    const current = textLayers.find(layer => layer.id === id);
    const newLayer = current || (textDraft.trim() ? createTextLayer(id, textDraft, textStyle) : null);
    if (!newLayer) return;
    setTextLayers(layers => layers.some(layer => layer.id === id)
      ? layers.map(layer => layer.id === id ? { ...layer, ...updates } : layer)
      : [...layers, { ...newLayer, ...updates }]);
  };

  const openTextEditor = (layerId?: string) => {
    const layer = layerId
      ? textLayers.find(item => item.id === layerId)
      : selectedTextId ? textLayers.find(item => item.id === selectedTextId) : undefined;
    const id = layer?.id || layerId || selectedTextId || makeLayerId('chat-text');
    setTextEditingId(id);
    setSelectedTextId(id);
    setSelectedStickerId(null);
    setTextDraft(layer?.text || '');
    if (layer) {
      setTextStyle({
        fontFamily: layer.fontFamily,
        textColor: layer.textColor,
        textAlign: layer.textAlign,
        textBackground: layer.textBackground,
        fontSize: layer.fontSize,
        animation: layer.animation,
      });
    }
    setStickersOpen(false);
    setFiltersOpen(false);
    setDrawingOpen(false);
    setTextOpen(true);
  };

  const startNewText = () => {
    const id = makeLayerId('chat-text');
    setTextEditingId(id);
    setSelectedTextId(id);
    setSelectedStickerId(null);
    setTextDraft('');
    setStickersOpen(false);
    setFiltersOpen(false);
    setTextOpen(true);
  };

  const finishTextEditing = () => {
    const id = textEditingId;
    if (id && !textDraft.trim()) {
      setTextLayers(layers => layers.filter(layer => layer.id !== id));
      setSelectedTextId(null);
    }
    setTextEditingId(null);
    setTextOpen(false);
  };

  const updateTextDraft = (value: string) => {
    setTextDraft(value);
    if (!textEditingId) return;
    if (!value.trim()) {
      setTextLayers(layers => layers.filter(layer => layer.id !== textEditingId));
      return;
    }
    const current = textLayers.find(layer => layer.id === textEditingId);
    const newLayer = current || createTextLayer(textEditingId, value, textStyle);
    setTextLayers(layers => layers.some(layer => layer.id === textEditingId)
      ? layers.map(layer => layer.id === textEditingId ? { ...layer, text: value } : layer)
      : [...layers, { ...newLayer, text: value }]);
  };

  const updateTextStyle = (updates: Partial<TextStyle>) => {
    setTextStyle(current => ({ ...current, ...updates }));
    updateActiveTextLayer(updates);
  };

  const toggleTextEditor = () => {
    if (textOpen) {
      finishTextEditing();
      return;
    }
    openTextEditor();
  };

  const toggleStickerPanel = () => {
    setStickersOpen(value => !value);
    setTextOpen(false);
    setFiltersOpen(false);
    setDrawingOpen(false);
  };

  const addSticker = (value: string) => {
    const sticker: StickerLayer = {
      id: makeLayerId('chat-sticker'),
      value,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      order: layerOrderRef.current++,
    };
    setStickerLayers(layers => [...layers, sticker]);
    setSelectedStickerId(sticker.id);
    setSelectedTextId(null);
    setStickersOpen(false);
  };

  const removeSelectedSticker = () => {
    if (!selectedStickerId) return;
    setStickerLayers(layers => layers.filter(layer => layer.id !== selectedStickerId));
    setSelectedStickerId(null);
  };

  const removeActiveText = () => {
    if (!textEditingId) return;
    setTextLayers(layers => layers.filter(layer => layer.id !== textEditingId));
    setSelectedTextId(null);
    setTextDraft('');
    setTextEditingId(null);
    setTextOpen(false);
  };

  const showAlignmentGuides = (vertical: boolean, horizontal: boolean) => {
    setAlignmentGuides({ vertical, horizontal });
    if (alignmentGuideTimerRef.current !== null) window.clearTimeout(alignmentGuideTimerRef.current);
    alignmentGuideTimerRef.current = vertical || horizontal
      ? window.setTimeout(() => {
          setAlignmentGuides({ vertical: false, horizontal: false });
          alignmentGuideTimerRef.current = null;
        }, 300)
      : null;
  };

  const applyLayerTransform = (gesture: LayerGesture, clientX: number, clientY: number, distance?: number, angle?: number) => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const deltaX = clientX - gesture.startX;
    const deltaY = clientY - gesture.startY;
    let x = Math.min(100, Math.max(0, gesture.baseX + (deltaX / bounds.width) * 100));
    let y = Math.min(100, Math.max(0, gesture.baseY + (deltaY / bounds.height) * 100));
    const vertical = Math.abs(x - 50) <= 1.4;
    const horizontal = Math.abs(y - 50) <= 1.4;
    if (vertical) x = 50;
    if (horizontal) y = 50;
    showAlignmentGuides(vertical, horizontal);
    const scale = distance !== undefined && gesture.startDistance > 0
      ? Math.min(5, Math.max(0.3, gesture.baseScale * (distance / gesture.startDistance)))
      : gesture.baseScale;
    const rotationDelta = angle !== undefined ? angleDifference(angle, gesture.startAngle) : 0;
    const rotation = gesture.baseRotation + rotationDelta;
    gesture.moved ||= Math.hypot(deltaX, deltaY) > 2 || Math.abs(scale - gesture.baseScale) > 0.02 || Math.abs(rotationDelta) > 2;
    if (gesture.kind === 'text') {
      setTextLayers(layers => layers.map(layer => layer.id === gesture.id ? { ...layer, x, y, scale, rotation } : layer));
    } else {
      setStickerLayers(layers => layers.map(layer => layer.id === gesture.id ? { ...layer, x, y, scale, rotation } : layer));
    }
  };

  const makeGesture = (kind: LayerKind, id: string, touches: TouchList, pointerId: number | null = null): LayerGesture | null => {
    const layer = findLayer(kind, id);
    if (!layer) return null;
    const hasTwoTouches = touches.length >= 2;
    const metrics = hasTwoTouches ? getTouchMetrics(touches) : null;
    const first = touches[0];
    return {
      id,
      kind,
      touchCount: hasTwoTouches ? 2 : 1,
      pointerId,
      startX: metrics?.x ?? first.clientX,
      startY: metrics?.y ?? first.clientY,
      startDistance: metrics?.distance ?? 0,
      startAngle: metrics?.angle ?? 0,
      baseX: layer.x,
      baseY: layer.y,
      baseScale: layer.scale,
      baseRotation: layer.rotation,
      moved: false,
    };
  };

  const handleStageTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (drawingOpen || cropOpen || !event.touches.length) return;
    const target = event.target as HTMLElement;
    const layerElement = target.closest<HTMLElement>('[data-editor-layer]');
    const gesture = layerGestureRef.current;
    if (layerElement) {
      const kind = layerElement.dataset.editorLayerKind as LayerKind;
      const id = layerElement.dataset.editorLayerId;
      if (!id || (kind !== 'text' && kind !== 'sticker')) return;
      if (kind === 'text') {
        setSelectedTextId(id);
        setSelectedStickerId(null);
      } else {
        setSelectedStickerId(id);
        setSelectedTextId(null);
      }
      layerGestureRef.current = makeGesture(kind, id, event.touches);
      return;
    }
    if (gesture && event.touches.length >= 2) {
      layerGestureRef.current = makeGesture(gesture.kind, gesture.id, event.touches);
    }
  };

  const handleStageTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = layerGestureRef.current;
    if (!gesture || drawingOpen || !event.touches.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.touches.length !== gesture.touchCount) {
      layerGestureRef.current = makeGesture(gesture.kind, gesture.id, event.touches);
      return;
    }
    if (event.touches.length >= 2) {
      const metrics = getTouchMetrics(event.touches);
      applyLayerTransform(gesture, metrics.x, metrics.y, metrics.distance, metrics.angle);
    } else {
      applyLayerTransform(gesture, event.touches[0].clientX, event.touches[0].clientY);
    }
  };

  const handleStageTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = layerGestureRef.current;
    if (!gesture) return;
    if (event.touches.length > 0) {
      layerGestureRef.current = makeGesture(gesture.kind, gesture.id, event.touches);
      return;
    }
    if (gesture.moved) suppressLayerClickUntilRef.current = Date.now() + 450;
    layerGestureRef.current = null;
  };

  const handleStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || drawingOpen || cropOpen) return;
    const target = event.target as HTMLElement;
    const layerElement = target.closest<HTMLElement>('[data-editor-layer]');
    const kind = layerElement?.dataset.editorLayerKind as LayerKind | undefined;
    const id = layerElement?.dataset.editorLayerId;
    if (!layerElement || !id || (kind !== 'text' && kind !== 'sticker')) return;
    const gesture = makeGesture(kind, id, { length: 1, 0: { clientX: event.clientX, clientY: event.clientY } } as unknown as TouchList, event.pointerId);
    if (!gesture) return;
    event.preventDefault();
    layerGestureRef.current = gesture;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'text') {
      setSelectedTextId(id);
      setSelectedStickerId(null);
    } else {
      setSelectedStickerId(id);
      setSelectedTextId(null);
    }
  };

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = layerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || event.pointerType !== 'mouse') return;
    event.preventDefault();
    applyLayerTransform(gesture, event.clientX, event.clientY);
  };

  const handleStagePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = layerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.moved) suppressLayerClickUntilRef.current = Date.now() + 450;
    layerGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleStageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, canvas, [data-editor-layer]')) return;
    if (!textOpen || !textEditingId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    updateActiveTextLayer({
      x: Math.min(95, Math.max(5, ((event.clientX - bounds.left) / bounds.width) * 100)),
      y: Math.min(95, Math.max(5, ((event.clientY - bounds.top) / bounds.height) * 100)),
    });
  };

  const saveEditedImage = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      });
      image.src = previewUrl;
      await imageLoaded;

      const viewportWidth = Math.max(1, stageSize.width);
      const viewportHeight = Math.max(1, stageSize.height);
      const outputScale = Math.min(1920 / viewportHeight, 1080 / viewportWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewportWidth * outputScale));
      canvas.height = Math.max(1, Math.round(viewportHeight * outputScale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة المعدلة.');

      const isQuarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
      const coverScale = Math.max(
        canvas.width / (isQuarterTurn ? image.naturalHeight : image.naturalWidth),
        canvas.height / (isQuarterTurn ? image.naturalWidth : image.naturalHeight),
      );
      const imageWidth = image.naturalWidth * coverScale;
      const imageHeight = image.naturalHeight * coverScale;
      const screenScaleX = canvas.width / viewportWidth;
      const screenScaleY = canvas.height / viewportHeight;
      context.save();
      context.translate(canvas.width / 2 + offset.x * screenScaleX, canvas.height / 2 + offset.y * screenScaleY);
      context.rotate((rotation * Math.PI) / 180);
      context.scale(zoom, zoom);
      context.filter = buildStoryFilterCss(filterId, adjustments);
      context.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
      context.restore();

      const filterOverlay = getStoryFilterOverlay(filterId);
      if (filterOverlay) {
        context.save();
        context.globalAlpha = filterOverlay.opacity;
        context.globalCompositeOperation = filterOverlay.blend as GlobalCompositeOperation;
        context.fillStyle = filterOverlay.color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
      }

      const orderedLayers = [
        ...textLayers.map(layer => ({ type: 'text' as const, order: layer.order, layer })),
        ...stickerLayers.map(layer => ({ type: 'sticker' as const, order: layer.order, layer })),
      ].sort((first, second) => first.order - second.order);
      const drawingCanvas = document.createElement('canvas');
      drawingCanvas.width = canvas.width;
      drawingCanvas.height = canvas.height;
      const drawingContext = drawingCanvas.getContext('2d');
      if (drawingContext) {
        strokes.forEach(stroke => drawStoryStroke(drawingContext, {
          ...stroke,
          size: stroke.size * screenScaleX,
        }, drawingCanvas.width, drawingCanvas.height));
        context.drawImage(drawingCanvas, 0, 0);
      }
      orderedLayers.forEach(item => {
        if (item.type === 'text') {
          drawStoryTextLayer(context, item.layer, screenScaleX);
          return;
        }
        context.save();
        context.translate(canvas.width * (item.layer.x / 100), canvas.height * (item.layer.y / 100));
        context.rotate((item.layer.rotation * Math.PI) / 180);
        context.scale(item.layer.scale, item.layer.scale);
        context.font = `${68 * screenScaleX}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(item.layer.value, 0, 0);
        context.restore();
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error('تعذر حفظ الصورة المعدلة.')), 'image/jpeg', quality);
      });
      const edited = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-edited.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
      onSave(edited);
    } catch (error) {
      console.error('[messages] تعذر تجهيز الصورة المعدلة:', error);
      window.alert(error instanceof Error ? error.message : 'تعذر حفظ الصورة المعدلة.');
    } finally {
      setSaving(false);
    }
  };

  const selectedTextLayer = textLayers.find(layer => layer.id === selectedTextId) || null;
  const selectedStickerLayer = stickerLayers.find(layer => layer.id === selectedStickerId) || null;
  const activeBackgroundPreset = STORY_TEXT_BACKGROUNDS.find(preset => preset.background === textStyle.textBackground) || STORY_TEXT_BACKGROUNDS[0];
  const filterStyle = buildStoryFilterCss(filterId, adjustments);
  const overlay = getStoryFilterOverlay(filterId);
  const isQuarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const previewCoverScale = imageSize.width && imageSize.height
    ? Math.max(
        stageSize.width / (isQuarterTurn ? imageSize.height : imageSize.width),
        stageSize.height / (isQuarterTurn ? imageSize.width : imageSize.height),
      )
    : 1;
  const imageStyle: CSSProperties = {
    width: imageSize.width ? `${imageSize.width * previewCoverScale}px` : '100%',
    height: imageSize.height ? `${imageSize.height * previewCoverScale}px` : '100%',
    filter: filterStyle,
    transform: `translate(-50%, -50%) translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
  };

  return (
    <div className="chat-photo-editor" role="dialog" aria-modal="true" aria-label="تعديل الصورة" dir="rtl">
      <div
        ref={stageRef}
        className="chat-photo-editor-stage"
        onClick={handleStageClick}
        onTouchStart={handleStageTouchStart}
        onTouchMove={handleStageTouchMove}
        onTouchEnd={handleStageTouchEnd}
        onTouchCancel={handleStageTouchEnd}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerEnd}
        onPointerCancel={handleStagePointerEnd}
        style={{ touchAction: 'none' }}
      >
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          className="chat-photo-editor-image"
          style={imageStyle}
        />
        {overlay && (
          <div className="chat-photo-editor-filter-overlay" style={{ background: overlay.color, opacity: overlay.opacity, mixBlendMode: overlay.blend as CSSProperties['mixBlendMode'] }} />
        )}
        {[...textLayers].sort((first, second) => first.order - second.order).map(layer => (
          <div
            key={layer.id}
            data-editor-layer="true"
            data-editor-layer-kind="text"
            data-editor-layer-id={layer.id}
            role="button"
            tabIndex={0}
            aria-label={`نص: ${layer.text}`}
            className={`chat-photo-editor-text${layer.textBackground !== 'transparent' ? ' has-background' : ''}${selectedTextLayer?.id === layer.id ? ' is-selected' : ''}`}
            style={{
              left: `${layer.x}%`,
              top: `${layer.y}%`,
              zIndex: 20 + layer.order,
              transform: `translate(-50%, -50%) scale(${layer.scale}) rotate(${layer.rotation}deg)`,
              fontFamily: `${layer.fontFamily}, sans-serif`,
              color: layer.textColor,
              fontSize: `${layer.fontSize}px`,
              textAlign: layer.textAlign,
              background: layer.textBackground,
              padding: layer.textBackground !== 'transparent' ? '2px 10px' : undefined,
            }}
            onClick={event => {
              event.stopPropagation();
              if (Date.now() < suppressLayerClickUntilRef.current) return;
              openTextEditor(layer.id);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openTextEditor(layer.id);
              }
            }}
          >
            <span className={`chat-photo-editor-text-animation${layer.animation !== 'none' && layer.animation !== 'typewriter' ? ` aani-story-anim-${layer.animation}` : ''}`}>
              {layer.animation === 'typewriter' && textOpen && textEditingId === layer.id
                ? <StoryTypedPreview text={layer.text} animate />
                : layer.text}
            </span>
          </div>
        ))}
        {[...stickerLayers].sort((first, second) => first.order - second.order).map(layer => (
          <span
            key={layer.id}
            data-editor-layer="true"
            data-editor-layer-kind="sticker"
            data-editor-layer-id={layer.id}
            role="button"
            tabIndex={0}
            aria-label={`ملصق ${layer.value}`}
            className={`chat-photo-editor-sticker${selectedStickerLayer?.id === layer.id ? ' is-selected' : ''}`}
            style={{
              top: `${layer.y}%`,
              left: `${layer.x}%`,
              zIndex: 20 + layer.order,
              transform: `translate(-50%, -50%) scale(${layer.scale}) rotate(${layer.rotation}deg)`,
            }}
            onClick={event => {
              event.stopPropagation();
              if (Date.now() < suppressLayerClickUntilRef.current) return;
              setSelectedStickerId(layer.id);
              setSelectedTextId(null);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedStickerId(layer.id);
                setSelectedTextId(null);
              }
            }}
          >
            {layer.value}
          </span>
        ))}
        <canvas
          ref={drawingCanvasRef}
          aria-label="ارسم على الصورة"
          className={`chat-photo-editor-drawing${drawingOpen ? ' is-active' : ''}`}
          onPointerDown={event => {
            if (!drawingOpen) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = getStoryDrawPoint(event.currentTarget, event.clientX, event.clientY);
            setActiveStroke({
              id: makeLayerId('draw'),
              color: drawColor,
              size: drawSize,
              tool: drawTool,
              points: [point],
            });
          }}
          onPointerMove={event => {
            if (!drawingOpen || !activeStroke) return;
            event.preventDefault();
            event.stopPropagation();
            const point = getStoryDrawPoint(event.currentTarget, event.clientX, event.clientY);
            setActiveStroke(current => current ? { ...current, points: [...current.points, point] } : null);
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (activeStroke) setStrokes(current => [...current, activeStroke]);
            setActiveStroke(null);
          }}
          onPointerCancel={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (activeStroke) setStrokes(current => [...current, activeStroke]);
            setActiveStroke(null);
          }}
          style={{ touchAction: 'none' }}
        />
      </div>

      <StoryAlignmentGuides vertical={alignmentGuides.vertical} horizontal={alignmentGuides.horizontal} />

      <header className="chat-photo-editor-header">
        <button type="button" aria-label="إلغاء التعديل" onClick={onCancel}><X size={22} /></button>
        <span>تعديل الصورة</span>
        <button type="button" aria-label="حفظ التعديلات" disabled={saving} onClick={() => void saveEditedImage()}>
          {saving ? <span className="chat-photo-editor-spinner" /> : <Check size={22} />}
        </button>
      </header>

      {!drawingOpen && !cropOpen && (
        <div className="chat-photo-editor-tools" aria-label="أدوات تعديل الصورة">
          <button type="button" aria-pressed={textOpen} onClick={toggleTextEditor}><Type size={19} /><span>نص</span></button>
          <button type="button" aria-expanded={stickersOpen} onClick={toggleStickerPanel}><Sticker size={19} /><span>ملصق</span></button>
          <button type="button" aria-pressed={filtersOpen} onClick={() => { setFiltersOpen(value => !value); setTextOpen(false); setStickersOpen(false); }}><Sparkles size={19} /><span>فلاتر</span></button>
          <button type="button" aria-pressed={drawingOpen} onClick={() => { setDrawingOpen(true); setTextOpen(false); setStickersOpen(false); setFiltersOpen(false); }}><span className="chat-photo-editor-pencil">✎</span><span>رسم</span></button>
          <button type="button" onClick={() => { setTextOpen(false); setStickersOpen(false); setFiltersOpen(false); setCropOpen(true); }}><Crop size={19} /><span>قص</span></button>
          <button type="button" onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={19} /><span>تدوير</span></button>
        </div>
      )}

      {filtersOpen && !drawingOpen && (
        <div className="chat-photo-editor-filter-panel">
          <StoryFilterBar
            previewUrl={previewUrl}
            isVideo={false}
            activeId={filterId}
            onSelect={setFilterId}
            adjustments={adjustments}
            onAdjust={(key, value) => setAdjustments(current => ({ ...current, [key]: value }))}
            onReset={() => { setFilterId('original'); setAdjustments(DEFAULT_ADJUSTMENTS); }}
            onClose={() => setFiltersOpen(false)}
          />
        </div>
      )}

      {textOpen && !drawingOpen && (
        <div
          className="chat-photo-editor-panel chat-photo-editor-text-panel"
          style={{ bottom: `calc(76px + env(safe-area-inset-bottom) + ${keyboardInset}px)` }}
          onClick={event => event.stopPropagation()}
        >
          <textarea ref={textInputRef} value={textDraft} onChange={event => updateTextDraft(event.target.value)} placeholder="اكتب نصاً على الصورة..." aria-label="نص الصورة" rows={2} />
          <label className="chat-photo-editor-text-size">
            <span>حجم النص</span>
            <input type="range" min="12" max="96" value={textStyle.fontSize} onChange={event => updateTextStyle({ fontSize: Number(event.target.value) })} aria-label="حجم النص" />
          </label>
          <div className="chat-photo-editor-text-actions">
            <button type="button" onClick={startNewText}>نص جديد</button>
            <button type="button" onClick={removeActiveText} disabled={!selectedTextLayer && !textDraft}>حذف النص</button>
            <button type="button" className="is-done" onClick={finishTextEditing}>تم</button>
          </div>
          <StoryTextToolbar
            fontFamily={textStyle.fontFamily}
            onFontFamilyChange={fontFamily => updateTextStyle({ fontFamily })}
            textColor={textStyle.textColor}
            onTextColorChange={textColor => updateTextStyle({ textColor })}
            align={textStyle.textAlign}
            onCycleAlign={() => updateTextStyle({ textAlign: nextStoryTextAlign(textStyle.textAlign) })}
            backgroundLabel={activeBackgroundPreset.label}
            backgroundSwatch={activeBackgroundPreset.background}
            onCycleBackground={() => {
              const index = STORY_TEXT_BACKGROUNDS.findIndex(preset => preset.background === textStyle.textBackground);
              const next = STORY_TEXT_BACKGROUNDS[(index + 1 + STORY_TEXT_BACKGROUNDS.length) % STORY_TEXT_BACKGROUNDS.length];
              updateTextStyle({ textBackground: next.background });
            }}
            animation={textStyle.animation}
            onAnimationChange={animation => updateTextStyle({ animation })}
            onInteract={() => textInputRef.current?.focus({ preventScroll: true })}
          />
        </div>
      )}

      {stickersOpen && !drawingOpen && (
        <section className="chat-photo-editor-panel chat-photo-editor-sticker-panel" aria-label="اختيار ملصق أو إيموجي">
          <div className="chat-photo-editor-sticker-grid">
            {STICKER_CHOICES.map(value => <button key={value} type="button" aria-label={`إضافة ${value}`} onClick={() => addSticker(value)}>{value}</button>)}
          </div>
          {selectedStickerLayer && <button type="button" className="chat-photo-editor-sticker-delete" onClick={removeSelectedSticker}>حذف الملصق المحدد</button>}
        </section>
      )}

      <StoryDrawingOverlay
        open={drawingOpen}
        color={drawColor}
        size={drawSize}
        tool={drawTool}
        strokesCount={strokes.length}
        onColorChange={setDrawColor}
        onSizeChange={setDrawSize}
        onToolChange={setDrawTool}
        onUndo={() => setStrokes(current => current.slice(0, -1))}
        onDone={() => { setDrawingOpen(false); setActiveStroke(null); }}
      />

      {cropOpen && (
        <StoryCropOverlay
          mediaUrl={previewUrl}
          isVideo={false}
          initialZoom={zoom}
          initialOffset={offset}
          initialRotation={rotation}
          onCancel={() => setCropOpen(false)}
          onApply={transform => {
            setZoom(transform.zoom);
            setOffset(transform.offset);
            setCropOpen(false);
          }}
        />
      )}
    </div>
  );
}
