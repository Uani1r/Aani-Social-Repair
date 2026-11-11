const POSTER_MAX_BYTES = 100 * 1024;
const POSTER_MAX_WIDTH = 720;

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('انتهت مهلة تجهيز إطار الفيديو.'));
    }, 15000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('تعذر قراءة الفيديو لإنشاء صورة الغلاف.'));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function encodeCanvas(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(blob => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

export async function createVideoPoster(source: File): Promise<File> {
  const objectUrl = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;

  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata');
    video.load();
    await metadataReady;

    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
      throw new Error('تعذر تحديد أبعاد الفيديو.');
    }

    const frameTime = video.duration >= 0.4 ? 0.4 : 0;
    if (frameTime > 0) {
      const seekReady = waitForVideoEvent(video, 'seeked');
      video.currentTime = frameTime;
      await seekReady;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const frameReady = waitForVideoEvent(video, 'loadeddata');
      await frameReady;
    }

    const canvas = document.createElement('canvas');
    let width = Math.min(POSTER_MAX_WIDTH, video.videoWidth);
    const mimeTypes = ['image/webp', 'image/jpeg'];
    const qualities = [0.84, 0.72, 0.6, 0.48, 0.36, 0.28];

    while (width >= 80) {
      const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز صورة الغلاف.');
      context.drawImage(video, 0, 0, width, height);

      for (const mimeType of mimeTypes) {
        for (const quality of qualities) {
          const blob = await encodeCanvas(canvas, mimeType, quality);
          if (!blob || blob.size >= POSTER_MAX_BYTES) continue;
          if (blob.type !== 'image/webp' && blob.type !== 'image/jpeg') continue;
          const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
          return new File([blob], `poster-${Date.now()}.${extension}`, {
            type: blob.type,
            lastModified: Date.now(),
          });
        }
      }

      width = Math.floor(width * 0.82);
    }

    throw new Error('تعذر ضغط صورة الغلاف إلى أقل من 100KB.');
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
