import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Crop, RotateCw, Sparkles, Sticker, Type, X } from 'lucide-react';

import StoryCropOverlay from '@/components/StoryCropOverlay';
import { StoryDrawingOverlay } from '@/components/StoryEditorTools';
import StoryFilterBar from '@/components/StoryFilterBar';
import { drawStoryStroke, getStoryDrawPoint, type StoryDrawStroke, type StoryDrawTool } from '@/lib/appShared';
import {
  buildStoryFilterCss,
  DEFAULT_ADJUSTMENTS,
  getStoryFilterOverlay,
  type StoryAdjustments,
} from '@/lib/storyFilters';

const STICKER_CHOICES = ['❤️', '✨', '🔥', '😂', '🥹', '🫶', '🌙', '🤍', '🌸', '⭐', '🎉', '😎'];
const TEXT_COLORS = ['#FFFFFF', '#FFE066', '#FF5C5C', '#61D095', '#69B7FF', '#D69CFF'];

type Point = { x: number; y: number };
type StickerLayer = { id: string; value: string };

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
  const drawingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [filterId, setFilterId] = useState('original');
  const [adjustments, setAdjustments] = useState<StoryAdjustments>(DEFAULT_ADJUSTMENTS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawColor, setDrawColor] = useState('#FFFFFF');
  const [drawSize, setDrawSize] = useState(6);
  const [drawTool, setDrawTool] = useState<StoryDrawTool>('smooth');
  const [strokes, setStrokes] = useState<StoryDrawStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<StoryDrawStroke | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState('');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [textFont, setTextFont] = useState('Cairo');
  const [textBackground, setTextBackground] = useState(false);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [stickers, setStickers] = useState<StickerLayer[]>([]);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [cropOpen, setCropOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  const redrawCanvas = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * pixelRatio);
    canvas.height = Math.round(bounds.height * pixelRatio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    strokes.forEach(stroke => drawStoryStroke(context, stroke, bounds.width, bounds.height));
    if (activeStroke) drawStoryStroke(context, activeStroke, bounds.width, bounds.height);
  }, [activeStroke, strokes]);

  useEffect(() => {
    redrawCanvas();
    window.addEventListener('resize', redrawCanvas);
    return () => window.removeEventListener('resize', redrawCanvas);
  }, [redrawCanvas]);

  const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingOpen) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getStoryDrawPoint(event.currentTarget, event.clientX, event.clientY);
    setActiveStroke({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      color: drawColor,
      size: drawSize,
      tool: drawTool,
      points: [point],
    });
  };

  const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingOpen || !activeStroke) return;
    event.preventDefault();
    const point = getStoryDrawPoint(event.currentTarget, event.clientX, event.clientY);
    setActiveStroke(current => current ? { ...current, points: [...current.points, point] } : null);
  };

  const finishDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeStroke) setStrokes(current => [...current, activeStroke]);
    setActiveStroke(null);
  };

  const addSticker = (value: string) => {
    setStickers(current => [...current, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      value,
    }]);
    setStickersOpen(false);
  };

  const saveEditedImage = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
      });
      image.src = previewUrl;
      await imageLoaded;

      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      const outputScale = Math.min(1920 / viewportHeight, 1080 / viewportWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewportWidth * outputScale));
      canvas.height = Math.max(1, Math.round(viewportHeight * outputScale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة المعدلة.');

      const coverScale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
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

      strokes.forEach(stroke => drawStoryStroke(context, {
        ...stroke,
        size: stroke.size * screenScaleX,
      }, canvas.width, canvas.height));

      if (text.trim()) {
        const fontSize = 38 * screenScaleX;
        context.save();
        context.direction = /[\u0600-\u06ff]/.test(text) ? 'rtl' : 'ltr';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = `700 ${fontSize}px "${textFont}", sans-serif`;
        context.shadowColor = 'rgba(0,0,0,.68)';
        context.shadowBlur = 10 * screenScaleX;
        const lines = wrapText(context, text, canvas.width * 0.82);
        const lineHeight = fontSize * 1.3;
        const blockHeight = lines.length * lineHeight;
        const startY = canvas.height * 0.48 - blockHeight / 2 + lineHeight / 2;
        if (textBackground) {
          context.shadowBlur = 0;
          context.fillStyle = 'rgba(0,0,0,.55)';
          context.fillRect(canvas.width * 0.08, startY - lineHeight * 0.65, canvas.width * 0.84, blockHeight + lineHeight * 0.3);
        }
        context.fillStyle = textColor;
        lines.forEach((line, index) => context.fillText(line, canvas.width / 2, startY + index * lineHeight, canvas.width * 0.82));
        context.restore();
      }

      stickers.forEach((sticker, index) => {
        context.save();
        context.font = `${68 * screenScaleX}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(sticker.value, canvas.width * (0.5 + ((index % 3) - 1) * 0.17), canvas.height * (0.42 + Math.floor(index / 3) * 0.15));
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

  const filterStyle = buildStoryFilterCss(filterId, adjustments);
  const overlay = getStoryFilterOverlay(filterId);

  return (
    <div className="chat-photo-editor" role="dialog" aria-modal="true" aria-label="تعديل الصورة" dir="rtl">
      <div className="chat-photo-editor-stage" onClick={() => { if (!drawingOpen && !textOpen) setTextOpen(true); }}>
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          className="chat-photo-editor-image"
          style={{ filter: filterStyle, transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom}) rotate(${rotation}deg)` }}
        />
        {overlay && (
          <div className="chat-photo-editor-filter-overlay" style={{ background: overlay.color, opacity: overlay.opacity, mixBlendMode: overlay.blend as CSSProperties['mixBlendMode'] }} />
        )}
        {text.trim() && (
          <div className={`chat-photo-editor-text${textBackground ? ' has-background' : ''}`} style={{ color: textColor, fontFamily: `${textFont}, sans-serif` }}>
            {text}
          </div>
        )}
        {stickers.map((sticker, index) => (
          <span key={sticker.id} className="chat-photo-editor-sticker" style={{ top: `${42 + Math.floor(index / 3) * 15}%`, left: `${50 + ((index % 3) - 1) * 17}%` }}>
            {sticker.value}
          </span>
        ))}
        <canvas
          ref={drawingCanvasRef}
          aria-label="ارسم على الصورة"
          className={`chat-photo-editor-drawing${drawingOpen ? ' is-active' : ''}`}
          onPointerDown={beginDrawing}
          onPointerMove={continueDrawing}
          onPointerUp={finishDrawing}
          onPointerCancel={finishDrawing}
          style={{ touchAction: 'none' }}
        />
      </div>

      <header className="chat-photo-editor-header">
        <button type="button" aria-label="إلغاء التعديل" onClick={onCancel}><X size={22} /></button>
        <span>تعديل الصورة</span>
        <button type="button" aria-label="حفظ التعديلات" disabled={saving} onClick={() => void saveEditedImage()}>
          {saving ? <span className="chat-photo-editor-spinner" /> : <Check size={22} />}
        </button>
      </header>

      {!drawingOpen && !cropOpen && (
        <div className="chat-photo-editor-tools" aria-label="أدوات تعديل الصورة">
          <button type="button" aria-pressed={textOpen} onClick={() => { setTextOpen(value => !value); setStickersOpen(false); setFiltersOpen(false); }}><Type size={19} /><span>نص</span></button>
          <button type="button" aria-expanded={stickersOpen} onClick={() => { setStickersOpen(value => !value); setTextOpen(false); setFiltersOpen(false); }}><Sticker size={19} /><span>ملصق</span></button>
          <button type="button" aria-pressed={filtersOpen} onClick={() => { setFiltersOpen(value => !value); setTextOpen(false); setStickersOpen(false); }}><Sparkles size={19} /><span>فلاتر</span></button>
          <button type="button" aria-pressed={drawingOpen} onClick={() => { setDrawingOpen(true); setTextOpen(false); setStickersOpen(false); setFiltersOpen(false); }}><span className="chat-photo-editor-pencil">✎</span><span>رسم</span></button>
          <button type="button" onClick={() => setCropOpen(true)}><Crop size={19} /><span>قص</span></button>
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
        <div className="chat-photo-editor-panel chat-photo-editor-text-panel" onClick={event => event.stopPropagation()}>
          <textarea value={text} onChange={event => setText(event.target.value)} placeholder="اكتب نصاً على الصورة..." aria-label="نص الصورة" rows={2} />
          <div className="chat-photo-editor-panel-tools">
            <select value={textFont} onChange={event => setTextFont(event.target.value)} aria-label="نوع الخط">
              <option value="Cairo">القاهرة</option>
              <option value="Tajawal">تجوال</option>
              <option value="serif">كلاسيكي</option>
            </select>
            <button type="button" aria-pressed={textBackground} onClick={() => setTextBackground(value => !value)}>خلفية</button>
            <button type="button" onClick={() => setTextOpen(false)}>تم</button>
          </div>
          <div className="chat-photo-editor-colors" aria-label="لون النص">
            {TEXT_COLORS.map(color => <button key={color} type="button" aria-label={`لون النص ${color}`} aria-pressed={textColor === color} onClick={() => setTextColor(color)} style={{ backgroundColor: color }} />)}
          </div>
        </div>
      )}

      {stickersOpen && !drawingOpen && (
        <div className="chat-photo-editor-panel chat-photo-editor-sticker-panel" aria-label="اختيار ملصق">
          {STICKER_CHOICES.map(value => <button key={value} type="button" onClick={() => addSticker(value)}>{value}</button>)}
        </div>
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
