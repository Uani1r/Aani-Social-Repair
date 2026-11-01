import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import { supabase, supabaseConfigured } from '@/lib/supabase';

export interface StoryRow {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
  duration_seconds?: number | null;
  expires_at: string | null;
  filter_key?: string | null;
  original_story_id?: string | null;
  author?: { id?: string; username?: string | null; full_name?: string | null; avatar_url?: string | null } | null;
}

interface StoryDmCardProps {
  storyId: string;
  currentUserId: string;
  senderName?: string;
  onAddToStory: (story: StoryRow) => void;
}

/** بطاقة ستوري عمودية داخل المحادثة الخاصة (شبيهة ببطاقة ريلز إنستغرام) */
export default function StoryDmCard({ storyId, currentUserId, senderName, onAddToStory }: StoryDmCardProps) {
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
      const { data } = await supabase
        .from('stories')
        .select('id, user_id, media_url, media_type, caption, duration_seconds, expires_at, author:profiles(id, username, full_name, avatar_url)')
        .eq('id', storyId)
        .maybeSingle();

      if (!active) return;
      setStory((data as StoryRow | null) ?? null);
      setLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, [storyId]);

  const expiresAt = story?.expires_at ? Date.parse(story.expires_at) : Number.NaN;
  const expired = !story || !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  const canReshare = Boolean(story && !expired && story.user_id !== currentUserId && story.media_url);

  const authorLabel = story?.author?.full_name || story?.author?.username || senderName || 'مستخدم';

  return (
    <div className="w-[78%] max-w-[260px] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-white shadow-xl">
      <div className="relative aspect-[9/16] w-full bg-zinc-800">
        {!story || !story.media_url ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="text-[11px] text-zinc-400">
              {loading ? 'جارٍ التحميل…' : 'هذه القصة لم تعد متاحة'}
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

        <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent p-2">
          {story?.author?.avatar_url ? (
            <img src={story.author.avatar_url} alt="" className="h-6 w-6 rounded-full object-cover" />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-[10px] font-bold">
              {(story?.author?.username || 'A').charAt(0).toUpperCase()}
            </span>
          )}
          <span className="truncate text-[11px] font-bold">{story?.author?.username || 'قصة'}</span>
        </div>

      </div>

      <div className="p-2.5">
        {canReshare && story ? (
          <button
            type="button"
            onClick={() => onAddToStory(story)}
            className="flex w-full items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2 text-[12px] font-bold text-zinc-900 shadow-lg transition active:scale-[0.98]"
          >
            <Plus size={14} /> إضافة إلى قصتك
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
