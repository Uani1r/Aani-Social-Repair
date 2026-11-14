import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import RepostIcon from '@/components/RepostIcon';
import UserIdentity from '@/components/UserIdentity';
import { SkeletonBlock } from '@/components/Skeletons';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { cleanUsername, displayName } from '@/lib/types';

export interface StoryRow {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: string;
  thumbnail_url?: string | null;
  caption: string | null;
  duration_seconds?: number | null;
  expires_at: string | null;
  filter_key?: string | null;
  original_story_id?: string | null;
  author?: { id?: string; username?: string | null; full_name?: string | null; display_name?: string | null; avatar_url?: string | null } | null;
}

interface StoryDmCardProps {
  storyId: string;
  currentUserId: string;
  senderName?: string;
  /** رسالة إشارة: عنوان «تمت الإشارة إليك» ومعاينة مصغّرة وزر «إضافة إلى القصة». */
  mention?: boolean;
  /** عنوان بطاقة الإشارة (يختلف للمُرسل عن المُشار إليه). */
  mentionLabel?: string;
  /** فتح القصة الأصلية بمعرّفها — يُمرَّر فقط عندما تبقى القصة نشطة ومتاحة. */
  onOpenStory?: () => void;
  onAddToStory: (story: StoryRow) => void;
}

/**
 * بطاقة ستوري عمودية داخل المحادثة الخاصة (شبيهة ببطاقة ريلز إنستغرام).
 * تُستخدم لحالتين من نفس نظام الرسائل والقصص، بلا أي جدول أو نظام جديد:
 *   - مشاركة ستوري عادية داخل DM.
 *   - رسالة إشارة: تُعرض بمعاينة مصغّرة بعنوان «تمت الإشارة إليك»، والضغط على
 *     المعاينة يفتح القصة الأصلية بمعرّفها عبر onOpenStory.
 */
export default function StoryDmCard({
  storyId,
  currentUserId,
  senderName,
  mention = false,
  mentionLabel,
  onOpenStory,
  onAddToStory,
}: StoryDmCardProps) {
  const [story, setStory] = useState<StoryRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabaseConfigured || !storyId) {
      setLoading(false);
      return;
    }

    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('stories')
          .select('id, user_id, media_url, media_type, thumbnail_url, caption, duration_seconds, expires_at')
          .eq('id', storyId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          if (active) setStory(null);
          return;
        }

        const { data: author, error: authorError } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, gender')
          .eq('id', data.user_id)
          .maybeSingle();
        if (authorError) console.warn('[story DM card] تعذر تحميل ملف صاحب القصة:', authorError);
        if (active) setStory({ ...(data as StoryRow), author: author || null });
      } catch (error) {
        console.error('[story DM card] تعذر تحميل القصة:', error);
        if (active) setStory(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [storyId]);

  const expiresAt = story?.expires_at ? Date.parse(story.expires_at) : Number.NaN;
  const expired = !story || !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  const canReshare = Boolean(story && !expired && story.user_id !== currentUserId && story.media_url);
  // فتح القصة بمعرّفها متاح فقط عندما تكون نشطة ومتاحة؛ غير ذلك يبقى النص التوضيحي.
  const canOpen = Boolean(onOpenStory && story && !expired && story.media_url);

  const authorLabel = story?.author ? displayName(story.author) : senderName || '';

  return (
    <div
      className={`overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-white shadow-xl ${
        mention ? 'w-[64%] max-w-[210px]' : 'w-[78%] max-w-[260px]'
      }`}
    >
      {mention && (
        <div className="flex items-center gap-1 border-b border-white/10 px-2.5 py-1.5 text-[10px] font-bold text-white/85">
          <RepostIcon active={false} size={11} strokeWidth={2.4} />
          <span>{mentionLabel ?? 'تمت الإشارة إليك'}</span>
        </div>
      )}

      <div className={`relative w-full bg-zinc-800 ${mention ? 'aspect-[3/4]' : 'aspect-[9/16]'}`}>
        {loading ? (
          <SkeletonBlock className="absolute inset-0 rounded-none" />
        ) : !story || !story.media_url ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="text-[11px] text-zinc-400">
              هذه القصة لم تعد متاحة
            </span>
          </div>
        ) : story.media_type === 'video' ? (
          <video
            src={story.media_url}
            className="h-full w-full object-cover"
            muted
            loop
            playsInline
            autoPlay
          />
        ) : (
          <img src={story.media_url} alt="" className="h-full w-full object-cover" />
        )}

        {!loading && story && !expired && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/70 to-transparent p-2">
            {story.author?.avatar_url ? (
              <img src={story.author.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/20 text-[10px] font-bold">
                {(cleanUsername(story.author?.username).charAt(0) || 'A').toUpperCase()}
              </span>
            )}
            <UserIdentity
              name={authorLabel}
              username={story.author?.username}
              className="min-w-0 flex-1"
              nameClassName="text-[10px] font-bold text-white"
              usernameClassName="text-[9px] text-white/70"
            />
          </div>
        )}

        {canOpen && (
          <button
            type="button"
            onClick={onOpenStory}
            aria-label="عرض القصة الأصلية"
            className="absolute inset-0 z-10 rounded-2xl transition active:scale-[0.99]"
          />
        )}
      </div>

      <div className="p-2.5">
        {canReshare && story ? (
          <button
            type="button"
            onClick={() => onAddToStory(story)}
            className="flex w-full items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2 text-[12px] font-bold text-zinc-900 shadow-lg transition active:scale-[0.98]"
          >
            <Plus size={14} /> {mention ? 'إضافة إلى القصة' : 'إضافة إلى قصتك'}
          </button>
        ) : (
          <p className="truncate text-center text-[11px] text-zinc-400">
            {expired ? 'هذه القصة لم تعد متاحة' : `قصة من ${authorLabel}`}
          </p>
        )}
      </div>
    </div>
  );
}
