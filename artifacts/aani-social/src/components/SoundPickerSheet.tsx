import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Music2, Pause, Play, Search, Scissors, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { OPEN_SOUND_PICKER_EVENT, useExistingSound, type SoundTrimRange } from '@/lib/sounds';
import { appendVideoTrimFragment } from '@/lib/videoMedia';
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
 * أو اسم صاحبه، ومعاينة تشغيل/إيقاف لكل صوت، وأداة اقتصاص (شريطا زمن البداية
 * والنهاية بالثواني بحد أقصى 15 ثانية)، وزر استخدام يُطبق الصوت المقتص على
 * المنشور الجاري إنشاؤه (sound_id + audio_url + audio_title + أوقات الاقتصاص).
 * تُفتح من أزرار «موسيقى» في شاشات المعاينة ونافذة النشر عبر حدث عام.
 */
export default function SoundPickerSheet() {
  const [open, setOpen] = useState(false);
  const [sounds, setSounds] = useState<LibrarySound[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  // أداة الاقتصاص: الصوت المختار + مسودة زمني البداية/النهاية (بالثواني)
  const [trimTarget, setTrimTarget] = useState<LibrarySound | null>(null);
  const [trimDraft, setTrimDraft] = useState<SoundTrimRange>({ start: 0, end: MAX_TRIM_SECONDS });
  const [soundDuration, setSoundDuration] = useState(0);
  const [trimPlaying, setTrimPlaying] = useState(false);
  const trimAudioRef = useRef<HTMLAudioElement>(null);

  const stopEverything = () => {
    const previewAudio = previewAudioRef.current;
    if (previewAudio) previewAudio.pause();
    setPlayingId(null);
    const trimAudio = trimAudioRef.current;
    if (trimAudio) trimAudio.pause();
    setTrimPlaying(false);
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
      setSounds(null);
      setLoadError(false);
      setTrimTarget(null);
      setTrimPlaying(false);
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
    const audio = previewAudioRef.current;
    if (!audio || !sound.source_video_url) return;
    if (playingId === sound.id && !audio.paused) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    // صوت واحد فقط يعمل في المكتبة: أوقف أي معاينة أخرى
    const trimAudio = trimAudioRef.current;
    if (trimAudio) trimAudio.pause();
    setTrimPlaying(false);
    audio.src = sound.source_video_url;
    void audio.play().then(() => setPlayingId(sound.id)).catch(() => setPlayingId(null));
  };

  // فتح أداة الاقتصاص للصوت المختار (تُقرأ المدة من عنصر الصوت المخفي)
  const beginTrim = (sound: LibrarySound) => {
    stopEverything();
    setTrimTarget(sound);
    setSoundDuration(0);
    setTrimDraft({ start: 0, end: MAX_TRIM_SECONDS });
    const audio = trimAudioRef.current;
    if (audio) {
      audio.src = sound.source_video_url || '';
      audio.load();
    }
  };

  // معاينة الجزء المقتص مباشرة: يعمل ضمن زمني البداية/النهاية المختارَين
  const toggleTrimPreview = () => {
    const audio = trimAudioRef.current;
    if (!audio || !trimTarget?.source_video_url) return;
    if (audio.paused) {
      audio.src = appendVideoTrimFragment(trimTarget.source_video_url, trimDraft);
      void audio.play().then(() => setTrimPlaying(true)).catch(() => setTrimPlaying(false));
    } else {
      audio.pause();
      setTrimPlaying(false);
    }
  };

  // تقييد طول المقتطف: البداية والنهاية ضمن المدة، والفارق بحد أقصى 15 ثانية
  const updateTrimStart = (start: number) => {
    setTrimDraft(current => ({
      start,
      end: Math.max(start + 0.5, Math.min(current.end, Math.min(start + MAX_TRIM_SECONDS, Math.max(soundDuration, start + 0.5)))),
    }));
  };
  const updateTrimEnd = (end: number) => {
    setTrimDraft(current => ({
      end,
      start: Math.min(current.start, Math.max(0, end - MAX_TRIM_SECONDS)),
    }));
  };

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
      source: 'picker',
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
      source: 'picker',
    });
    setOpen(false);
  };

  if (!open) return null;

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
                className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
              >
                <ArrowRight size={22} />
              </button>
              <h1 className="flex-1 truncate text-base font-bold">اقتصاص الصوت</h1>
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="إغلاق"
                className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
              >
                <X size={20} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <p className="mb-1 truncate text-sm font-semibold text-white">{trimTarget.title}</p>
              <p className="mb-4 text-xs text-zinc-500">{displayName(trimTarget.creator || null) || 'مستخدم'}</p>

              <div className="mb-4 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={toggleTrimPreview}
                  disabled={!trimTarget.source_video_url}
                  aria-label={trimPlaying ? 'إيقاف معاينة الجزء المختار' : 'معاينة الجزء المختار'}
                  className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#f1a17f] to-[#e58b66] text-black shadow-lg transition disabled:opacity-40 hover:brightness-105"
                >
                  {trimPlaying ? <Pause size={22} /> : <Play size={22} className="translate-x-0.5" />}
                </button>
                <div className="text-xs text-zinc-400">
                  <span className="tabular-nums">{formatSeconds(trimDraft.start)}</span>
                  <span className="mx-1.5 text-zinc-600">—</span>
                  <span className="tabular-nums">{formatSeconds(trimDraft.end)}</span>
                </div>
              </div>

              {/* شريطا زمن البداية والنهاية (بالثواني) */}
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-semibold text-white/80">زمن البداية</span>
                    <span className="tabular-nums text-zinc-400">{formatSeconds(trimDraft.start)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, soundDuration)}
                    step="0.1"
                    value={trimDraft.start}
                    onChange={event => updateTrimStart(Number(event.currentTarget.value))}
                    className="w-full accent-[#f1a17f]"
                    aria-label="زمن بداية الصوت بالثواني"
                  />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-semibold text-white/80">زمن النهاية</span>
                    <span className="tabular-nums text-zinc-400">{formatSeconds(trimDraft.end)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, soundDuration)}
                    step="0.1"
                    value={trimDraft.end}
                    onChange={event => updateTrimEnd(Number(event.currentTarget.value))}
                    className="w-full accent-[#f1a17f]"
                    aria-label="زمن نهاية الصوت بالثواني"
                  />
                </div>
              </div>
              <p className="mt-3 text-center text-[11px] text-white/40">
                الحد الأقصى للجزء المختار {MAX_TRIM_SECONDS} ثانية — الجميع سيسمع نفس الجزء بعد النشر.
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

            <audio
              ref={trimAudioRef}
              preload="metadata"
              className="hidden"
              onLoadedMetadata={event => {
                const duration = Math.max(1, event.currentTarget.duration || 0);
                setSoundDuration(duration);
                setTrimDraft({ start: 0, end: Math.min(MAX_TRIM_SECONDS, duration) });
              }}
              onTimeUpdate={() => {
                const audio = trimAudioRef.current;
                if (!audio || trimPlaying) return;
                if (audio.currentTime >= trimDraft.end - 0.05 || audio.currentTime < trimDraft.start - 0.05) {
                  try { audio.currentTime = trimDraft.start; } catch { /* قد يرفض المتصفح الضبط قبل الجهوزية */ }
                }
              }}
              onEnded={() => setTrimPlaying(false)}
            />
          </>
        ) : (
          <>
            {/* قائمة مكتبة الأصوات */}
            <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="رجوع"
                className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
              >
                <ArrowRight size={22} />
              </button>
              <h1 className="flex-1 text-base font-bold">مكتبة الأصوات</h1>
              <button
                type="button"
                onClick={() => { stopEverything(); setOpen(false); }}
                aria-label="إغلاق مكتبة الأصوات"
                className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
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
                      <div className="flex min-h-[64px] items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white/[0.05]">
                        <button
                          type="button"
                          onClick={() => togglePreview(sound)}
                          disabled={!sound.source_video_url}
                          aria-label={playingId === sound.id ? 'إيقاف المعاينة' : 'تشغيل المعاينة'}
                          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#f1a17f] to-[#e58b66] text-black transition disabled:opacity-40 hover:brightness-105"
                        >
                          {playingId === sound.id ? <Pause size={17} /> : <Play size={17} className="translate-x-0.5" />}
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

            <audio ref={previewAudioRef} preload="none" className="hidden" />
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
