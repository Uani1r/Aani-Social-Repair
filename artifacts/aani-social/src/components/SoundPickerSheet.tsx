import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Music2, Pause, Play, Search, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { OPEN_SOUND_PICKER_EVENT, useExistingSound } from '@/lib/sounds';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile, type Sound } from '@/lib/types';

type LibrarySound = Sound & { creator?: Profile | null };

/**
 * مكتبة أصوات التطبيق (نظام الأصوات بنمط TikTok):
 * منبثق يعرض الأصوات المخزنة في جدول public.sounds (الأصوات المستخرجة من
 * فيديوهات المستخدمين والأصوات المنشورة سابقاً) مع خانة بحث باسم الصوت
 * أو اسم صاحبه، ومعاينة لكل صوت، وزر استخدام يُطبق الصوت على المنشور
 * الجاري إنشاؤه (sound_id + audio_url + audio_title).
 * تُفتح من أزرار «موسيقى» في شاشات المعاينة ونافذة النشر عبر حدث عام.
 */
export default function SoundPickerSheet() {
  const [open, setOpen] = useState(false);
  const [sounds, setSounds] = useState<LibrarySound[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);

  // زر الرجوع (الهاتف/المتصفح) يغلق المكتبة ويعيدك لنفس المكان
  useOverlayBack(open, () => setOpen(false));

  // الاستماع لطلب فتح مكتبة الأصوات من أزرار الموسيقى
  useEffect(() => {
    const onOpenPicker = () => {
      setOpen(true);
      setQuery('');
      setPlayingId(null);
      setSounds(null);
      setLoadError(false);
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

  const stopPreview = () => {
    const audio = previewAudioRef.current;
    if (audio) audio.pause();
    setPlayingId(null);
  };

  const togglePreview = (sound: LibrarySound) => {
    const audio = previewAudioRef.current;
    if (!audio || !sound.source_video_url) return;
    if (playingId === sound.id && !audio.paused) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = sound.source_video_url;
    void audio.play().then(() => setPlayingId(sound.id)).catch(() => setPlayingId(null));
  };

  // اختيار صوت: يُطبق فوراً على المنشور الجاري إنشاؤه (sound_id + audio_url + audio_title)
  const applySound = (sound: LibrarySound) => {
    stopPreview();
    useExistingSound({
      soundId: sound.id,
      title: sound.title,
      sourceVideoUrl: sound.source_video_url || null,
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
      onClick={() => setOpen(false)}
    >
      <section
        className="flex max-h-[86dvh] w-full flex-col rounded-t-[24px] border-t border-white/10 bg-[#141418] text-white shadow-[0_-16px_60px_rgba(0,0,0,0.6)]"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        onClick={event => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="رجوع"
            className="grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10"
          >
            <ArrowRight size={22} />
          </button>
          <h1 className="flex-1 text-base font-bold">مكتبة الأصوات</h1>
          <button
            type="button"
            onClick={() => setOpen(false)}
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
                      onClick={() => applySound(sound)}
                      className="flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-xs font-bold text-zinc-900 transition hover:bg-zinc-200"
                    >
                      <Music2 size={12} />
                      استخدام
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <audio ref={previewAudioRef} preload="none" className="hidden" />
      </section>
    </div>,
    document.body,
  );
}
