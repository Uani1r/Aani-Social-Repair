import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AtSign, Link2, Loader2, MapPin, Search, X } from 'lucide-react';

import Avatar from './Avatar';
import UserIdentity from './UserIdentity';
import PostMetadataChips from './PostMetadataChips';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { PostMetadataTag, Profile } from '@/lib/types';

type ComposerTagKind = PostMetadataTag['kind'];
type TagTool = ComposerTagKind | null;
type ComposerTag = PostMetadataTag & { id: string };

type MentionCandidate = {
  id: string;
  username: string;
  full_name: string;
  avatar_url: string | null;
};

type CreatePostModalProps = {
  profile: Profile | null;
  userId: string;
  postText: string;
  selectedFiles: File[];
  fileType: 'image' | 'video' | null;
  filePreviews: { file: File; url: string }[];
  isSubmitting: boolean;
  createError: string;
  onPostTextChange: (text: string) => void;
  onRemoveFile: (index: number) => void;
  onPublish: (tags: PostMetadataTag[]) => void;
  onClose: () => void;
};

const composerDisplayName = (profile: Profile | null) => {
  const candidate = [profile?.display_name, profile?.full_name, profile?.username]
    .find(value => Boolean(value?.trim()) && value?.trim().toLowerCase() !== 'new member');
  return candidate?.trim() || 'عضو آني';
};

