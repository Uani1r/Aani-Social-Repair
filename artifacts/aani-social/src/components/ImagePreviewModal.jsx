import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AtSign, Crop, Loader2, MapPin, Minus, Music2, Play, Plus, Search, X } from 'lucide-react';

import { getSoundLibraryState, setSoundLibraryState, subscribeSoundLibrary } from '@/audio/SoundLibraryStore';

import Avatar from '@/components/Avatar';
import PostMetadataChips from '@/components/PostMetadataChips';
import UserIdentity from '@/components/UserIdentity';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { OPEN_SOUND_PICKER_EVENT, openSoundPicker } from '@/lib/sounds';
import { preview as previewAudio, stop as stopAudioEngine } from '@/audio/AudioEngine';
import { resumeInstantIfSame } from '@/lib/instantAudio';
import { appendVideoTrimFragment, DEFAULT_IMAGE_ASPECT_LABEL, IMAGE_ASPECT_OPTIONS } from '@/lib/videoMedia';
import { supabase } from '@/lib/supabase';
import { displayName } from '@/lib/types';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
// القياس الافتراضي القياسي لإنستغرام: 4:5
const OUTPUT_WIDTH = 1080;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const distanceBetween = (first, second) => Math.hypot(second.x - first.x, second.y - first.y);

const mapsUrl = query => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر تجهيز الصورة.'));
  reader.onerror = () => reject(reader.error || new Error('تعذر تجهيز الصورة.'));
  reader.readAsDataURL(blob);
});

function getImageElement(frame) {
  return frame?.querySelector('img') || null;
}

function getImageBounds(frame, image, zoom) {
  if (!frame || !image?.naturalWidth || !image?.naturalHeight) return { maxX: 0, maxY: 0 };
  const frameBounds = frame.getBoundingClientRect();
  const coverScale = Math.max(frameBounds.width / image.naturalWidth, frameBounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * coverScale * zoom;
  const renderedHeight = image.naturalHeight * coverScale * zoom;
  return {
    maxX: Math.max(0, (renderedWidth - frameBounds.width) / 2),
    maxY: Math.max(0, (renderedHeight - frameBounds.height) / 2),
  };
}

// القص وفق القالب المختار (4:5 / 3:4 / 9:16) وفق موضع الصورة وتكبيرها
async function cropImage(image, view, frameBounds, aspectValue, aspectLabel) {
  const source = new window.Image();
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error('تعذر تحميل الصورة للقص.'));
    source.src = image.dataUrl;
  });

  const coverScale = Math.max(frameBounds.width / source.naturalWidth, frameBounds.height / source.naturalHeight);
  const renderedScale = coverScale * view.scale;
  const sourceWidth = Math.min(source.naturalWidth, frameBounds.width / renderedScale);
  const sourceHeight = Math.min(source.naturalHeight, frameBounds.height / renderedScale);
  const sourceX = clamp((source.naturalWidth - sourceWidth) / 2 - view.x / renderedScale, 0, source.naturalWidth - sourceWidth);
  const sourceY = clamp((source.naturalHeight - sourceHeight) / 2 - view.y / renderedScale, 0, source.naturalHeight - sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = Math.round(OUTPUT_WIDTH / aspectValue);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر تجهيز مساحة القص.');
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

  const outputType = image.file.type === 'image/png' || image.file.type === 'image/webp'
    ? image.file.type
    : 'image/jpeg';
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('تعذر حفظ الصورة المقصوصة.')), outputType, 0.92);
  });
  const extension = outputType === 'image/png' ? 'png' : outputType === 'image/webp' ? 'webp' : 'jpg';
  const option = IMAGE_ASPECT_OPTIONS.find(item => item.label === aspectLabel);
  const aspectSuffix = option ? option.suffix : '4x5';
  const originalName = image.file.name.replace(/\.[^.]+$/, '');
  const file = new File([blob], `${originalName}-cropped-${aspectSuffix}.${extension}`, {
    type: outputType,
    lastModified: Date.now(),
  });

  return { file, dataUrl: await blobToDataUrl(blob) };
}

