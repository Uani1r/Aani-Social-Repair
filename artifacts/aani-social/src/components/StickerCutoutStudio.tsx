import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Upload, X } from 'lucide-react';

export interface StickerCutoutStudioProps {
  open: boolean;
  onClose: () => void;
  onDone: (dataUrl: string) => void;
}

const MAX_SIDE = 900;

/** تعبئة من نقطة واحدة: تُعلّم البكسلات المتصلة المشابهة للون النقطة */
function floodFillMask(
  mask: Uint8Array,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
) {
  const sx = Math.max(0, Math.min(width - 1, Math.round(startX)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(startY)));
  const start = sy * width + sx;
  const seedR = data[start * 4];
  const seedG = data[start * 4 + 1];
  const seedB = data[start * 4 + 2];
  const limit = tolerance * tolerance * 3;

  const visited = new Uint8Array(width * height);
  const stack: number[] = [start];

  while (stack.length > 0) {
    const point = stack.pop() as number;
    if (visited[point]) continue;
    visited[point] = 1;

    const index = point * 4;
    const dr = data[index] - seedR;
    const dg = data[index + 1] - seedG;
    const db = data[index + 2] - seedB;
    if (dr * dr + dg * dg + db * db > limit) continue;

    mask[point] = 1;

    const x = point % width;
    const y = (point - x) / width;
    if (x > 0) stack.push(point - 1);
    if (x < width - 1) stack.push(point + 1);
    if (y > 0) stack.push(point - width);
    if (y < height - 1) stack.push(point + width);
  }
}

export default function StickerCutoutStudio({ open, onClose, onDone }: StickerCutoutStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const originalRef = useRef<ImageData | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const [hasImage, setHasImage] = useState(false);
  const [cutDone, setCutDone] = useState(false);
  const [tolerance, setTolerance] = useState(48);
  const [status, setStatus] = useState('اختر صورة لقص ملصق منها');

  useEffect(() => {
    if (!open) return;

    setHasImage(false);
    setCutDone(false);
    setStatus('اختر صورة لقص ملصق منها');
    originalRef.current = null;
    lastPointRef.current = null;

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const timer = window.setTimeout(() => fileRef.current?.click(), 250);
    return () => window.clearTimeout(timer);
  }, [open]);

  const runCut = useCallback((originX: number, originY: number, mode: 'keep' | 'remove', tol: number) => {
    const canvas = canvasRef.current;
    const original = originalRef.current;
    if (!canvas || !original) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, data } = original;
    const mask = new Uint8Array(width * height);
    floodFillMask(mask, data, width, height, originX, originY, tol);

    const output = new ImageData(new Uint8ClampedArray(data), width, height);
    for (let i = 0; i < mask.length; i += 1) {
      const shouldClear = mode === 'keep' ? !mask[i] : Boolean(mask[i]);
      if (shouldClear) output.data[i * 4 + 3] = 0;
    }

    ctx.putImageData(output, 0, 0);
    lastPointRef.current = { x: originX, y: originY };
    setCutDone(true);
    setStatus(mode === 'keep' ? 'تم قص العنصر — اضغط «تم» للحفظ' : 'تمت إزالة الخلفية — اضغط «تم» للحفظ');
  }, []);

  // تغيير دقة القص يعيد تنفيذ آخر عملية قص
  useEffect(() => {
    const last = lastPointRef.current;
    if (!cutDone || !last) return;
    runCut(last.x, last.y, 'keep', tolerance);
  }, [tolerance, cutDone, runCut]);

  const loadFile = (file: File) => {
    const url = URL.createObjectURL(file);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;

    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      originalRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);

      lastPointRef.current = null;
      setHasImage(true);
      setCutDone(false);
      setStatus('اضغط على العنصر الذي تريد قصّه');
    };
    image.src = url;
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) loadFile(file);
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !originalRef.current) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    runCut(x, y, 'keep', tolerance);
  };

  const handleReset = () => {
    const canvas = canvasRef.current;
    const original = originalRef.current;
    if (!canvas || !original) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(original, 0, 0);
    lastPointRef.current = null;
    setCutDone(false);
    setStatus('اضغط على العنصر الذي تريد قصّه');
  };

  const handleConfirm = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasImage) return;
    onDone(canvas.toDataURL('image/png'));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b0b0e] text-white" dir="rtl">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق"
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10"
        >
          <X size={22} />
        </button>
        <span className="text-[13px] font-bold">صنع ملصق</span>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!hasImage}
          className="rounded-full bg-white px-4 py-1.5 text-[12px] font-bold text-[#121212] transition disabled:opacity-40"
        >
          تم
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center px-4">
        {hasImage ? (
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className="max-h-[58vh] max-w-full cursor-crosshair rounded-xl ring-1 ring-white/10"
            style={{
              touchAction: 'manipulation',
              background: 'repeating-conic-gradient(#1c1c22 0% 25%, #101015 0% 50%) 50% / 18px 18px',
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/25 px-8 py-10 text-white/60 transition active:scale-95"
          >
            <Upload size={26} />
            <span className="text-[12px]">اختر صورة من المعرض</span>
          </button>
        )}
      </div>

      <p className="px-6 pb-2 text-center text-[11px] leading-5 text-white/50">{status}</p>

      <div
        className="flex items-center gap-2 px-4 pt-1"
        style={{ paddingBottom: 'calc(0.9rem + env(safe-area-inset-bottom))' }}
      >
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 text-[11px] transition active:scale-95"
        >
          <Upload size={14} />
          صورة أخرى
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!cutDone}
          className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 text-[11px] transition active:scale-95 disabled:opacity-40"
        >
          <RotateCcw size={14} />
          إعادة
        </button>
        <div className="flex flex-1 items-center gap-2 rounded-full bg-white/10 px-3 py-1.5">
          <span className="shrink-0 text-[10px] text-white/60">دقة القص</span>
          <input
            type="range"
            min={10}
            max={120}
            value={tolerance}
            onChange={event => setTolerance(Number(event.target.value))}
            aria-label="دقة القص"
            className="h-1 w-full accent-white"
          />
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
    </div>
  );
}
