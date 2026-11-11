import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Loader2, Pause, Play, Search, Scissors, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { OPEN_SOUND_PICKER_EVENT, consumeSoundPickerTarget, useExistingSound, type SoundTrimRange } from '@/lib/sounds';
import { pauseInstant, playInstant, playSoundPreview, seekInstant, stopInstant, warmAudioCache, warmPreviewClip } from '@/lib/instantAudio';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile, type Sound } from '@/lib/types';

type LibrarySound = Sound & { creator?: Profile | null };

const MAX_TRIM_SECONDS = 15;

const formatSeconds = (value: number): string => {
  const safe = Math.max(0, Math.floor(value));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

/**
 * مكتبة أصوات التطبيق (نظام الأصوات بنمط TikTok):
 * منبثق يعرض الأصوات المخزنة في جدول public.sounds مع خانة بحث باسم الصوت
 * أو اسم صاحبه، ومعاينة تشغيل/إيقاف لكل صوت، وأداة اقتصاص بشريط زمني موحد
 * بمقبضين (بداية/نهاية) بحد أقصى 15 ثانية، وزر استخدام يُطبق الصوت المقتص
 * على المنشور الجاري إنشاؤه (sound_id + audio_url + audio_title + أوقات الاقتصاص).
 * تُفتح من أزرار «موسيقى» في شاشات المعاينة ونافذة النشر عبر حدث عام.
 */
export default function SoundPickerSheet() {
  const [open, setOpen] = useState(false);
  const [sounds, setSounds] = useState<LibrarySound[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  // الصوت قيد الجلب: الزر يتحول فوراً لمؤشر تحميل حتى يبدأ الصوت فعلياً
  const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null);
  const playingIdRef = useRef<string | null>(null);
  playingIdRef.current = playingId;
  // المشغّل الموحّد الفوري: عنصر Audio عالمي واحد يُعاد استخدامه لجميع الأصوات
  // (Single Audio Instance — من '@/lib/instantAudio' مع preload='auto' وcrossOrigin
  // لطلبات HTTP Range/206): يُستبدل src فقط عند التنقل بين الأصوات فيُجهَض طلب
  // الشبكة السابق تلقائياً بلا طلبات معلقة متراكمة وبلا ضغط ذاكرة
  // أداة الاقتصاص: الصوت المختار + مسودة زمني البداية/النهاية (بالثواني)
  const [trimTarget, setTrimTarget] = useState<LibrarySound | null>(null);
  const [trimDraft, setTrimDraft] = useState<SoundTrimRange>({ start: 0, end: MAX_TRIM_SECONDS });
  // مرآة مسودة الاقتصاص: يقرأها المشغّل الموحّد في كل نبضة timeupdate (تحديث حي أثناء السحب)
  const trimDraftRef = useRef<SoundTrimRange>(trimDraft);
  trimDraftRef.current = trimDraft;
  const [soundDuration, setSoundDuration] = useState(0);
  const [trimPlaying, setTrimPlaying] = useState(false);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const trimPlayingRef = useRef(false);
  trimPlayingRef.current = trimPlaying;
  // مؤشر تحميل المعاينة الحية في شاشة الاقتصاص: Spinner فوراً ثم Pause عند أول نغمة
  const [trimLoading, setTrimLoading] = useState(false);
  // رابط قياس المدة يُصيَّر مع شاشة الاقتصاص (state): العنصر غير موجود في
  // شجرة DOM لحظة فتح الشاشة فلا تُقرأ المدة أبداً ويتداخل المقبضان عند 0:00
  const [probeSrc, setProbeSrc] = useState('');
  const trimDurationLoadedRef = useRef(false);
  const trimTrackRef = useRef<HTMLDivElement>(null);

  // Pre-warm the first 8 sounds when the library opens: short head clips are
  // fetched (HTTP 206 Range) and decoded into a RAM AudioBuffer cache so the
  // tap plays through AudioBufferSourceNode in under 10ms with zero network
  // wait. Songs are never fully downloaded — only the preview head is cached.
  useEffect(() => {
    if (!open || !sounds) return;
    sounds.slice(0, 8).forEach(sound => {
      if (sound.source_video_url) void warmPreviewClip(sound.source_video_url);
    });
  }, [open, sounds]);

  const stopEverything = () => {
    stopInstant();
    setPlayingId(null);
    setLoadingPreviewId(null);
    setTrimPlaying(false);
    setDraggingHandle(null);
  };

  // زر الرجوع (الهاتف/المتصفح): يعود من شاشة الاقتصاص للقائمة ثم يغلق المكتبة
  useOverlayBack(open, () => {
    if (trimTarget) {
      stopEverything();
      setTrimTarget(null);
      return;
    }
    setOpen(false);
  });

  // الاستماع لطلب فتح مكتبة الأصوات من أزرار الموسيقى
  useEffect(() => {
    const onOpenPicker = () => {
      setOpen(true);
      setQuery('');
      setPlayingId(null);
      setLoadingPreviewId(null);
      setSounds(null);
      setLoadError(false);
      setTrimTarget(null);
      setTrimPlaying(false);
      setDraggingHandle(null);
    };
    window.addEventListener(OPEN_SOUND_PICKER_EVENT, onOpenPicker);
    return () => window.removeEventListener(OPEN_SOUND_PICKER_EVENT, onOpenPicker);
  }, []);

  // تحميل الأصوات من جدول public.sounds + أصحابها
  useEffect(() => {
    if (!open || !supabaseConfigured) return;
    let active = true;
    void (async () => {
      try {
        const { data: soundRows, error } = await supabase
          .from('sounds')
          .select('id, title, source_video_url, creator_id, created_at')
          .order('created_at', { ascending: false })
          .limit(100);
        if (!active) return;
        if (error) throw error;
        const rows = (soundRows || []) as unknown as LibrarySound[];
        const creatorIds = Array.from(new Set(rows
          .map(sound => sound.creator_id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id))));
        if (creatorIds.length > 0) {
          const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
            .in('id', creatorIds);
          const profiles = new Map<string, Profile>();
          (Array.isArray(profileRows) ? profileRows : []).forEach(profile => {
            const row = profile as unknown as Record<string, unknown>;
            if (typeof row?.id === 'string') profiles.set(row.id, row as unknown as Profile);
          });
          rows.forEach(sound => {
            if (sound.creator_id) sound.creator = profiles.get(sound.creator_id) || null;
          });
        }
        if (!active) return;
        setSounds(rows);
      } catch {
        if (active) {
          setSounds([]);
          setLoadError(true);
        }
      }
    })();
    return () => { active = false; };
  }, [open]);

  // الخانة البحثية: باسم الصوت أو اسم صاحب الصوت الأصلي
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSounds = (sounds || []).filter(sound => {
    if (!normalizedQuery) return true;
    const creatorName = displayName(sound.creator || null).toLowerCase();
    const username = (sound.creator?.username || '').toLowerCase();
    const title = (sound.title || '').toLowerCase();
    return title.includes(normalizedQuery) || creatorName.includes(normalizedQuery) || username.includes(normalizedQuery);
  });

  const togglePreview = (sound: LibrarySound) => {
    const url = sound.source_video_url;
    if (!url) return;
    if (playingIdRef.current === sound.id) {
      // Pause: the RAM clip (or stream) pauses in place and the button
      // returns to the play triangle automatically.
      pauseInstant();
      setPlayingId(null);
      return;
    }
    if (loadingPreviewId === sound.id) return;
    // Only one sound plays in the library (the unified player): any previous
    // preview stops instantly along with its pending requests
    setTrimPlaying(false);
    setPlayingId(null);
    // Instant response (Optimistic UI): Spinner in the same millisecond then
    // Pause as soon as the first audible sample is emitted
    setLoadingPreviewId(sound.id);
    playSoundPreview(url, {
      onPlaying: () => {
        setLoadingPreviewId(current => (current === sound.id ? null : current));
        setPlayingId(sound.id);
      },
      onEnded: () => {
        if (playingIdRef.current === sound.id) setPlayingId(null);
      },
      onError: () => {
        setLoadingPreviewId(current => (current === sound.id ? null : current));
      },
    });
  };

  // فتح أداة الاقتصاص: عنصر صوت مخفي منفصل يقرأ مدة الصوت الكاملة + تجهيز مشغل المعاينة الفوري
  const beginTrim = (sound: LibrarySound) => {
    stopEverything();
    setTrimTarget(sound);
    setSoundDuration(0);
    setTrimDraft({ start: 0, end: MAX_TRIM_SECONDS });
    trimDurationLoadedRef.current = false;
    if (sound.source_video_url) warmAudioCache(sound.source_video_url);
    // عنصر قياس المدة يُصيَّر مع شاشة الاقتصاص عبر probeSrc (state)
    setProbeSrc(sound.source_video_url || '');
  };

  // يبدأ الاستماع فوراً من زمن البداية المحدد بالمقبض (يُستدعى لحظة بدء السحب أيضاً)
  // — عبر مشغل الصوت المباشر المحمّل استباقياً: حلقة محصورة ضمن زمني الاقتصاص
  const beginLivePreview = () => {
    if (!trimTarget?.source_video_url) return;
    setPlayingId(null);
    setLoadingPreviewId(null);
    // Spinner فوراً ثم Pause عند أول نغمة — .play() يبدأ فوراً بالتوازي مع
    // الجلب (بلا انتظار المدة أو الميتاداتا)
    setTrimLoading(true);
    playInstant(trimTarget.source_video_url, {
      loop: false,
      // يقرأ المسودة في كل نبضة timeupdate: يبدأ الاستماع من زمن البداية لحظة السحب ويعود إليه تلقائياً
      getTrim: () => trimDraftRef.current,
      onPlaying: () => {
        setTrimLoading(false);
        setTrimPlaying(true);
      },
      onEnded: () => {
        setTrimLoading(false);
        setTrimPlaying(false);
      },
      onError: () => {
        setTrimLoading(false);
        setTrimPlaying(false);
      },
      // iOS يمنع قراءة المدة قبل إيماءة مستخدم — تُقرأ هنا لحظة بدء التشغيل الفعلي
      onLoadedMetadata: duration => {
        if (trimDurationLoadedRef.current) {
          setSoundDuration(current => (current > 0 ? current : duration));
          return;
        }
        trimDurationLoadedRef.current = true;
        setSoundDuration(duration);
        // المقبض الأيمن يقرأ المدة الكلية تلقائياً (بحد 15 ثانية)
        setTrimDraft(prev => ({
          start: Math.min(prev.start, Math.max(0, duration - 0.5)),
          end: Math.min(Math.max(prev.end, 0.5), Math.min(MAX_TRIM_SECONDS, duration)),
        }));
      },
    });
  };

  const stopTrimPreview = () => {
    stopInstant();
    setTrimLoading(false);
    setTrimPlaying(false);
  };

  const toggleTrimPreview = () => {
    if (trimPlaying) stopTrimPreview();
    else beginLivePreview();
  };

  // سحب المقبضين على الشريط الزمني الموحد (بحد أقصى 15 ثانية للمقتطف)
  useEffect(() => {
    if (!draggingHandle) return undefined;
    const valueFromPointer = (clientX: number): number | null => {
      const track = trimTrackRef.current;
      if (!track) return null;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
      // قبل وصول المدة الحقيقية (iOS) يُحتسب السحب على الحد الأقصى 15 ثانية
      return ratio * (soundDuration > 0 ? soundDuration : MAX_TRIM_SECONDS);
    };
    const onMove = (event: PointerEvent) => {
      const value = valueFromPointer(event.clientX);
      if (value === null) return;
      // تزامن حي 100% مع التشغيل: قفزة فورية إلى زمن البداية الجديد أثناء سحب المقبض الأيسر
      if (draggingHandle === 'start' && trimPlayingRef.current) seekInstant(value);
      setTrimDraft(current => {
        if (draggingHandle === 'start') {
          const start = Math.min(Math.max(0, value), Math.max(0, current.end - 0.5));
          const end = Math.min(Math.max(current.end, start + 0.5), Math.min(start + MAX_TRIM_SECONDS, soundDuration));
          return { start, end };
        }
        const end = Math.min(Math.max(value, current.start + 0.5), soundDuration);
        const start = Math.max(0, Math.max(current.start, end - MAX_TRIM_SECONDS));
        return { start, end };
      });
    };
    const onUp = () => setDraggingHandle(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [draggingHandle, soundDuration]);

  // تطبيق الصوت المقتص على المنشور الجاري إنشاؤه
  const applyTrimmedSound = () => {
    if (!trimTarget) return;
    stopEverything();
    useExistingSound({
      soundId: trimTarget.id,
      title: trimTarget.title,
      sourceVideoUrl: trimTarget.source_video_url || null,
      soundTrim: trimDraft.end > trimDraft.start
        ? { start: trimDraft.start, end: trimDraft.end }
        : null,
      creatorName: displayName(trimTarget.creator || null),
      source: consumeSoundPickerTarget() === 'story' ? 'story' : 'picker',
    });
    setTrimTarget(null);
    setOpen(false);
  };

  // تطبيق الصوت كاملاً بلا اقتصاص
  const applyFullSound = (sound: LibrarySound) => {
    stopEverything();
    useExistingSound({
      soundId: sound.id,
      title: sound.title,
      sourceVideoUrl: sound.source_video_url || null,
      soundTrim: null,
      creatorName: displayName(sound.creator || null),
      source: consumeSoundPickerTarget() === 'story' ? 'story' : 'picker',
    });
    setOpen(false);
  };

  if (!open) return null;

  // مدة الشريط الفعلية: قبل وصول المدة الحقيقية (iOS يمنع قراءتها قبل إيماءة
  // مستخدم) يُعرض الحد الأقصى 15 ثانية — فيمتد المقبضان من 0% إلى 100% بلا تداخل
  const trackDuration = soundDuration > 0 ? soundDuration : MAX_TRIM_SECONDS;
  const startPercent = (trimDraft.start / trackDuration) * 100;
  const endPercent = (trimDraft.end / trackDuration) * 100;

  return createPortal(
    <div
      className="fixed inset-0 z-[1250] flex flex-col justify-end bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="مكتبة الأصوات"
      dir="rtl"
      onClick={() => { stopEverything(); setOpen(false); }}
    >
      <section
        className="flex max-h-[86dvh] w-full flex-col rounded-t-[24px] border-t border-white/10 bg-[#141418] text-white shadow-[0_-16px_60px_rgba(0,0,0,0.6)]"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        onClick={event => event.stopPropagation()}
      >
        {trimTarget ? (
          <>
            {/* شاشة اقتصاص الصوت */}
            <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => { stopEverything(); setTrimTarget(null); }}
                aria-label="رجوع للقائمة"
                className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10"
              >
                <ArrowRight size={22} />
              </button>
              <h1 className="flex-1 truncate text-base font-bold">اقتصاص الصوت</h1>
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="إغلاق"
                className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10"
              >
                <X size={20} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <p className="mb-1 truncate text-sm font-semibold text-white">{trimTarget.title}</p>
              <p className="mb-4 text-xs text-zinc-500">{displayName(trimTarget.creator || null) || 'مستخدم'}</p>

              <div className="mb-5 flex items-center justify-center gap-3">
                {/* زر المعاينة: دائرة 56×56 والأيقونة ممركزة تماماً في المنتصف */}
                <button
                  type="button"
                  onPointerDown={event => {
                    event.preventDefault();
                    toggleTrimPreview();
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleTrimPreview();
                  }}
                  disabled={!trimTarget.source_video_url}
                  aria-label={trimLoading ? 'جارٍ تحميل المعاينة' : trimPlaying ? 'إيقاف معاينة الجزء المختار' : 'معاينة الجزء المختار'}
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#f1a17f] to-[#e58b66] text-black shadow-lg transition disabled:opacity-40 hover:brightness-105 active:scale-95"
                >
                  {trimLoading
                    ? <Loader2 size={22} className="animate-spin" />
                    : trimPlaying ? <Pause size={22} /> : <Play size={22} />}
                </button>
                <div className="text-xs tabular-nums text-zinc-400">
                  <div>{formatSeconds(trimDraft.start)} — {formatSeconds(trimDraft.end)}</div>
                  <div className="mt-0.5 text-[10px] text-zinc-600">المدة {formatSeconds(trackDuration)}</div>
                </div>
              </div>

              {/* الشريط الزمني الموحد بمقبضين أصغر وأنيقين (32px): الأيسر للبداية والأيمن للنهاية */}
              <div
                ref={trimTrackRef}
                dir="ltr"
                className="relative mx-1 h-8 select-none"
                style={{ touchAction: 'none' }}
              >
                {/* المسار الكامل رمادي خفيف */}
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/15" />
                {/* الأطراف الخارجية خارج المقبضين أدكن قليلاً */}
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-black/50"
                  style={{ left: 0, width: `${Math.max(0, startPercent)}%` }}
                />
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-black/50"
                  style={{ left: `${endPercent}%`, width: `${Math.max(0, 100 - endPercent)}%` }}
                />
                {/* الجزء المحصور بين المقبضين أورانج بارز */}
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#f1a17f]"
                  style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}
                />
                {(['start', 'end'] as const).map(handle => {
                  const value = handle === 'start' ? trimDraft.start : trimDraft.end;
                  const percent = (value / trackDuration) * 100;
                  return (
                    <button
                      key={handle}
                      type="button"
                      aria-label={handle === 'start' ? 'مقبض زمن البداية sound_trim_start' : 'مقبض زمن النهاية sound_trim_end'}
                      onPointerDown={event => {
                        event.preventDefault();
                        // استماع حي لحظة السحب: يبدأ الصوت من زمن البداية المحدد
                        beginLivePreview();
                        setDraggingHandle(handle);
                      }}
                      className={`absolute top-1/2 z-10 flex h-8 w-4 -translate-y-1/2 flex-col items-center justify-center gap-[3px] rounded-full border shadow-[0_2px_10px_rgba(0,0,0,0.5)] transition-transform ${draggingHandle === handle ? 'border-[#f1a17f] bg-[#f1a17f] scale-110' : 'border-black/40 bg-white'} active:scale-95`}
                      style={{ left: `calc(${percent}% - 8px)` }}
                    >
                      {/* فقاعة الوقت الحي فوق المقبض أثناء السحب */}
                      {draggingHandle === handle && (
                        <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-black/85 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                          {formatSeconds(value)}
                        </span>
                      )}
                      <span className={`h-[2px] w-1.5 rounded-full ${draggingHandle === handle ? 'bg-black/60' : 'bg-[#f1a17f]'}`} />
                      <span className={`h-[2px] w-1.5 rounded-full ${draggingHandle === handle ? 'bg-black/60' : 'bg-[#f1a17f]'}`} />
                      <span className={`h-[2px] w-1.5 rounded-full ${draggingHandle === handle ? 'bg-black/60' : 'bg-[#f1a17f]'}`} />
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-between px-1 text-[10px] tabular-nums text-zinc-500" dir="ltr">
                <span>0:00</span>
                <span>{formatSeconds(trackDuration)}</span>
              </div>
              <p className="mt-2 text-center text-[11px] text-white/40">
                اسحب المقبضين لتحديد الجزء — الحد الأقصى {MAX_TRIM_SECONDS} ثانية، والجميع سيسمع نفس الجزء بعد النشر.
              </p>
            </div>

            <div className="shrink-0 space-y-2 px-5 pt-2">
              <button
                type="button"
                onClick={applyTrimmedSound}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-bold text-zinc-900 transition hover:bg-zinc-200"
              >
                <Scissors size={15} />
                استخدام هذا الجزء
              </button>
              <button
                type="button"
                onClick={() => applyFullSound(trimTarget)}
                className="w-full rounded-full px-4 py-2 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
              >
                استخدام الصوت كاملاً
              </button>
            </div>

            {/* عنصر قياس المدة الكاملة (منفصل عن المعاينة حتى لا يفسدها ترميز #t=) */}
            {probeSrc && (
              <audio
                key={probeSrc}
                src={probeSrc}
                preload="metadata"
                className="hidden"
                onLoadedMetadata={event => {
                  const duration = Math.max(1, event.currentTarget.duration || 0);
                  setSoundDuration(duration);
                  if (!trimDurationLoadedRef.current) {
                    trimDurationLoadedRef.current = true;
                    setTrimDraft({ start: 0, end: Math.min(MAX_TRIM_SECONDS, duration) });
                  }
                }}
                onError={() => {
                  // تعذر قراءة المدة (رابط أو ترميز): افترض الحد الأقصى 15 ثانية
                  // كي يظهر المقبضان منفصلين ويعمل الاقتصاص بدل تداخلهما عند 0:00
                  setSoundDuration(current => (current > 0 ? current : MAX_TRIM_SECONDS));
                  if (!trimDurationLoadedRef.current) {
                    trimDurationLoadedRef.current = true;
                    setTrimDraft({ start: 0, end: MAX_TRIM_SECONDS });
                  }
                }}
              />
            )}
          </>
        ) : (
          <>
            {/* قائمة مكتبة الأصوات */}
            <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="رجوع"
                className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10"
              >
                <ArrowRight size={22} />
              </button>
              <h1 className="flex-1 text-base font-bold">مكتبة الأصوات</h1>
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="إغلاق مكتبة الأصوات"
                className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10"
              >
                <X size={20} />
              </button>
            </header>

            <div className="shrink-0 px-4 py-3">
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                <Search size={15} className="shrink-0 text-white/50" />
                <input
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="ابحث باسم الصوت أو اسم صاحبه"
                  className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
              {sounds === null && <ListSkeleton count={6} avatarClass="h-11 w-11" className="px-2 py-1" />}
              {sounds !== null && loadError && (
                <p role="alert" className="py-6 text-center text-sm text-rose-300">تعذر تحميل مكتبة الأصوات. تأكد من تطبيق ترحيل الأصوات ثم أعد المحاولة.</p>
              )}
              {sounds !== null && !loadError && filteredSounds.length === 0 && (
                <div className="py-8">
                  <EmptyState />
                  <p className="mt-2 text-center text-xs text-zinc-500">
                    {normalizedQuery ? 'لا نتائج مطابقة لبحثك.' : 'لا أصوات بعد — تنشر الأصوات تلقائياً من فيديوهات المستخدمين.'}
                  </p>
                </div>
              )}
              {filteredSounds.length > 0 && (
                <ul>
                  {filteredSounds.map(sound => (
                    <li key={sound.id}>
                      <div className="flex min-h-[68px] items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white/[0.05]">
                        {/* زر المعاينة: دائرة 56×56 والأيقونة ممركزة تماماً في المنتصف */}
                        {/* Interaction starts on pointerdown for an instant response, with keyboard parity via Enter/Space */}
                        <button
                          type="button"
                          onPointerDown={event => {
                            event.preventDefault();
                            togglePreview(sound);
                          }}
                          onKeyDown={event => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            togglePreview(sound);
                          }}
                          disabled={!sound.source_video_url}
                          aria-label={loadingPreviewId === sound.id ? 'جارٍ تحميل الصوت' : playingId === sound.id ? 'إيقاف المعاينة' : 'تشغيل المعاينة'}
                          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#f1a17f] to-[#e58b66] text-black shadow-md transition disabled:opacity-40 hover:brightness-105 active:scale-95"
                        >
                          {loadingPreviewId === sound.id
                            ? <Loader2 size={20} className="animate-spin" />
                            : playingId === sound.id ? <Pause size={20} /> : <Play size={20} />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{sound.title}</p>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                            <Avatar profile={sound.creator || null} />
                            <span className="truncate text-xs text-zinc-500">
                              {displayName(sound.creator || null) || 'مستخدم'}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => beginTrim(sound)}
                          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-xs font-bold text-zinc-900 transition hover:bg-zinc-200"
                        >
                          <Scissors size={12} />
                          استخدام
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
