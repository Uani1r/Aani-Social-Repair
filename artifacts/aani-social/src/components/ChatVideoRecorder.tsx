import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, X, Circle, StopCircle, RotateCcw, Mic, MicOff, Camera } from 'lucide-react';
import { toast } from 'sonner';
import { uploadMedia } from '@/lib/storyUpload';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';

type ChatVideoRecorderProps = {
  currentUserId: string;
  recipientId: string | null | undefined;
  onRecorded?: (videoUrl: string, durationSeconds: number, viewOnce: boolean) => void;
  onCancel?: () => void;
};

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: { ideal: 'user' },
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
} as const;

const MAX_DURATION_SECONDS = 60;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const TARGET_BITRATE_BPS = 1_500_000; // 1.5 Mbps

// ترتيب أولوية MIME للفيديو: نتحقق من الدعم الفعلي عبر MediaRecorder.isTypeSupported
// لا نفترض أن كل الأجهزة تدعم MP4/H.264 — إذا لم يدعم الجهاز الصيغة المطلوبة، نوقف الإرسال
// ونعرض رسالة واضحة للمستخدم بدلاً من رفع ملف غير متوافق.
const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42001E,mp4a.40.2', // H.264 Baseline + AAC
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 Main + AAC
  'video/mp4;codecs=avc1.4D401E,mp4a.40.2', // H.264 High + AAC
  'video/mp4', // عام - المتصفح يختار
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=h264,opus',
] as const;

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const mimeType of VIDEO_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    } catch {
      // تجاهل وتجربة التالي
    }
  }
  return null;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// تحديد الامتداد الصحيح ونوع MIME بناءً على الصيغة الفعلية المدعومة
function getFileExtensionAndMimeType(mimeType: string): { extension: string; mimeType: string } {
  if (mimeType.startsWith('video/mp4')) {
    return { extension: 'mp4', mimeType: 'video/mp4' };
  }
  if (mimeType.startsWith('video/webm')) {
    return { extension: 'webm', mimeType: 'video/webm' };
  }
  // fallback - لا ينبغي الوصول إليه لأننا نتحقق من الدعم مسبقاً
  return { extension: 'mp4', mimeType: 'video/mp4' };
}

