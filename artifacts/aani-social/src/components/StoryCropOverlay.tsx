import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Loader2, X } from 'lucide-react';

type Point = { x: number; y: number };
type CropFrame = { x: number; y: number; width: number; height: number };
type CropRatioKey = '9:16' | '1:1' | '4:5' | 'original';
type CropGesture = {
  mode: 'move-frame' | 'resize';
  handle?: string;
  pointerId: number;
  startX: number;
  startY: number;
  startFrame: CropFrame;
};
type CropTransform = { zoom: number; offset: Point };

export type StoryCropApplyResult =
  | { kind: 'file'; file: File; width: number; height: number }
  | { kind: 'transform'; transform: CropTransform };

type StoryCropOverlayProps = {
  mediaUrl: string;
  isVideo: boolean;
  initialZoom: number;
  initialOffset: Point;
  initialRotation: number;
  onCancel: () => void;
  onApply: (result: StoryCropApplyResult) => void;
};

const CROP_INSET = 8;
const MIN_FRAME_SIZE = 64;
const OUTPUT_MAX_WIDTH = 1080;
const OUTPUT_MAX_HEIGHT = 1920;
const IMAGE_LOAD_TIMEOUT_MS = 20000;
const TO_BLOB_TIMEOUT_MS = 20000;
const RATIO_VALUES: Record<Exclude<CropRatioKey, 'original'>, number> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function makeFrame(width: number, height: number, aspect: number): CropFrame {
  const inset = Math.min(CROP_INSET, Math.max(0, (Math.min(width, height) - 1) / 2));
  const availableWidth = Math.max(1, width - inset * 2);
  const availableHeight = Math.max(1, height - inset * 2);
  const frameWidth = Math.max(1, Math.min(availableWidth * 0.88, availableHeight * 0.82 * aspect));
  const frameHeight = frameWidth / aspect;

  return {
    x: (width - frameWidth) / 2,
    y: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}

/** أبعاد مخرج القص: 1080×1920 كحد أقصى مع الحفاظ على نسبة الإطار. */
function computeOutputSize(aspect: number): { width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16;
  let width = OUTPUT_MAX_WIDTH;
  let height = Math.round(width / safeAspect);
  if (height > OUTPUT_MAX_HEIGHT) {
    height = OUTPUT_MAX_HEIGHT;
    width = Math.round(height * safeAspect);
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function isRemoteUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

function loadImageForCrop(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (isRemoteUrl(url)) image.crossOrigin = 'anonymous';
    image.decoding = 'async';

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(isRemoteUrl(url)
        ? 'تعذر قراءة الصورة من المصدر الخارجي (CORS). لا يمكن قصّها بأمان.'
        : 'انتهت مهلة فك ترميز الصورة.'));
    }, IMAGE_LOAD_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
    };

    image.onload = () => {
      cleanup();
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('تعذر تحديد أبعاد الصورة الأصلية.'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(isRemoteUrl(url)
        ? 'تعذر تحميل صورة الستوري من مصدرها الخارجي (CORS). أعد المحاولة أو استخدم صورة محلية.'
        : 'تعذر فك ترميز الصورة لقصّها.'));
    };
    image.src = url;
  });
}

function canvasToBlobWithTimeout(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('انتهت مهلة إنتاج الصورة المقصوصة.'));
    }, TO_BLOB_TIMEOUT_MS);

    try {
      canvas.toBlob(blob => {
        window.clearTimeout(timeout);
        if (blob) resolve(blob);
        else reject(new Error('تعذر إنتاج ملف الصورة المقصوصة.'));
      }, type, quality);
    } catch (error) {
      window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error('تعذر إنتاج ملف الصورة المقصوصة.'));
    }
  });
}

