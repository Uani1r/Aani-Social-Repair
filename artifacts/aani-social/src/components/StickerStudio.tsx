import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, LoaderCircle, Scissors, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

type Point = { x: number; y: number };
type CanvasSize = { width: number; height: number };

function averageColor(imageData: ImageData, width: number, height: number, corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): [number, number, number] | null {
  const radius = Math.max(2, Math.min(10, Math.floor(Math.min(width, height) / 32)));
  const startX = corner.endsWith('right') ? Math.max(0, width - radius) : 0;
  const startY = corner.startsWith('bottom') ? Math.max(0, height - radius) : 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = startY; y < Math.min(height, startY + radius); y += 1) {
    for (let x = startX; x < Math.min(width, startX + radius); x += 1) {
      const offset = (y * width + x) * 4;
      if (imageData.data[offset + 3] < 16) continue;
      red += imageData.data[offset];
      green += imageData.data[offset + 1];
      blue += imageData.data[offset + 2];
      count += 1;
    }
  }
  return count ? [red / count, green / count, blue / count] : null;
}

export default function StickerStudio({
  file,
  onClose,
  onSave,
}: {
  file: File;
  onClose: () => void;
  onSave: (sticker: File) => Promise<void>;
}) {
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const drawingRef = useRef(false);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [threshold, setThreshold] = useState(42);
  const [selectionCount, setSelectionCount] = useState(0);
  const [outputFormat, setOutputFormat] = useState<'png' | 'webp'>('png');

  useEffect(() => {
    const imageUrl = URL.createObjectURL(file);
    const image = new Image();
    setIsLoaded(false);
    setHasResult(false);
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const context = sourceCanvas.getContext('2d');
      if (!context) {
        toast.error('تعذر تجهيز الصورة للتحرير.');
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      sourceCanvasRef.current = sourceCanvas;
      resultCanvasRef.current = null;
      pointsRef.current = [];
      const previewCanvas = previewCanvasRef.current;
      if (previewCanvas) {
        previewCanvas.width = width;
        previewCanvas.height = height;
        const previewContext = previewCanvas.getContext('2d');
        previewContext?.drawImage(sourceCanvas, 0, 0);
      }
      setCanvasSize({ width, height });
      setSelectionCount(0);
      setIsLoaded(true);
    };
    image.onerror = () => toast.error('تعذر فتح الصورة المحددة.');
    image.src = imageUrl;
    return () => URL.revokeObjectURL(imageUrl);
  }, [file]);

  const redrawPreview = () => {
    const canvas = previewCanvasRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    if (!canvas || !sourceCanvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceCanvas, 0, 0);
    if (pointsRef.current.length < 2) return;
    context.beginPath();
    context.moveTo(pointsRef.current[0].x, pointsRef.current[0].y);
    pointsRef.current.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.strokeStyle = '#9cf5cf';
    context.lineWidth = Math.max(3, canvas.width / 220);
    context.setLineDash([context.lineWidth * 2, context.lineWidth * 1.4]);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.stroke();
    context.setLineDash([]);
  };

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - bounds.left) * (event.currentTarget.width / bounds.width))),
      y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - bounds.top) * (event.currentTarget.height / bounds.height))),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isLoaded || hasResult || event.button !== 0) return;
    event.preventDefault();
    drawingRef.current = true;
    pointsRef.current = [pointFromEvent(event)];
    setSelectionCount(1);
    event.currentTarget.setPointerCapture(event.pointerId);
    redrawPreview();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    pointsRef.current.push(pointFromEvent(event));
    setSelectionCount(pointsRef.current.length);
    redrawPreview();
  };

  const finishDrawing = () => {
    drawingRef.current = false;
  };

  const clearResult = () => {
    resultCanvasRef.current = null;
    pointsRef.current = [];
    setSelectionCount(0);
    setHasResult(false);
    redrawPreview();
  };

  const showResult = (canvas: HTMLCanvasElement) => {
    resultCanvasRef.current = canvas;
    const preview = previewCanvasRef.current;
    const context = preview?.getContext('2d');
    if (preview && context) {
      context.clearRect(0, 0, preview.width, preview.height);
      context.drawImage(canvas, 0, 0);
    }
    pointsRef.current = [];
    setSelectionCount(0);
    setHasResult(true);
  };

  const applyContourCut = () => {
    const source = sourceCanvasRef.current;
    if (!source || pointsRef.current.length < 3) {
      toast.info('ارسم خطاً مغلقاً حول العنصر أولاً.');
      return;
    }
    const result = document.createElement('canvas');
    result.width = source.width;
    result.height = source.height;
    const context = result.getContext('2d');
    if (!context) return;
    context.beginPath();
    context.moveTo(pointsRef.current[0].x, pointsRef.current[0].y);
    pointsRef.current.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.closePath();
    context.clip();
    context.drawImage(source, 0, 0);
    showResult(result);
  };

  const applyAutomaticCut = () => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const imageData = context.getImageData(0, 0, source.width, source.height);
    const { width, height, data } = imageData;
    const backgroundColors = (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)
      .map(corner => averageColor(imageData, width, height, corner))
      .filter((color): color is [number, number, number] => color !== null);
    const thresholdSquared = threshold * threshold;
    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;
    const matchesBackground = (pixelIndex: number) => {
      const offset = pixelIndex * 4;
      if (data[offset + 3] < 16) return true;
      return backgroundColors.some(color => {
        const red = data[offset] - color[0];
        const green = data[offset + 1] - color[1];
        const blue = data[offset + 2] - color[2];
        return red * red + green * green + blue * blue <= thresholdSquared;
      });
    };
    const enqueueIfBackground = (pixelIndex: number) => {
      if (visited[pixelIndex] || !matchesBackground(pixelIndex)) return;
      visited[pixelIndex] = 1;
      queue[tail] = pixelIndex;
      tail += 1;
    };

    for (let x = 0; x < width; x += 1) {
      enqueueIfBackground(x);
      enqueueIfBackground((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
      enqueueIfBackground(y * width);
      enqueueIfBackground(y * width + width - 1);
    }

    while (head < tail) {
      const pixelIndex = queue[head];
      head += 1;
      data[pixelIndex * 4 + 3] = 0;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (x > 0) enqueueIfBackground(pixelIndex - 1);
      if (x + 1 < width) enqueueIfBackground(pixelIndex + 1);
      if (y > 0) enqueueIfBackground(pixelIndex - width);
      if (y + 1 < height) enqueueIfBackground(pixelIndex + width);
    }

    if (tail === 0) {
      toast.info('لم يتم العثور على خلفية متصلة بحواف الصورة. جرّب القص الحر أو ارفع الحساسية.');
      return;
    }
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    const resultContext = result.getContext('2d');
    if (!resultContext) return;
    resultContext.putImageData(imageData, 0, 0);
    showResult(result);
  };

  const saveSticker = async () => {
    const result = resultCanvasRef.current;
    if (!result || isSaving) return;
    setIsSaving(true);
    try {
      const mimeType = outputFormat === 'webp' ? 'image/webp' : 'image/png';
      const blob = await new Promise<Blob | null>(resolve => result.toBlob(resolve, mimeType, 0.94));
      if (!blob || blob.type !== mimeType) {
        throw new Error(outputFormat === 'webp' ? 'هذا المتصفح لا يدعم تصدير WebP. اختر PNG.' : 'تعذر إنشاء ملف PNG شفاف.');
      }
      await onSave(new File([blob], `sticker-${Date.now()}.${outputFormat}`, { type: mimeType, lastModified: Date.now() }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ الملصق.');
    } finally {
      setIsSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="messages-sticker-studio-backdrop" role="presentation" onClick={onClose}>
      <section
        className="messages-sticker-studio"
        role="dialog"
        aria-modal="true"
        aria-label="استوديو إنشاء الملصقات"
        dir="rtl"
        onClick={event => event.stopPropagation()}
      >
        <header className="messages-sticker-studio-header">
          <button type="button" aria-label="العودة إلى الملصقات" onClick={onClose}><ArrowLeft size={21} /></button>
          <div><strong>استوديو الملصقات</strong><span>قص العنصر واحفظه كصورة شفافة</span></div>
          <button type="button" aria-label="إغلاق الاستوديو" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="messages-sticker-studio-content">
          <p className="messages-sticker-studio-tip">ارسم حول العنصر لقصّه بحرية، أو جرّب إزالة لون الخلفية المتصل بالحواف تلقائيًا.</p>
          <div className={`messages-sticker-canvas-wrap${hasResult ? ' has-result' : ''}`}>
            {!isLoaded && <span className="messages-sticker-studio-loading"><LoaderCircle size={20} /> جارٍ تجهيز الصورة...</span>}
            <canvas
              ref={previewCanvasRef}
              aria-label="معاينة الصورة. اسحب حول العنصر لرسم حدود الملصق"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrawing}
              onPointerCancel={finishDrawing}
            />
            {hasResult && <span className="messages-sticker-result-badge"><Check size={14} /> خلفية شفافة</span>}
          </div>
          <div className="messages-sticker-studio-tools">
            <button type="button" onClick={applyAutomaticCut} disabled={!isLoaded || isSaving}><Scissors size={17} /> قص تلقائي</button>
            <button type="button" onClick={applyContourCut} disabled={!isLoaded || isSaving || selectionCount < 3}><span className="messages-sticker-lasso-icon" /> قصّ التحديد الحر</button>
            <button type="button" onClick={clearResult} disabled={!isLoaded || isSaving}><Trash2 size={16} /> مسح التحديد</button>
          </div>
          <label className="messages-sticker-threshold">
            <span>حساسية إزالة الخلفية</span>
            <input type="range" min="18" max="105" value={threshold} onChange={event => setThreshold(Number(event.target.value))} disabled={!isLoaded || hasResult} />
            <output>{threshold}</output>
          </label>
          <p className="messages-sticker-studio-note">القص التلقائي يعمل على الألوان المتصلة بالخلفية؛ استخدم التحديد الحر للأطراف المعقدة، ويمكنك مسح الاختيار وإعادة المحاولة.</p>
        </div>
        <footer className="messages-sticker-studio-footer">
          <div className="messages-sticker-format-picker" role="group" aria-label="صيغة صورة الملصق">
            <button type="button" className={outputFormat === 'png' ? 'is-active' : ''} aria-pressed={outputFormat === 'png'} onClick={() => setOutputFormat('png')} disabled={isSaving}>PNG</button>
            <button type="button" className={outputFormat === 'webp' ? 'is-active' : ''} aria-pressed={outputFormat === 'webp'} onClick={() => setOutputFormat('webp')} disabled={isSaving}>WebP</button>
          </div>
          <button type="button" className="messages-sticker-studio-cancel" onClick={onClose} disabled={isSaving}>إلغاء</button>
          <button type="button" className="messages-sticker-studio-save" onClick={() => void saveSticker()} disabled={!hasResult || isSaving}>
            {isSaving ? <LoaderCircle size={18} className="messages-sticker-spinner" /> : <Check size={18} />}
            حفظ الملصق {outputFormat.toUpperCase()}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