export default function ChatVideoRecorder({
  currentUserId,
  recipientId,
  onRecorded,
  onCancel,
}: ChatVideoRecorderProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const maxDurationReachedRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewBlobRef = useRef<Blob | null>(null);
  const isMountedRef = useRef(true);
  const startCameraCalledRef = useRef(false);

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);
  const [selectedMimeType, setSelectedMimeType] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // تنظيف الموارد
  const cleanup = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current) {
      try {
        if (recorderRef.current.state === 'recording' || recorderRef.current.state === 'paused') {
          recorderRef.current.stop();
        }
      } catch {
        // تجاهل
      }
      recorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    setRecording(false);
    setPaused(false);
    setElapsedSeconds(0);
    maxDurationReachedRef.current = false;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    previewBlobRef.current = null;
    setShowPreview(false);
  }, []);

  // إيقاف الكاميرا وجميع المسارات فور إلغاء التصوير أو الانتهاء منه
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  const startCamera = useCallback(async () => {
    // منع تشغيل متزامن متعدد
    if (startCameraCalledRef.current) return;
    startCameraCalledRef.current = true;

    try {
      setCameraError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...VIDEO_CONSTRAINTS.video,
          facingMode: { ideal: facingMode },
        },
        audio: audioEnabled ? VIDEO_CONSTRAINTS.audio : false,
      });
      
      if (!isMountedRef.current) {
        mediaStream.getTracks().forEach(track => track.stop());
        startCameraCalledRef.current = false;
        return;
      }

      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (error) {
      console.error('[ChatVideoRecorder] تعذر الوصول للكاميرا:', error);
      const err = error as Error & { name?: string };
      let errorMessage = 'تعذر تشغيل الكاميرا. تحقق من الأذونات وحاول مرة أخرى.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMessage = 'تم رفض إذن الكاميرا/الميكروفون. يرجى السماح بالوصول من إعدادات المتصفح.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMessage = 'لم يتم العثور على كاميرا/ميكروفون على هذا الجهاز.';
      } else if (err.name === 'OverconstrainedError') {
        errorMessage = 'إعدادات الكاميرا المطلوبة غير مدعومة على هذا الجهاز.';
      }
      setCameraError(errorMessage);
      onCancel?.();
    } finally {
      startCameraCalledRef.current = false;
    }
  }, [facingMode, audioEnabled, onCancel]);

  // تشغيل الكاميرا مرة واحدة فقط عند التركيب (mount)
  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- نريد تشغيل الكاميرا مرة واحدة فقط

  const toggleRecording = useCallback(async () => {
    if (!streamRef.current || recorderRef.current) return;

    const mimeType = pickSupportedMimeType();
    if (!mimeType && typeof MediaRecorder !== 'undefined') {
      console.warn('[ChatVideoRecorder] لا يوجد نوع MIME مدعوم صريحاً، سيُستخدم الافتراضي');
    }

    // التحقق من دعم الصيغة المطلوبة (MP4) — إذا لم يدعم الجهاز MP4، نوقف ونعرض رسالة
    const needsMp4 = true; // المتطلب: فيديوهات المحادثات يجب أن تكون MP4 للتوافق
    const supportsMp4 = mimeType?.startsWith('video/mp4') ?? false;
    
    if (needsMp4 && !supportsMp4) {
      const msg = 'هذا المتصفح/الجهاز لا يدعم تسجيل الفيديو بصيغة MP4/H.264 المطلوبة للتوافق مع جميع الأجهزة. يرجى استخدام متصفح حديث (Chrome، Firefox، Safari 14+) أو جهاز أحدث.';
      toast.error(msg);
      console.error('[ChatVideoRecorder] MP4/H.264 غير مدعوم:', mimeType);
      return;
    }

    try {
      chunksRef.current = [];
      setSelectedMimeType(mimeType);

      const mediaRecorder = new MediaRecorder(
        streamRef.current,
        mimeType ? { mimeType, videoBitsPerSecond: TARGET_BITRATE_BPS } : { videoBitsPerSecond: TARGET_BITRATE_BPS }
      );
      recorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (!isMountedRef.current) return;
        
        const recordedMimeType = mediaRecorder.mimeType || mimeType || 'video/mp4';
        const blob = new Blob(chunksRef.current, { type: recordedMimeType });
        
        if (blob.size > 0) {
          previewBlobRef.current = blob;
          const url = URL.createObjectURL(blob);
          previewUrlRef.current = url;
          setShowPreview(true);
        }
        setRecording(false);
        setPaused(false);
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        recorderRef.current = null;
      };

      mediaRecorder.onerror = event => {
        console.error('[ChatVideoRecorder] خطأ في التسجيل:', event);
        toast.error('حدث خطأ أثناء التسجيل.');
        cleanup();
      };

      mediaRecorder.start(100); // تجميع البيانات كل 100ms
      setRecording(true);
      setPaused(false);
      setElapsedSeconds(0);
      maxDurationReachedRef.current = false;

      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(prev => {
          const next = prev + 1;
          if (next >= MAX_DURATION_SECONDS && !maxDurationReachedRef.current) {
            maxDurationReachedRef.current = true;
            const currentRecorder = recorderRef.current;
            if (currentRecorder && currentRecorder.state === 'recording') {
              currentRecorder.stop();
            }
          }
          return next;
        });
      }, 1000);
    } catch (error) {
      console.error('[ChatVideoRecorder] تعذر بدء التسجيل:', error);
      toast.error('تعذر بدء التسجيل. تحقق من دعم المتصفح.');
    }
  }, [cleanup]);

  const pauseResumeRecording = useCallback(() => {
    if (!recorderRef.current) return;
    if (recorderRef.current.state === 'recording') {
      recorderRef.current.pause();
      setPaused(true);
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } else if (recorderRef.current.state === 'paused') {
      recorderRef.current.resume();
      setPaused(false);
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(prev => {
          const next = prev + 1;
          if (next >= MAX_DURATION_SECONDS && !maxDurationReachedRef.current) {
            maxDurationReachedRef.current = true;
            const currentRecorder = recorderRef.current;
            if (currentRecorder && currentRecorder.state === 'recording') {
              currentRecorder.stop();
            }
          }
          return next;
        });
      }, 1000);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && (recorderRef.current.state === 'recording' || recorderRef.current.state === 'paused')) {
      recorderRef.current.stop();
    }
  }, []);

  const retake = useCallback(() => {
    setShowPreview(false);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    previewBlobRef.current = null;
    chunksRef.current = [];
    recorderRef.current = null;
    setElapsedSeconds(0);
    maxDurationReachedRef.current = false;
  }, []);

  const flipCamera = useCallback(() => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    // إيقاف المسار السابق ثم تشغيل الكاميرا المطلوبة مرة واحدة
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    startCamera();
  }, [facingMode, startCamera]);

  const toggleAudio = useCallback(() => {
    const nextEnabled = !audioEnabled;
    setAudioEnabled(nextEnabled);
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(track => {
        track.enabled = nextEnabled;
      });
    }
  }, [audioEnabled]);

  const sendVideo = useCallback(async () => {
    const previewBlob = previewBlobRef.current;
    if (!previewBlob || uploading) return;
    if (!recipientId || !supabaseConfigured) {
      toast.error('تعذر إرسال الفيديو: المحادثة غير جاهزة.');
      return;
    }

    // التحقق من الحجم (25MB كحد أقصى)
    if (previewBlob.size > MAX_FILE_SIZE_BYTES) {
      toast.error('حجم الفيديو يتجاوز 25 ميغابايت. سجل مقطعاً أقصر.');
      return;
    }

    // التحقق من المدة (60 ثانية كحد أقصى)
    if (elapsedSeconds > MAX_DURATION_SECONDS) {
      toast.error('مدة الفيديو تتجاوز 60 ثانية. سجل مقطعاً أقصر.');
      return;
    }

    // التحقق من نوع MIME الفعلي للتسجيل
    const recordedMimeType = recorderRef.current?.mimeType || selectedMimeType || 'video/mp4';
    const { extension, mimeType } = getFileExtensionAndMimeType(recordedMimeType);

    // لا نسمح برفع WebM بامتداد MP4 أو type video/mp4
    // إذا كانت النتيجة WebM، نستخدم امتداد .webm و type video/webm
    // إذا لم يدعم الجهاز MP4، فقد تم منع التسجيل مسبقاً في toggleRecording

    setUploading(true);
    try {
      const safeName = `video-${Date.now()}.${extension}`;
      const path = `${currentUserId}/messages/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
      
      await uploadMedia({
        file: new File([previewBlob], safeName, { type: mimeType, lastModified: Date.now() }),
        path,
        preset: 'video',
        skipCompression: true, // رفع مباشر دون ضغط للفيديوهات المسجلة بالكاميرا
        onPhase: (phase, percent) => {
          if (phase === 'uploading' && percent) {
            // يمكن إضافة مؤشر تقدم هنا
          }
        },
      });

      const { data: publicUrlData } = supabase.storage.from(storageBucket).getPublicUrl(path);
      const videoUrl = publicUrlData.publicUrl;

      onRecorded?.(videoUrl, elapsedSeconds, viewOnce);
      
      // تنظيف بعد الإرسال الناجح
      cleanup();
      toast.success('تم إرسال الفيديو');
    } catch (error) {
      console.error('[ChatVideoRecorder] تعذر إرسال الفيديو:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال الفيديو. حاول مرة أخرى.');
    } finally {
      setUploading(false);
    }
  }, [uploading, recipientId, currentUserId, elapsedSeconds, viewOnce, onRecorded, cleanup, selectedMimeType]);

  const handleClose = useCallback(() => {
    cleanup();
    onCancel?.();
  }, [cleanup, onCancel]);

  // واجهة التسجيل
  if (!showPreview) {
    if (cameraError) {
      return (
        <div className="chat-video-recorder" role="dialog" aria-modal="true" aria-label="خطأ الكاميرا" dir="rtl">
          <div className="chat-video-recorder-error">
            <X size={48} className="chat-video-recorder-error-icon" />
            <p>{cameraError}</p>
            <button type="button" className="chat-video-recorder-retry-btn" onClick={handleClose}>
              إغلاق
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="chat-video-recorder" role="dialog" aria-modal="true" aria-label="تسجيل فيديو" dir="rtl">
        <header className="chat-video-recorder-header">
          <button type="button" className="chat-video-recorder-close" aria-label="إغلاق الكاميرا" onClick={handleClose}>
            <X size={24} />
          </button>
          <span className="chat-video-recorder-title">تسجيل فيديو</span>
          <div className="chat-video-recorder-controls">
            <button
              type="button"
              className={`chat-video-recorder-btn${audioEnabled ? '' : ' is-off'}`}
              aria-label={audioEnabled ? 'كتم الميكروفون' : 'تفعيل الميكروفون'}
              aria-pressed={audioEnabled}
              onClick={toggleAudio}
              disabled={recording}
            >
              {audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
            </button>
            <button
              type="button"
              className="chat-video-recorder-btn"
              aria-label="تبديل الكاميرا"
              onClick={flipCamera}
              disabled={recording}
            >
              <Camera size={20} />
            </button>
          </div>
        </header>

        <div className="chat-video-recorder-preview" ref={el => { if (el) videoRef.current = el.querySelector('video') || null; }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="chat-video-recorder-video"
            aria-hidden="true"
          />
          {recording && <div className="chat-video-recorder-recording-indicator" aria-live="polite">● تسجيل</div>}
        </div>

        <div className="chat-video-recorder-timer" aria-live="polite">
          {formatDuration(elapsedSeconds)} / {formatDuration(MAX_DURATION_SECONDS)}
        </div>

        <div className="chat-video-recorder-progress">
          <div
            className="chat-video-recorder-progress-bar"
            style={{ width: `${Math.min(100, (elapsedSeconds / MAX_DURATION_SECONDS) * 100)}%` }}
            role="progressbar"
            aria-valuenow={elapsedSeconds}
            aria-valuemin={0}
            aria-valuemax={MAX_DURATION_SECONDS}
            aria-label="تقدم التسجيل"
          />
        </div>

        <footer className="chat-video-recorder-footer">
          {!recording && elapsedSeconds === 0 ? (
            <button
              type="button"
              className="chat-video-recorder-record-btn"
              aria-label="بدء التسجيل"
              onClick={toggleRecording}
              disabled={!streamRef.current}
            >
              <Circle size={28} className="chat-video-recorder-record-icon" />
              <span>ابدأ التسجيل</span>
            </button>
          ) : recording ? (
            <div className="chat-video-recorder-recording-controls">
              <button
                type="button"
                className={`chat-video-recorder-control-btn${paused ? ' is-paused' : ''}`}
                aria-label={paused ? 'استئناف التسجيل' : 'إيقاف مؤقت'}
                onClick={pauseResumeRecording}
              >
                {paused ? <Circle size={24} /> : <Video size={24} />}
              </button>
              <button
                type="button"
                className="chat-video-recorder-stop-btn"
                aria-label="إيقاف التسجيل"
                onClick={stopRecording}
              >
                <StopCircle size={32} fill="currentColor" />
              </button>
            </div>
          ) : (
            <div className="chat-video-recorder-post-record-controls">
              <button
                type="button"
                className="chat-video-recorder-retake-btn"
                aria-label="إعادة التسجيل"
                onClick={retake}
              >
                <RotateCcw size={22} />
                <span>إعادة</span>
              </button>
              <label className="chat-video-recorder-once-label">
                <input
                  type="checkbox"
                  checked={viewOnce}
                  onChange={e => setViewOnce(e.target.checked)}
                  aria-label="عرض مرة واحدة"
                  disabled={uploading}
                />
                <span>عرض مرة واحدة</span>
              </label>
              <button
                type="button"
                className="chat-video-recorder-send-btn"
                aria-label="إرسال الفيديو"
                onClick={sendVideo}
                disabled={uploading}
              >
                {uploading ? (
                  <>
                    <span className="chat-video-recorder-spinner" />
                    <span>جاري الإرسال...</span>
                  </>
                ) : (
                  <>
                    <span>إرسال</span>
                  </>
                )}
              </button>
            </div>
          )}
        </footer>
      </div>
    );
  }

  // واجهة المعاينة بعد التسجيل
  return (
    <div className="chat-video-recorder chat-video-recorder-preview-mode" role="dialog" aria-modal="true" aria-label="معاينة الفيديو" dir="rtl">
      <header className="chat-video-recorder-header">
        <button type="button" className="chat-video-recorder-close" aria-label="إغلاق المعاينة" onClick={handleClose}>
          <X size={24} />
        </button>
        <span className="chat-video-recorder-title">معاينة الفيديو</span>
        <div className="chat-video-recorder-controls">
          <label className="chat-video-recorder-once-label">
            <input
              type="checkbox"
              checked={viewOnce}
              onChange={e => setViewOnce(e.target.checked)}
              aria-label="عرض مرة واحدة"
              disabled={uploading}
            />
            <span>عرض مرة واحدة</span>
          </label>
        </div>
      </header>

      <div className="chat-video-recorder-preview">
        <video
          src={previewUrlRef.current || ''}
          controls
          playsInline
          className="chat-video-recorder-video"
          aria-label="معاينة الفيديو المسجل"
        />
        <div className="chat-video-recorder-duration" aria-live="polite">
          {formatDuration(elapsedSeconds)}
        </div>
      </div>

      <footer className="chat-video-recorder-footer">
        <div className="chat-video-recorder-post-record-controls">
          <button
            type="button"
            className="chat-video-recorder-retake-btn"
            aria-label="إعادة التسجيل"
            onClick={retake}
            disabled={uploading}
          >
            <RotateCcw size={22} />
            <span>إعادة</span>
          </button>
          <button
            type="button"
            className="chat-video-recorder-send-btn"
            aria-label="إرسال الفيديو"
            onClick={sendVideo}
            disabled={uploading}
          >
            {uploading ? (
              <>
                <span className="chat-video-recorder-spinner" />
                <span>جاري الإرسال...</span>
              </>
            ) : (
              <>
                <span>إرسال</span>
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}