export default function StoryCropOverlay({
  mediaUrl,
  isVideo,
  initialZoom,
  initialOffset,
  initialRotation,
  onCancel,
  onApply,
}: StoryCropOverlayProps) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [mediaSize, setMediaSize] = useState({ width: 0, height: 0 });
  const [ratioKey, setRatioKey] = useState<CropRatioKey>('9:16');
  const [originalAspect, setOriginalAspect] = useState(9 / 16);
  const [frame, setFrame] = useState(() => makeFrame(window.innerWidth, window.innerHeight, RATIO_VALUES['9:16']));
  const [cropping, setCropping] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const gestureRef = useRef<CropGesture | null>(null);
  const aspect = ratioKey === 'original' ? originalAspect : RATIO_VALUES[ratioKey];

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    setFrame(makeFrame(viewport.width, viewport.height, aspect));
  }, [aspect, viewport.height, viewport.width]);

  const setOriginalRatio = (width: number, height: number) => {
    if (width > 0 && height > 0) {
      setOriginalAspect(width / height);
      setMediaSize({ width, height });
    }
  };

  const isQuarterTurn = Math.abs(Math.round(initialRotation / 90)) % 2 === 1;
  const mediaCoverScale = mediaSize.width && mediaSize.height
    ? Math.max(
        viewport.width / (isQuarterTurn ? mediaSize.height : mediaSize.width),
        viewport.height / (isQuarterTurn ? mediaSize.width : mediaSize.height),
      )
    : 1;
  const mediaStyle = {
    width: mediaSize.width ? `${mediaSize.width * mediaCoverScale}px` : '100%',
    height: mediaSize.height ? `${mediaSize.height * mediaCoverScale}px` : '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `translate(-50%, -50%) translate3d(${initialOffset.x}px, ${initialOffset.y}px, 0) scale(${initialZoom}) rotate(${initialRotation}deg)`,
    transformOrigin: 'center',
  };

  const beginPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cropping) return;
    const target = event.target as HTMLElement;
    const handle = target.closest('[data-crop-handle]')?.getAttribute('data-crop-handle') || undefined;
    const frameElement = target.closest('[data-crop-frame-edge]');
    if (!frameElement) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      mode: handle ? 'resize' : 'move-frame',
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame,
    };
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    const start = gesture.startFrame;

    if (gesture.mode === 'move-frame') {
      const insetX = Math.min(CROP_INSET, Math.max(0, (viewport.width - start.width) / 2));
      const insetY = Math.min(CROP_INSET, Math.max(0, (viewport.height - start.height) / 2));
      setFrame({
        ...start,
        x: clamp(start.x + deltaX, insetX, viewport.width - start.width - insetX),
        y: clamp(start.y + deltaY, insetY, viewport.height - start.height - insetY),
      });
      return;
    }

    const handle = gesture.handle || '';
    const horizontalDirection = handle.includes('w') ? -1 : 1;
    const verticalDirection = handle.includes('n') ? -1 : 1;
    const fixedX = horizontalDirection < 0 ? start.x + start.width : start.x;
    const fixedY = verticalDirection < 0 ? start.y + start.height : start.y;
    const insetX = Math.min(CROP_INSET, Math.max(0, (viewport.width - start.width) / 2));
    const insetY = Math.min(CROP_INSET, Math.max(0, (viewport.height - start.height) / 2));
    const maxWidth = Math.max(1, Math.min(
      horizontalDirection < 0 ? fixedX - insetX : viewport.width - insetX - fixedX,
      (verticalDirection < 0 ? fixedY - insetY : viewport.height - insetY - fixedY) * aspect,
    ));
    const minWidth = Math.min(MIN_FRAME_SIZE, maxWidth);
    const projectedWidthDelta = (
      horizontalDirection * deltaX + verticalDirection * deltaY / aspect
    ) / (1 + 1 / (aspect * aspect));
    const width = clamp(start.width + projectedWidthDelta, minWidth, maxWidth);
    const height = width / aspect;

    setFrame({
      x: horizontalDirection < 0 ? fixedX - width : fixedX,
      y: verticalDirection < 0 ? fixedY - height : fixedY,
      width,
      height,
    });
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const applyTransformOnly = () => {
    const fillScale = Math.max(viewport.width / frame.width, viewport.height / frame.height);
    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    const zoom = clamp(initialZoom * fillScale, 0.4, 4);
    const scaleFactor = zoom / Math.max(initialZoom, 0.001);

    onApply({
      kind: 'transform',
      transform: {
        zoom,
        offset: {
          x: clamp(scaleFactor * (viewport.width / 2 + initialOffset.x - centerX), -viewport.width, viewport.width),
          y: clamp(scaleFactor * (viewport.height / 2 + initialOffset.y - centerY), -viewport.height, viewport.height),
        },
      },
    });
  };

  /**
   * قص حقيقي: يرسم داخل إطار القص فقط إلى ملف جديد.
   * التحويل هنا مطابق تماماً لتحويل CSS المستخدم في المعاينة:
   *   left/top 50% + translate(-50%,-50%) + translate(offset) + scale(zoom) + rotate(deg)
   * ثم يُقاس الفرق بين إحداثيات الشاشة وإحداثيات الصورة الأصلية عبر مصفوفة عكسية
   * مكافئة، مع أخذ mediaCoverScale في الحسبان.
   */
  const buildCroppedFile = async (): Promise<{ file: File; width: number; height: number }> => {
    if (!mediaSize.width || !mediaSize.height) {
      throw new Error('انتظر اكتمال تحميل الصورة قبل القص.');
    }

    const image = await loadImageForCrop(mediaUrl);
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    if (!imageWidth || !imageHeight) throw new Error('تعذر تحديد أبعاد الصورة الأصلية.');

    const quarterTurn = Math.abs(Math.round(initialRotation / 90)) % 2 === 1;
    const cover = Math.max(
      viewport.width / (quarterTurn ? imageHeight : imageWidth),
      viewport.height / (quarterTurn ? imageWidth : imageHeight),
    );
    const drawnWidth = imageWidth * cover;
    const drawnHeight = imageHeight * cover;

    const { width: outputWidth, height: outputHeight } = computeOutputSize(frame.width / frame.height);
    const scaleX = outputWidth / Math.max(1, frame.width);
    const scaleY = outputHeight / Math.max(1, frame.height);

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('تعذر تجهيز لوحة القص.');

    context.save();
    // screen space → output space (frame only)
    context.setTransform(scaleX, 0, 0, scaleY, -frame.x * scaleX, -frame.y * scaleY);
    // the same screen-space transform used by the preview <img>
    context.translate(viewport.width / 2 + initialOffset.x, viewport.height / 2 + initialOffset.y);
    context.rotate((initialRotation * Math.PI) / 180);
    context.scale(initialZoom, initialZoom);
    context.drawImage(image, -drawnWidth / 2, -drawnHeight / 2, drawnWidth, drawnHeight);
    context.restore();

    const blob = await canvasToBlobWithTimeout(canvas, 'image/jpeg', 0.92);
    if (!blob || blob.size <= 0 || !blob.type.startsWith('image/')) {
      throw new Error('الملف المقصوص غير صالح (فارغ أو بنوع غير مدعوم).');
    }

    const file = new File([blob], `story-crop-${Date.now()}.jpg`, {
      type: blob.type,
      lastModified: Date.now(),
    });
    if (file.size !== blob.size) throw new Error('تعذر إنشاء ملف الصورة المقصوصة.');

    return { file, width: outputWidth, height: outputHeight };
  };

  const applyCrop = async () => {
    if (cropping) return;
    setCropError(null);

    if (isVideo) {
      // الفيديو لا يُحوّل إلى صورة: يبقى مسار emulated transform كما هو.
      applyTransformOnly();
      return;
    }

    setCropping(true);
    try {
      const cropped = await buildCroppedFile();
      onApply({ kind: 'file', file: cropped.file, width: cropped.width, height: cropped.height });
    } catch (error) {
      console.warn('[story crop] stage=crop failed', {
        code: error instanceof DOMException ? error.name : 'crop-error',
      });
      setCropError(error instanceof Error ? error.message : 'تعذر قص الصورة. حاول مرة أخرى.');
    } finally {
      setCropping(false);
    }
  };

  const resizeHandles = [
    { key: 'nw', className: '-left-0.5 -top-0.5 rounded-tl-sm border-l-4 border-t-4', cursor: 'cursor-nwse-resize', label: 'تغيير حجم إطار القص من الزاوية العلوية اليسرى' },
    { key: 'ne', className: '-right-0.5 -top-0.5 rounded-tr-sm border-r-4 border-t-4', cursor: 'cursor-nesw-resize', label: 'تغيير حجم إطار القص من الزاوية العلوية اليمنى' },
    { key: 'sw', className: '-bottom-0.5 -left-0.5 rounded-bl-sm border-b-4 border-l-4', cursor: 'cursor-nesw-resize', label: 'تغيير حجم إطار القص من الزاوية السفلية اليسرى' },
    { key: 'se', className: '-bottom-0.5 -right-0.5 rounded-br-sm border-b-4 border-r-4', cursor: 'cursor-nwse-resize', label: 'تغيير حجم إطار القص من الزاوية السفلية اليمنى' },
  ];
  const framePath = `M0 0H${viewport.width}V${viewport.height}H0Z M${frame.x} ${frame.y}H${frame.x + frame.width}V${frame.y + frame.height}H${frame.x}Z`;

  return (
    <div
      className="fixed inset-0 z-[170] overflow-hidden bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="قص الوسيط"
      onPointerDown={beginPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      style={{ touchAction: 'none' }}
    >
      {isVideo ? (
        <video
          src={mediaUrl}
          autoPlay
          loop
          muted
          playsInline
          onLoadedMetadata={event => setOriginalRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          className="pointer-events-none absolute left-1/2 top-1/2"
          style={mediaStyle}
        />
      ) : (
        <img
          src={mediaUrl}
          alt=""
          draggable={false}
          onLoad={event => setOriginalRatio(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          className="pointer-events-none absolute left-1/2 top-1/2 select-none"
          style={mediaStyle}
        />
      )}

      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${viewport.width} ${viewport.height}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={framePath} fill="rgba(0,0,0,0.62)" fillRule="evenodd" />
      </svg>

      <div
        data-crop-frame-edge="true"
        className="pointer-events-auto absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, touchAction: 'none' }}
      >
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} className={`${index % 3 < 2 ? 'border-r border-white/40' : ''} ${index < 6 ? 'border-b border-white/40' : ''}`} />
          ))}
        </div>
        {resizeHandles.map(handle => (
          <button
            key={handle.key}
            type="button"
            data-crop-handle={handle.key}
            aria-label={handle.label}
            className={`absolute z-10 h-8 w-8 bg-transparent p-0 ${handle.cursor} ${handle.className} border-white`}
          />
        ))}
      </div>

      {cropError && (
        <div className="pointer-events-none fixed inset-x-4 top-1/2 z-30 -translate-y-1/2 rounded-2xl border border-red-300/40 bg-red-950/90 p-3 text-center text-xs leading-5 text-red-100 backdrop-blur-md" role="alert">
          {cropError}
        </div>
      )}

      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <button
          type="button"
          data-crop-control="true"
          onClick={onCancel}
          disabled={cropping}
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md disabled:opacity-50"
          aria-label="إلغاء القص"
        >
          <X size={21} />
        </button>
        <span className="rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold backdrop-blur-md">
          {isVideo ? 'قص الوسيط' : 'قص الصورة'}
        </span>
        <button
          type="button"
          data-crop-control="true"
          onClick={() => void applyCrop()}
          disabled={cropping}
          className="pointer-events-auto flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-xs font-bold text-black disabled:opacity-60"
        >
          {cropping ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {cropping ? 'جارٍ القص...' : 'تطبيق القص'}
        </button>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="rounded-full bg-black/50 px-3 py-1 text-[10px] text-white/75 backdrop-blur-md">اسحب الإطار للتحريك، واسحب الزوايا لتغيير الحجم</p>
        <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-full border border-white/10 bg-black/65 p-1.5 backdrop-blur-xl" dir="ltr" data-crop-control="true">
          {(['9:16', '1:1', '4:5', 'original'] as CropRatioKey[]).map(option => (
            <button
              key={option}
              type="button"
              disabled={cropping}
              onClick={() => setRatioKey(option)}
              aria-pressed={ratioKey === option}
              className={`shrink-0 rounded-full px-3 py-2 text-[11px] font-semibold transition disabled:opacity-50 ${ratioKey === option ? 'bg-white text-black' : 'text-white/75 hover:bg-white/10'}`}
            >
              {option === 'original' ? 'الأصلية' : option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
