import { useEffect, useState } from 'react';
import { Music2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '@/lib/supabase';

interface StoryDmCardProps {
  storyId: string;
  currentUserId: string;
  senderName?: string;
}

interface StoryRow {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: string;
  caption: string | null;
  expires_at: string | null;
  filter_key?: string | null;
  author?: { username?: string | null; full_name?: string | null; avatar_url?: string | null } | null;
}

/** بطاقة ستوري عمودية داخل المحادثة الخاصة (شبيهة ببطاقة ريلز إنستغرام) */
export default function StoryDmCard({ storyId, currentUserId, senderName }: StoryDmCardProps) {
  const [story, setStory] = useState<StoryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

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
        .select('id, user_id, media_url, media_type, caption, expires_at, author:profiles(id, username, full_name, avatar_url)')
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

  const expired = !story || (story.expires_at ? new Date(story.expires_at).getTime() < Date.now() : false);
  const canReshare = Boolean(story && !expired && story.user_id !== currentUserId && story.media_url);

  const addToStory = async () => {
    if (!story || !canReshare) return;
    if (!window.confirm('إضافة هذه القصة إلى قصتك؟')) return;

    setAdding(true);
    const payload = {
      user_id: currentUserId,
      media_url: story.media_url,
      media_type: story.media_type === 'video' ? 'video' : 'photo',
      caption: story.caption,
      is_close_friends: false,
      duration_seconds: 5,
      timed_texts: [],
      original_story_id: story.id,
      share_type: 'reshare',
    };

    const { error } = await supabase.from('stories').insert(payload);
    if (error) {
      const { original_story_id, share_type, ...legacyPayload } = payload;
      void original_story_id;
      void share_type;
      const retry = await supabase.from('stories').insert(legacyPayload);
      if (retry.error) {
        toast.error('تعذرت إضافة القصة');
        setAdding(false);
        return;
      }
    }

    toast.success('تمت إضافة القصة إلى قصتك');
    setAdded(true);
    setAdding(false);
  };

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

        {canReshare && (
          <button
            type="button"
            onClick={() => void addToStory()}
            disabled={adding || added}
            className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-full bg-white/95 px-3 py-1.5 text-[11px] font-bold text-zinc-900 shadow-lg transition active:scale-95 disabled:opacity-70"
          >
            <Plus size={13} />
            {added ? 'أُضيفت إلى قصتك' : adding ? 'جارٍ الإضافة…' : 'إضافة إلى قصتك'}
          </button>
        )}
      </div>

      <div className="px-2.5 py-2">
        <p className="truncate text-[11px] text-zinc-300">
          {expired ? 'هذه القصة لم تعد متاحة' : `قصة من ${authorLabel}`}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500">
          <Music2 size={10} /> {story?.caption || 'أرسل لك قصة'}
        </p>
      </div>
    </div>
  );
}