const mapsUrl = (query: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

export default function CreatePostModal({
  profile,
  userId,
  postText,
  selectedFiles,
  fileType,
  filePreviews,
  isSubmitting,
  createError,
  onPostTextChange,
  onRemoveFile,
  onPublish,
  onClose,
}: CreatePostModalProps) {
  const nextTagIdRef = useRef(0);
  const [tags, setTags] = useState<ComposerTag[]>([]);
  const [activeTool, setActiveTool] = useState<TagTool>(null);
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  const closeTagEditor = () => {
    setActiveTool(null);
    setTagInput('');
    setTagError('');
    setMentionCandidates([]);
    setMentionLoading(false);
  };

  const addTag = (tag: Omit<ComposerTag, 'id'>) => {
    const id = `composer-tag-${++nextTagIdRef.current}`;
    setTags(current => current.some(item => item.kind === tag.kind && item.href === tag.href)
      ? current
      : [...current, { ...tag, id }]);
    closeTagEditor();
  };

  const toggleTagEditor = (tool: ComposerTagKind) => {
    setTagError('');
    setTagInput('');
    setMentionCandidates([]);
    setActiveTool(current => current === tool ? null : tool);
  };

  useEffect(() => {
    if (activeTool !== 'mention') return;
    const term = tagInput.trim().replace(/^@+/, '').replace(/[%_(),]/g, ' ').trim();
    if (!term) {
      setMentionCandidates([]);
      setMentionLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const loadCandidates = async () => {
        if (!supabaseConfigured) {
          setTagError('تعذر الاتصال بالحسابات الآن.');
          setMentionCandidates([]);
          return;
        }

        setMentionLoading(true);
        setTagError('');
        try {
          const [usernameResult, nameResult] = await Promise.all([
            supabase.from('profiles')
              .select('id, username, full_name, avatar_url')
              .neq('id', userId)
              .ilike('username', `%${term}%`)
              .limit(8),
            supabase.from('profiles')
              .select('id, username, full_name, avatar_url')
              .neq('id', userId)
              .ilike('full_name', `%${term}%`)
              .limit(8),
          ]);

          if (cancelled) return;
          if (usernameResult.error && nameResult.error) {
            setTagError('تعذر تحميل الحسابات. حاول مرة أخرى.');
            setMentionCandidates([]);
            return;
          }

          const seen = new Set<string>();
          const candidates = [...(usernameResult.data || []), ...(nameResult.data || [])]
            .filter(person => person.id !== userId && !seen.has(person.id) && Boolean(seen.add(person.id)))
            .slice(0, 8) as MentionCandidate[];
          setMentionCandidates(candidates);
        } catch {
          if (!cancelled) {
            setTagError('تعذر تحميل الحسابات. حاول مرة أخرى.');
            setMentionCandidates([]);
          }
        } finally {
          if (!cancelled) setMentionLoading(false);
        }
      };

      void loadCandidates();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTool, tagInput, userId]);

  const handleTagFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = tagInput.trim();
    if (!value) {
      setTagError(activeTool === 'location' ? 'أدخل اسم المكان أو عنوانه.' : 'أدخل رابطاً لإضافته.');
      return;
    }

    if (activeTool === 'location') {
      const href = mapsUrl(value);
      addTag({ kind: 'location', label: value, href });
      return;
    }

    if (activeTool === 'link') {
      try {
        const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
        const parsed = new URL(hasScheme ? value : `https://${value}`);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
          throw new Error('Invalid URL');
        }
        addTag({ kind: 'link', label: parsed.hostname, href: parsed.href });
      } catch {
        setTagError('أدخل رابطاً صحيحاً يبدأ بـ https:// أو http://.');
      }
    }
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
        const href = mapsUrl(query);
        addTag({ kind: 'location', label: 'موقعي الحالي', href });
        setIsLocating(false);
      },
      () => {
        setIsLocating(false);
        setTagError('تعذر تحديد موقعك. أدخل اسم المكان يدوياً.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  const handlePublish = () => onPublish(tags.map(({ kind, label, href, profileId }) => ({ kind, label, href, profileId })));

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="إغلاق إنشاء المنشور"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-black/65 backdrop-blur-[15px] animate-in fade-in-0 duration-200"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="إنشاء منشور"
        dir="rtl"
        onClick={event => event.stopPropagation()}
        className="relative z-10 flex max-h-[86dvh] w-full max-w-[450px] flex-col overflow-y-auto rounded-[32px] border border-white/10 bg-[#1d1b21]/95 text-white shadow-[0_24px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-4 duration-300"
      >
        <div className="flex items-center justify-between px-6 pb-4 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar profile={profile} extraLarge />
            <UserIdentity
              name={composerDisplayName(profile)}
              username={profile?.username?.replace(/^@+/, '') || null}
              nameClassName="text-base font-bold text-white"
              usernameClassName="text-sm text-zinc-400"
            />
          </div>
          <button
            type="button"
            aria-label="إغلاق إنشاء المنشور"
            onClick={onClose}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/[0.08] text-white transition hover:bg-white/[0.14]"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 pb-5">
          <textarea
            value={postText}
            onChange={event => onPostTextChange(event.target.value)}
            maxLength={2000}
            placeholder="ما الذي يدور في ذهنك اليوم؟..."
            aria-label="اكتب محتوى المنشور"
            className="min-h-[280px] max-h-[42dvh] w-full resize-none border-0 bg-transparent p-0 text-right text-[18px] leading-[1.9] text-white outline-none placeholder:text-zinc-500 focus:ring-0"
            rows={8}
          />
        </div>

        {filePreviews.length > 0 && (
          <div className="flex gap-3 overflow-x-auto px-6 pb-5 no-scrollbar">
            {filePreviews.map((preview, index) => (
              <div key={preview.url} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                {fileType === 'image' ? (
                  <img src={preview.url} alt="معاينة الصورة المحددة" className="h-full w-full object-cover" />
                ) : (
                  <video src={preview.url} muted playsInline className="h-full w-full object-cover" />
                )}
                <button
                  type="button"
                  aria-label="إزالة الملف"
                  onClick={() => onRemoveFile(index)}
                  className="absolute left-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <PostMetadataChips
          tags={tags}
          className="mx-6 mb-3"
          onRemove={index => setTags(current => current.filter((_, tagIndex) => tagIndex !== index))}
          onMentionClick={onClose}
        />

        {activeTool && (
          <div className="mx-6 mb-3 rounded-2xl border border-white/10 bg-white/[0.06] p-3 backdrop-blur-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white/80">
                {activeTool === 'location' ? 'إضافة موقع' : activeTool === 'link' ? 'إضافة رابط' : 'الإشارة إلى حساب'}
              </span>
              <button type="button" aria-label="إغلاق أدوات الوسوم" onClick={closeTagEditor} className="rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white">
                <X size={15} />
              </button>
            </div>

            {activeTool === 'mention' ? (
              <>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                  <Search size={15} className="shrink-0 text-white/50" />
                  <input
                    type="search"
                    value={tagInput}
                    onChange={event => { setTagInput(event.target.value); setTagError(''); }}
                    placeholder="ابحث بالاسم أو اسم المستخدم"
                    className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                  />
                </div>
                <div className="mt-2 max-h-36 overflow-y-auto">
                  {mentionLoading && (
                    <p className="flex items-center justify-center gap-2 py-3 text-xs text-white/50">
                      <Loader2 size={14} className="animate-spin" /> جارٍ البحث...
                    </p>
                  )}
                  {!mentionLoading && mentionCandidates.map(person => (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => addTag({
                        kind: 'mention',
                        label: person.username,
                        href: `/profile/${person.id}`,
                        profileId: person.id,
                      })}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-right transition hover:bg-white/10"
                    >
                      <Avatar profile={person} />
                      <UserIdentity
                        name={person.full_name || person.username}
                        username={person.username}
                        className="min-w-0 flex-1"
                        nameClassName="text-xs font-semibold text-white"
                        usernameClassName="text-[10px] text-white/50"
                      />
                    </button>
                  ))}
                  {!mentionLoading && tagInput.trim() && mentionCandidates.length === 0 && !tagError && (
                    <p className="py-3 text-center text-xs text-white/45">لا توجد حسابات مطابقة</p>
                  )}
                </div>
              </>
            ) : (
              <form onSubmit={handleTagFormSubmit} className="flex items-center gap-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={event => { setTagInput(event.target.value); setTagError(''); }}
                  placeholder={activeTool === 'location' ? 'اسم المكان أو عنوانه' : 'example.com أو https://...'}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-violet-300/40"
                />
                <button type="submit" className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-zinc-900 transition hover:bg-zinc-200">
                  إضافة
                </button>
              </form>
            )}

            {activeTool === 'location' && (
              <button
                type="button"
                onClick={handleUseCurrentLocation}
                disabled={isLocating}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] px-3 py-2 text-xs text-white/75 transition hover:bg-white/10 disabled:opacity-50"
              >
                {isLocating ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
                {isLocating ? 'جارٍ تحديد الموقع...' : 'استخدم موقعي الحالي'}
              </button>
            )}
            {tagError && <p role="alert" className="mt-2 text-xs text-rose-300">{tagError}</p>}
          </div>
        )}

        <footer className="mx-6 border-t border-white/10 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="إضافة موقع"
                title="الموقع"
                onClick={() => toggleTagEditor('location')}
                className={`grid h-[52px] w-[52px] place-items-center rounded-full transition ${activeTool === 'location' ? 'bg-violet-500/25 text-violet-200' : 'bg-white/[0.07] text-zinc-300 hover:bg-white/[0.12]'}`}
              >
                <MapPin size={22} />
              </button>
              <button
                type="button"
                aria-label="إضافة رابط"
                title="رابط"
                onClick={() => toggleTagEditor('link')}
                className={`grid h-[52px] w-[52px] place-items-center rounded-full transition ${activeTool === 'link' ? 'bg-violet-500/25 text-violet-200' : 'bg-white/[0.07] text-zinc-300 hover:bg-white/[0.12]'}`}
              >
                <Link2 size={22} />
              </button>
              <button
                type="button"
                aria-label="الإشارة إلى شخص"
                title="منشن"
                onClick={() => toggleTagEditor('mention')}
                className={`grid h-[52px] w-[52px] place-items-center rounded-full transition ${activeTool === 'mention' ? 'bg-violet-500/25 text-violet-200' : 'bg-white/[0.07] text-zinc-300 hover:bg-white/[0.12]'}`}
              >
                <AtSign size={22} />
              </button>
            </div>
            <button
              type="button"
              onClick={handlePublish}
              disabled={isSubmitting || (!postText.trim() && selectedFiles.length === 0 && tags.length === 0)}
              className="min-w-[120px] rounded-full bg-white px-8 py-3 text-base font-bold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'جاري النشر...' : 'نشر'}
            </button>
          </div>
          {createError && <p role="alert" className="mt-3 text-sm text-red-400">{createError}</p>}
        </footer>
      </section>
    </div>
  );
}
