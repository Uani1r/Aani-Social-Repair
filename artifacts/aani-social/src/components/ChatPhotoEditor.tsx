import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Crop, Pencil, X } from 'lucide-react';

import StoryCropOverlay from '@/components/StoryCropOverlay';
import { StoryDrawingOverlay } from '@/components/StoryEditorTools';
import { drawStoryStroke, getStoryDrawPoint, type StoryDrawStroke, type StoryDrawTool } from '@/lib/appShared';

type Point = { x: number; y: number };

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
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawColor, setDrawColor] = useState('#FFFFFF');
  const [drawSize, setDrawSize] = useState(6);
  const [drawTool, setDrawTool] = useState<StoryDrawTool>('smooth');
  const [strokes, setStrokes] = useState<StoryDrawStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<StoryDrawStroke | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [cropOpen, setCropOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

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

      const viewportWidth = Math.max(1, stageSize.width);
      const viewportHeight = Math.max(1, stageSize.height);
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
      context.scale(zoom, zoom);
      context.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
      context.restore();

      const drawingCanvas = document.createElement('canvas');
      drawingCanvas.width = canvas.width;
      drawingCanvas.height = canvas.height;
      const drawingContext = drawingCanvas.getContext('2d');
      if (!drawingContext) throw new Error('تعذر تجهيز طبقة الرسم.');
      strokes.forEach(stroke => drawStoryStroke(drawingContext, {
        ...stroke,
        size: stroke.size * screenScaleX,
      }, drawingCanvas.width, drawingCanvas.height));
      context.drawImage(drawingCanvas, 0, 0);

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

  const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingOpen) return;
    event.preventDefault();
    event.stopPropagation();
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
    event.stopPropagation();
    const point = getStoryDrawPoint(event.currentTarget, event.clientX, event.clientY);
    setActiveStroke(current => current ? { ...current, points: [...current.points, point] } : null);
  };

  const finishDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeStroke) setStrokes(current => [...current, activeStroke]);
    setActiveStroke(null);
  };

  const coverScale = imageSize.width && imageSize.height
    ? Math.max(stageSize.width / imageSize.width, stageSize.height / imageSize.height)
    : 1;
  const imageStyle: CSSProperties = {
    width: imageSize.width ? `${imageSize.width * coverScale}px` : '100%',
    height: imageSize.height ? `${imageSize.height * coverScale}px` : '100%',
    transform: `translate(-50%, -50%) translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
  };

  return (
    <div className="chat-photo-editor" role="dialog" aria-modal="true" aria-label="تعديل الصورة" dir="rtl">
      <div ref={stageRef} className="chat-photo-editor-stage">
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          className="chat-photo-editor-image"
          style={imageStyle}
        />
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
          <button type="button" aria-pressed={drawingOpen} onClick={() => setDrawingOpen(true)}>
            <Pencil size={21} />
            <span>رسم</span>
          </button>
          <button type="button" onClick={() => setCropOpen(true)}>
            <Crop size={21} />
            <span>قص</span>
          </button>
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
          initialRotation={0}
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