// الشاشة الموحدة لإنشاء منشور الصور: معاينة الوسائط + الوصف + الأدوات كنوافذ سفلية
// (القص، الموسيقى، الإشارة إلى حساب، الموقع) + زر «نشر» مباشر في الهيدر.
export default function ImagePreviewModal({
  open,
  images,
  onImagesChange,
  music,
  onClearMusic,
  caption,
  onCaptionChange,
  tags,
  onTagsChange,
  destination,
  onDestinationChange,
  userId,
  onPublish,
  onClose,
}) {
  useOverlayBack(open, onClose);
  const trackRef = useRef(null);
  const cropFrameRef = useRef(null);
  const frameRefsRef = useRef([]);
  const cropPointersRef = useRef(new Map());
  const cropGestureRef = useRef(null);
  const cropViewsRef = useRef(new Map());
  const onCloseRef = useRef(onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cropView, setCropView] = useState({ scale: MIN_ZOOM, x: 0, y: 0 });
  // قالب كل صورة: '4:5' (افتراضي) أو '3:4' أو '9:16'
  const [cropModes, setCropModes] = useState({});
  const [cropError, setCropError] = useState('');
  const [isFinishing, setIsFinishing] = useState(false);
  const activeImage = images[activeIndex];
  const activeMode = cropModes[activeIndex] || DEFAULT_IMAGE_ASPECT_LABEL;

  // النوافذ السفلية: 'crop' | 'mention' | 'location' — تفتح فوق الشاشة الموحدة وتغلق للعودة إليها
  const [toolPanel, setToolPanel] = useState(null);
  const [mentionInput, setMentionInput] = useState('');
  const [mentionResults, setMentionResults] = useState([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [locationInput, setLocationInput] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [tagError, setTagError] = useState('');

  const aspectFor = index => {
    const label = cropModes[index] || DEFAULT_IMAGE_ASPECT_LABEL;
    const option = IMAGE_ASPECT_OPTIONS.find(item => item.label === label);
    return option ? option.value : 4 / 5;
  };

  const updateCropView = (index, view) => {
    cropViewsRef.current.set(index, view);
    if (index === activeIndex) setCropView(view);
  };

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      cropPointersRef.current.clear();
      cropGestureRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      cropViewsRef.current.clear();
      setCropModes({});
      setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
      setCropError('');
      setToolPanel(null);
      setMentionInput('');
      setLocationInput('');
      setTagError('');
    }
  }, [open, images.length]);

  // استرجاع ضبط الصورة عند التنقل بين الصور، أو البدء من الوسط
  useEffect(() => {
    setCropView(cropViewsRef.current.get(activeIndex) || { scale: MIN_ZOOM, x: 0, y: 0 });
    setCropError('');
  }, [activeIndex]);

  // رابط الصوت المرفق بالمعاينة (مع زمني الاقتصاص إن وُجدت)
  const hasSoundTrim = Boolean(music?.soundTrim && music.soundTrim.end > music.soundTrim.start);
  const previewBaseUrl = hasSoundTrim
    ? music?.sourceVideoUrl || music?.previewUrl
    : music?.previewUrl || music?.sourceVideoUrl;
  const soundPreviewUrl = previewBaseUrl
    ? (hasSoundTrim && music?.soundTrim
      ? appendVideoTrimFragment(previewBaseUrl, music.soundTrim)
      : previewBaseUrl)
    : null;
  const blockedSoundId = useSyncExternalStore(
    subscribeSoundLibrary,
    () => getSoundLibraryState().blockedId,
    () => null,
  );
  const soundPlaybackCallbacks = {
    onPlaying: () => setSoundLibraryState({ playingId: music?.id || null, loadingId: null, blockedId: null }),
    onBlocked: () => setSoundLibraryState({ playingId: null, loadingId: null, blockedId: music?.id || null }),
    onError: () => setSoundLibraryState({ playingId: null, loadingId: null, blockedId: music?.id || null }),
  };
  const startSelectedSound = () => {
    if (!soundPreviewUrl) return;
    previewAudio(
      { id: music?.id, url: soundPreviewUrl },
      music?.soundTrim?.start || 0,
      music?.soundTrim?.end,
      soundPlaybackCallbacks,
    );
  };

  // التشغيل التلقائي الفوري للصوت المقترح/المختار أثناء معاينة الصورة (قبل أي زر)
  // — عبر المشغّل العالمي الموحّد (عنصر Audio واحد يُعاد استخدامه مع preload='auto')
  useEffect(() => {
    if (!open || !soundPreviewUrl) {
      stopAudioEngine();
      return undefined;
    }
    // إن كان المشغّل الموحّد يشغّل هذا الصوت أصلاً (مقترح تلقائياً لحظة اختيار
    // الصورة) فاستأنفه كما هو بدل إعادة سحبه من الصفر — صفر تأخير وبلا انقطاع
    if (!resumeInstantIfSame(soundPreviewUrl, soundPlaybackCallbacks)) startSelectedSound();
    return undefined;
  }, [open, soundPreviewUrl, music?.id, music?.soundTrim?.start, music?.soundTrim?.end]);

  // إيقاف معاينة الصوت المرفق عند فتح مكتبة الأصوات (منع تداخل الأصوات)
  useEffect(() => {
    const onOpenPicker = () => {
      stopAudioEngine();
    };
    window.addEventListener(OPEN_SOUND_PICKER_EVENT, onOpenPicker);
    return () => window.removeEventListener(OPEN_SOUND_PICKER_EVENT, onOpenPicker);
  }, []);

  // بحث سريع عن حسابات للإشارة إليها (منشِّد بقصير)
  // — يُعرَّف قبل أي return مبكر حتى يظل عدد الخطافات ثابتاً بين العروض
  useEffect(() => {
    if (toolPanel !== 'mention') return undefined;
    const term = mentionInput.trim().replace(/^@+/, '').replace(/[%_(),]/g, ' ').trim();
    if (!term) {
      setMentionResults([]);
      setMentionLoading(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setMentionLoading(true);
      setMentionError('');
      void (async () => {
        try {
          const [usernameResult, nameResult] = await Promise.all([
            supabase.from('profiles')
              .select('id, username, full_name, display_name, avatar_url, gender')
              .neq('id', userId || '')
              .ilike('username', `%${term}%`)
              .limit(8),
            supabase.from('profiles')
              .select('id, username, full_name, display_name, avatar_url, gender')
              .neq('id', userId || '')
              .or(`full_name.ilike.%${term}%,display_name.ilike.%${term}%`)
              .limit(8),
          ]);
          if (cancelled) return;
          if (usernameResult.error && nameResult.error) {
            setTagError('تعذر تحميل الحسابات. حاول مرة أخرى.');
            setMentionResults([]);
            return;
          }
          const seen = new Set();
          const candidates = [...(usernameResult.data || []), ...(nameResult.data || [])]
            .filter(person => person.id !== userId && !seen.has(person.id) && Boolean(seen.add(person.id)))
            .slice(0, 8);
          setMentionResults(candidates);
        } catch {
          if (!cancelled) {
            setTagError('تعذر تحميل الحسابات. حاول مرة أخرى.');
            setMentionResults([]);
          }
        } finally {
          if (!cancelled) setMentionLoading(false);
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [toolPanel, mentionInput, userId]);

  if (!open || images.length === 0 || !activeImage) return null;

  const handleScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const nextIndex = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    setActiveIndex(clamp(nextIndex, 0, images.length - 1));
  };

  const goToImage = index => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    setActiveIndex(index);
  };

  const selectCropMode = mode => {
    if (mode === (cropModes[activeIndex] || DEFAULT_IMAGE_ASPECT_LABEL)) return;
    setCropModes(current => ({ ...current, [activeIndex]: mode }));
    // إعادة ضبط موضع الصورة عند تغيير القالب
    cropViewsRef.current.delete(activeIndex);
    setCropView({ scale: MIN_ZOOM, x: 0, y: 0 });
  };

  const handleCropPointerDown = (event, corner = null) => {
    const frame = cropFrameRef.current;
    if (!frame) return;
    event.preventDefault();
    if (corner) event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    if (corner) {
      cropGestureRef.current = { type: 'resize', pointerId: event.pointerId, corner, startPoint: point, startView: cropView };
    } else {
      cropPointersRef.current.set(event.pointerId, point);
      const pointers = Array.from(cropPointersRef.current.values());
      if (pointers.length >= 2) {
        cropGestureRef.current = {
          type: 'pinch',
          startDistance: distanceBetween(pointers[0], pointers[1]),
          startView: cropView,
        };
      } else {
        cropGestureRef.current = { type: 'pan', pointerId: event.pointerId, startPoint: point, startView: cropView };
      }
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
  };

  const handleCropPointerMove = event => {
    const gesture = cropGestureRef.current;
    const frame = cropFrameRef.current;
    const imageElement = getImageElement(frame);
    if (!gesture || !frame) return;
    if (gesture.type !== 'resize') {
      if (!cropPointersRef.current.has(event.pointerId)) return;
      cropPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const frameBounds = frame.getBoundingClientRect();
    if (gesture.type === 'pinch') {
      const pointers = Array.from(cropPointersRef.current.values());
      if (pointers.length < 2) return;
      const scale = clamp(gesture.startView.scale * distanceBetween(pointers[0], pointers[1]) / Math.max(gesture.startDistance, 1), MIN_ZOOM, MAX_ZOOM);
      const bounds = getImageBounds(frame, imageElement, scale);
      updateCropView(activeIndex, {
        ...gesture.startView,
        scale,
        x: clamp(gesture.startView.x, -bounds.maxX, bounds.maxX),
        y: clamp(gesture.startView.y, -bounds.maxY, bounds.maxY),
      });
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startPoint.x;
    const deltaY = event.clientY - gesture.startPoint.y;
    if (gesture.type === 'resize') {
      // مقابض الزوايا: تقريب/إبعاد الصورة داخل الإطار الثابت
      const directionX = gesture.corner.includes('right') ? 1 : -1;
      const directionY = gesture.corner.includes('bottom') ? 1 : -1;
      const outwardDelta = (deltaX * directionX + deltaY * directionY) / 2;
      const scale = clamp(gesture.startView.scale - outwardDelta / Math.max(1, Math.min(frameBounds.width, frameBounds.height)) * 2, MIN_ZOOM, MAX_ZOOM);
      const bounds = getImageBounds(frame, imageElement, scale);
      updateCropView(activeIndex, {
        ...gesture.startView,
        scale,
        x: clamp(gesture.startView.x, -bounds.maxX, bounds.maxX),
        y: clamp(gesture.startView.y, -bounds.maxY, bounds.maxY),
      });
      return;
    }

    const bounds = getImageBounds(frame, imageElement, gesture.startView.scale);
    updateCropView(activeIndex, {
      ...gesture.startView,
      x: clamp(gesture.startView.x + deltaX, -bounds.maxX, bounds.maxX),
      y: clamp(gesture.startView.y + deltaY, -bounds.maxY, bounds.maxY),
    });
  };

  const endCropPointer = event => {
    const gesture = cropGestureRef.current;
    cropPointersRef.current.delete(event.pointerId);
    if (gesture?.type === 'pinch' && cropPointersRef.current.size === 1) {
      const [pointerId, point] = Array.from(cropPointersRef.current.entries())[0];
      cropGestureRef.current = { type: 'pan', pointerId, startPoint: point, startView: cropView };
    } else if (gesture?.pointerId === event.pointerId || cropPointersRef.current.size === 0) {
      cropGestureRef.current = null;
    }
  };

  const updateZoom = value => {
    const frame = cropFrameRef.current;
    const imageElement = getImageElement(frame);
    const scale = clamp(Number(value), MIN_ZOOM, MAX_ZOOM);
    const bounds = getImageBounds(frame, imageElement, scale);
    updateCropView(activeIndex, {
      ...cropView,
      scale,
      x: clamp(cropView.x, -bounds.maxX, bounds.maxX),
      y: clamp(cropView.y, -bounds.maxY, bounds.maxY),
    });
  };

  // «نشر»: تجهيز جميع الصور وفق قوالبها ثم جمعها مع الوصف والوسوم والصوت في طلب واحد
  const publishNow = async () => {
    if (!activeImage || isFinishing) return;
    setIsFinishing(true);
    setCropError('');
    try {
      const croppedImages = [];
      for (let index = 0; index < images.length; index++) {
        const view = cropViewsRef.current.get(index) || { scale: MIN_ZOOM, x: 0, y: 0 };
        const frame = frameRefsRef.current[index];
        const bounds = frame?.getBoundingClientRect();
        if (!bounds) throw new Error('تعذر تجهيز مساحة القص.');
        const label = cropModes[index] || DEFAULT_IMAGE_ASPECT_LABEL;
        croppedImages.push(await cropImage(images[index], view, bounds, aspectFor(index), label));
      }
      onImagesChange(croppedImages);
      onPublish(croppedImages);
    } catch (error) {
      setCropError(error instanceof Error ? error.message : 'تعذر تجهيز الصور. حاول مرة أخرى.');
    } finally {
      setIsFinishing(false);
    }
  };

  const toggleToolPanel = panel => {
    setTagError('');
    setToolPanel(current => current === panel ? null : panel);
  };

  // الوسوم: إضافة وإزالة (إشارة إلى حساب / موقع)
  const addTag = tag => {
    if (!onTagsChange) return;
    onTagsChange([...(tags || []), tag]);
  };
  const removeTag = index => {
    if (!onTagsChange || !tags) return;
    onTagsChange(tags.filter((_, tagIndex) => tagIndex !== index));
  };
  const handleMentionSelect = person => {
    addTag({
      kind: 'mention',
      label: person.username,
      href: `/profile/${person.id}`,
      profileId: person.id,
      displayName: displayName(person),
    });
    setMentionInput('');
    setMentionResults([]);
    setToolPanel(null);
  };

  const handleLocationSubmit = () => {
    const value = locationInput.trim();
    if (!value) {
      setTagError('أدخل اسم المكان أو عنوانه.');
      return;
    }
    addTag({ kind: 'location', label: value, href: mapsUrl(value) });
    setLocationInput('');
    setTagError('');
    setToolPanel(null);
  };

  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      setTagError('الموقع غير متاح على هذا الجهاز. أدخل المكان يدوياً.');
      return;
    }
    setIsLocating(true);
    setTagError('');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const query = `${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`;
        addTag({ kind: 'location', label: 'موقعي الحالي', href: mapsUrl(query) });
        setIsLocating(false);
        setToolPanel(null);
      },
      () => {
        setIsLocating(false);
        setTagError('تعذر تحديد موقعك. أدخل اسم المكان يدوياً.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black text-white" dir="rtl" role="dialog" aria-modal="true" aria-label="إنشاء منشور">
      {/* الهيدر: إلغاء (X) مقابل زر نشر مباشر */}
      <header className="flex shrink-0 items-center justify-between px-5 py-3">
        <button type="button" onClick={onClose} aria-label="إلغاء إنشاء المنشور" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10">
          <X size={23} />
        </button>
        <span className="text-sm font-semibold text-white/70">{images.length > 1 ? `${activeIndex + 1} من ${images.length}` : 'إنشاء منشور'}</span>
        <button type="button" onClick={() => void publishNow()} disabled={isFinishing} className="flex min-w-24 items-center justify-center rounded-full bg-[#f1a17f] px-6 py-2.5 text-base font-bold text-black transition active:scale-95 disabled:opacity-60">
          {isFinishing ? 'جارٍ النشر...' : 'نشر'}
        </button>
      </header>

      {/* قسم معاينة الوسائط */}
      <div className="relative min-h-0 flex-1">
        {/* كبسولة الصوت أعلى المعاينة: [أيقونة الموسيقى + اسم الصوت + X] — ملمومة بحسب طول الاسم، والضغط عليها يفتح مكتبة الأصوات للاستبدال */}
        {music && (
          <div className="absolute right-3 top-3 z-20 flex w-fit max-w-[80%] items-center justify-center gap-2 rounded-full border border-white/15 bg-black/70 px-3 py-1.5 backdrop-blur">
            <button
              type="button"
              onClick={() => openSoundPicker()}
              aria-label="تغيير الصوت من مكتبة الأصوات"
              className="flex min-w-0 items-center gap-2 text-right"
            >
              <Music2 size={14} className="shrink-0 text-[#f1a17f]" />
              <span className="min-w-0 truncate text-xs font-semibold text-white">{music.title}</span>
            </button>
            {onClearMusic && (
              <button
                type="button"
                aria-label="إزالة الصوت"
                onClick={onClearMusic}
                className="shrink-0 rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <div
          ref={trackRef}
          onScroll={handleScroll}
          dir="ltr"
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden no-scrollbar"
          style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}
        >
          {images.map((image, index) => (
            <div key={`${image.file.name}-${image.file.lastModified}-${index}`} className="flex h-full w-full shrink-0 snap-center items-center justify-center px-4">
              <div
                ref={el => {
                  frameRefsRef.current[index] = el;
                  if (index === activeIndex) cropFrameRef.current = el;
                }}
                className="relative h-full max-h-full w-auto max-w-full shrink-0 overflow-hidden rounded-xl bg-black"
                onPointerDown={index === activeIndex ? handleCropPointerDown : undefined}
                onPointerMove={index === activeIndex ? handleCropPointerMove : undefined}
                onPointerUp={index === activeIndex ? endCropPointer : undefined}
                onPointerCancel={index === activeIndex ? endCropPointer : undefined}
                aria-label="حرّك الصورة داخل إطار القص واضبط التكبير"
                style={{ aspectRatio: String(aspectFor(index)), touchAction: 'none' }}
              >
                <img
                  src={image.dataUrl}
                  alt={`الصورة ${index + 1}`}
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                  style={index === activeIndex
                    ? { transform: `translate3d(${cropView.x}px, ${cropView.y}px, 0) scale(${cropView.scale})`, transformOrigin: 'center' }
                    : undefined}
                />
                {index === activeIndex && (
                  <div className="pointer-events-none absolute inset-0 border border-white/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]">
                    <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
                      {[0, 1, 2].map(line => <span key={`v-${line}`} className="border-l border-white/25 first:border-l-0" />)}
                      {[1, 2].map(line => <span key={`h-${line}`} className="absolute inset-x-0 border-t border-white/25" style={{ top: `${(line * 100) / 3}%` }} />)}
                    </div>
                    {[
                      { corner: 'top-left', position: '-left-2 -top-2' },
                      { corner: 'top-right', position: '-right-2 -top-2' },
                      { corner: 'bottom-left', position: '-bottom-2 -left-2' },
                      { corner: 'bottom-right', position: '-bottom-2 -right-2' },
                    ].map(({ corner, position }) => (
                      <button
                        key={corner}
                        type="button"
                        aria-label={`ضبط الصورة من الزاوية ${corner}`}
                        onPointerDown={event => handleCropPointerDown(event, corner)}
                        onPointerMove={handleCropPointerMove}
                        onPointerUp={endCropPointer}
                        onPointerCancel={endCropPointer}
                        className={`pointer-events-auto absolute z-10 h-5 w-5 rounded-full border-2 border-black bg-white shadow ${position}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {cropError && <p role="alert" className="absolute left-4 right-4 top-3 rounded-lg bg-black/70 px-3 py-1.5 text-center text-xs text-rose-300">{cropError}</p>}

        {images.length > 1 && (
          <div className="absolute bottom-3 flex items-center justify-center gap-2" dir="ltr" aria-label="التنقل بين الصور" style={{ left: '50%', transform: 'translateX(-50%)' }}>
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`عرض الصورة ${index + 1}`}
                aria-current={index === activeIndex ? 'true' : undefined}
                onClick={() => goToImage(index)}
                className={`h-2 rounded-full transition-all ${index === activeIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* القسم السفلي: الوصف + الوسوم + شريط الأدوات + النوافذ السفلية */}
      <section className="shrink-0 space-y-3 border-t border-white/10 bg-[#141418] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {/* حقل الوصف: يدعم الهاشتاغات والإشارات كنص حر */}
        <textarea
          value={caption || ''}
          onChange={event => onCaptionChange?.(event.currentTarget.value)}
          maxLength={2000}
          rows={2}
          placeholder="اكتب وصفاً للمنشور... #هاشتاغ @إشارة"
          aria-label="اكتب وصفاً للمنشور"
          className="max-h-[120px] min-h-[56px] w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-white/[0.05] p-3 text-right text-sm leading-relaxed text-white outline-none transition placeholder:text-white/40 focus:border-[#f1a17f]/50"
        />

        {/* الوسوم المضافة (موقع/إشارة) */}
        {tags && tags.length > 0 && (
          <PostMetadataChips
            tags={tags}
            onRemove={index => removeTag(index)}
            onMentionClick={() => setToolPanel(null)}
          />
        )}

        {/* الصوت المختار يظهر كبسولة أعلى المعاينة ويُدار من هناك — تشغيله عبر المشغّل الموحّد في الأعلى */}

        {/* شريط الأزرار والخدمات */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar" dir="rtl">
          <div className="flex items-center gap-1 rounded-full bg-white/5 p-1" role="group" aria-label="مكان ظهور المنشور">
            <button
              type="button"
              aria-pressed={destination === 'feed'}
              onClick={() => onDestinationChange?.('feed')}
              className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${destination === 'feed' ? 'bg-[#f1a17f] text-black' : 'text-white/75 hover:bg-white/10'}`}
            >
              الواجهة
            </button>
            <button
              type="button"
              aria-pressed={destination === 'reels'}
              onClick={() => onDestinationChange?.('reels')}
              className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${destination === 'reels' ? 'bg-[#f1a17f] text-black' : 'text-white/75 hover:bg-white/10'}`}
            >
              الريلز
            </button>
          </div>
          <button
            type="button"
            onClick={() => toggleToolPanel('crop')}
            aria-pressed={toolPanel === 'crop'}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-white/85 transition hover:bg-white/[0.12]"
          >
            <Crop size={14} />
            قص
          </button>
          <button
            type="button"
            onClick={() => { setToolPanel(null); openSoundPicker(); }}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#f1a17f] transition hover:bg-[#f1a17f]/15"
          >
            <Music2 size={14} />
            موسيقى
          </button>
          <button
            type="button"
            onClick={() => toggleToolPanel('mention')}
            aria-pressed={toolPanel === 'mention'}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-white/85 transition hover:bg-white/[0.12]"
          >
            <AtSign size={14} />
            إشارة
          </button>
          <button
            type="button"
            onClick={() => toggleToolPanel('location')}
            aria-pressed={toolPanel === 'location'}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-white/85 transition hover:bg-white/[0.12]"
          >
            <MapPin size={14} />
            موقع
          </button>
        </div>
        {music?.id && blockedSoundId === music.id && soundPreviewUrl && (
          <button
            type="button"
            onClick={startSelectedSound}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[#f1a17f]/15 px-3 py-2 text-xs font-semibold text-[#f1a17f]"
          >
            <Play size={14} />
            اضغط لتشغيل الصوت
          </button>
        )}

        {/* نافذة القص السفلية: قوالب الأبعاد + التكبير */}
        {toolPanel === 'crop' && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white/80">قص وتعديل الصورة</span>
              <button type="button" aria-label="طي أداة القص" onClick={() => setToolPanel(null)} className="rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white">
                <X size={15} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1" role="group" aria-label="قالب القص">
              {IMAGE_ASPECT_OPTIONS.map(option => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={activeMode === option.label}
                  onClick={() => selectCropMode(option.label)}
                  className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition ${activeMode === option.label ? 'bg-[#f1a17f] text-black' : 'text-white/75 hover:bg-white/10'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3" dir="ltr">
              <button type="button" onClick={() => updateZoom(cropView.scale - 0.2)} aria-label="تصغير الصورة" disabled={cropView.scale <= MIN_ZOOM} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white disabled:opacity-40">
                <Minus size={18} />
              </button>
              <input
                type="range"
                aria-label="تكبير الصورة داخل إطار القص"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="0.01"
                value={cropView.scale}
                onChange={event => updateZoom(event.currentTarget.value)}
                className="min-w-0 flex-1 accent-[#f1a17f]"
              />
              <button type="button" onClick={() => updateZoom(cropView.scale + 0.2)} aria-label="تكبير الصورة" disabled={cropView.scale >= MAX_ZOOM} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white disabled:opacity-40">
                <Plus size={18} />
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-white/40">القالب الافتراضي 4:5 — اسحب الصورة داخل الإطار أو استخدم الزوايا</p>
          </div>
        )}

        {/* نافذة الإشارة إلى حساب */}
        {toolPanel === 'mention' && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white/80">الإشارة إلى حساب</span>
              <button type="button" aria-label="طي أداة الإشارة" onClick={() => toggleToolPanel('mention')} className="rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white">
                <X size={15} />
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
              <Search size={15} className="shrink-0 text-white/50" />
              <input
                type="search"
                value={mentionInput}
                onChange={event => { setMentionInput(event.currentTarget.value); setTagError(''); }}
                placeholder="ابحث بالاسم أو اسم المستخدم"
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40"
              />
            </div>
            <div className="mt-2 max-h-36 overflow-y-auto">
              {mentionLoading && (
                <p className="py-2 text-center text-xs text-white/50">جارٍ البحث...</p>
              )}
              {!mentionLoading && mentionResults.map(person => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => handleMentionSelect(person)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-right transition hover:bg-white/10"
                >
                  <Avatar profile={person} />
                  <UserIdentity
                    name={displayName(person)}
                    username={person.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-xs font-semibold text-white"
                    usernameClassName="text-[10px] text-white/50"
                  />
                </button>
              ))}
              {!mentionLoading && mentionInput.trim() && mentionResults.length === 0 && !tagError && (
                <p className="py-2 text-center text-xs text-white/40">لا نتائج مطابقة.</p>
              )}
            </div>
            {tagError && <p role="alert" className="mt-2 text-xs text-rose-300">{tagError}</p>}
          </div>
        )}

        {/* نافذة إضافة الموقع */}
        {toolPanel === 'location' && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white/80">إضافة موقع</span>
              <button type="button" aria-label="طي أداة الموقع" onClick={() => toggleToolPanel('location')} className="rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white">
                <X size={15} />
              </button>
            </div>
            <form
              onSubmit={event => { event.preventDefault(); handleLocationSubmit(); }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={locationInput}
                onChange={event => { setLocationInput(event.currentTarget.value); setTagError(''); }}
                placeholder="اسم المكان أو عنوانه"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#f1a17f]/40"
              />
              <button type="submit" className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-zinc-900 transition hover:bg-zinc-200">
                إضافة
              </button>
            </form>
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={isLocating}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] px-3 py-2 text-xs text-white/75 transition hover:bg-white/10 disabled:opacity-50"
            >
              {isLocating ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
              {isLocating ? 'جارٍ تحديد الموقع...' : 'استخدم موقعي الحالي'}
            </button>
            {tagError && <p role="alert" className="mt-2 text-xs text-rose-300">{tagError}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
