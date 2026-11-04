import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Bell, Heart, MessageSquare, Repeat2, Sparkles, UserRound, X,
  type LucideIcon,
} from 'lucide-react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { NotificationItem } from '@/lib/appShared';
import { displayName, formatDate, type Profile } from '@/lib/types';

type NotificationsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
};

type NotificationEntry = NotificationItem & {
  reference_id?: string | null;
  comment_id?: string | null;
  sub_reference_id?: string | null;
  post_id?: string | null;
};

type NotificationReferenceRow = {
  id: string;
  reference_id?: string | null;
  entity_id?: string | null;
  actor_id?: string | null;
  comment_id?: string | null;
};

type NotificationTarget =
  | { kind: 'post'; postId: string }
  | { kind: 'comment'; postId: string; commentId: string }
  | { kind: 'story'; storyId: string; ownerId: string };

const isStoryNotification = (item: NotificationEntry) => {
  if (item.type === 'story' || item.type === 'story_like') return true;
  return ['like', 'reply', 'mention'].includes(item.type) && /ستوري|قصة/i.test(item.content || '');
};

const notificationAction = (item: NotificationEntry) => {
  if (isStoryNotification(item)) {
    if (item.type === 'like') return 'أعجب بقصتك';
    if (item.type === 'reply') return 'ردّ على قصتك';
    return item.content || 'تفاعل مع قصتك';
  }

  const actions: Record<string, string> = {
    repost: 'أعاد نشر منشورك أو ريلز',
    like: 'أعجب بمنشورك أو تعليقك',
    comment: 'علّق على منشورك',
    reply: 'ردّ على تعليقك',
    follow: 'بدأ بمتابعتك',
    mention: 'أشار إليك في تعليق',
  };
  return actions[item.type] || item.content || 'أرسل لك إشعاراً جديداً';
};

const getNotificationTarget = (item: NotificationEntry, currentUserId: string): NotificationTarget | null => {
  const referenceId = item.reference_id || item.entity_id;
  if (isStoryNotification(item) && referenceId) {
    const ownerId = item.type === 'mention' || item.type === 'story' ? item.actor_id : currentUserId;
    return ownerId ? { kind: 'story', storyId: referenceId, ownerId } : null;
  }

  if (item.type === 'comment' || item.type === 'reply' || (item.type === 'like' && Boolean(item.comment_id))) {
    const commentId = item.comment_id || item.sub_reference_id;
    const postId = item.post_id || referenceId;
    return commentId && postId ? { kind: 'comment', postId, commentId } : null;
  }

  if ((item.type === 'like' || item.type === 'repost') && (referenceId || item.post_id)) {
    return { kind: 'post', postId: referenceId || item.post_id! };
  }

  return null;
};

function ActionBadge({ item }: { item: NotificationEntry }) {
  let Icon: LucideIcon = Bell;
  let label = 'إشعار';
  let colors = 'border-[#c98d73]/30 bg-[#c98d73]/[0.15] text-[#c98d73]';

  if (isStoryNotification(item)) {
    Icon = Sparkles;
    label = 'قصة';
    colors = 'border-[#c084fc]/30 bg-[#c084fc]/[0.15] text-[#c084fc]';
  } else if (item.type === 'like') {
    Icon = Heart;
    label = 'إعجاب';
    colors = 'border-[#f43f5e]/30 bg-[#f43f5e]/[0.15] text-[#f43f5e]';
  } else if (item.type === 'comment' || item.type === 'reply') {
    Icon = MessageSquare;
    label = 'تعليق';
    colors = 'border-[#38bdf8]/30 bg-[#38bdf8]/[0.15] text-[#38bdf8]';
  } else if (item.type === 'repost') {
    Icon = Repeat2;
    label = 'إعادة نشر';
    colors = 'border-[#34d399]/30 bg-[#34d399]/[0.15] text-[#34d399]';
  }

  return (
    <span aria-label={label} className={`absolute -bottom-1 -left-1 grid h-[22px] w-[22px] place-items-center rounded-full border bg-[#0a0a0a] ${colors}`}>
      <Icon size={12} strokeWidth={2.4} />
    </span>
  );
}

function NotificationAvatar({ item }: { item: NotificationEntry }) {
  return (
    <span className="relative mt-0.5 grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#242424] text-[#858585]">
      {item.actor?.avatar_url ? (
        <img src={item.actor.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <UserRound size={23} strokeWidth={2.5} />
      )}
      <ActionBadge item={item} />
    </span>
  );
}

export default function NotificationsModal({
  isOpen,
  onClose,
  currentUserId,
  onOpenComments,
  onOpenStory,
}: NotificationsModalProps) {
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<NotificationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    if (!supabaseConfigured) {
      setError('إعدادات Supabase غير مكتملة.');
      setItems([]);
      setLoading(false);
      return undefined;
    }

    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      const { data, error: queryError } = await supabase
        .from('notifications')
        .select('id,content,type,is_read,created_at')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false })
        .limit(40);
      if (!active) return;
      if (queryError) {
        setItems([]);
        setError(queryError.message);
        setLoading(false);
        return;
      }

      let rows = (data || []) as NotificationEntry[];
      try {
        let refs: NotificationReferenceRow[] = [];
        const referenceResult = await supabase
          .from('notifications')
          .select('id,reference_id,entity_id,actor_id,comment_id')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .limit(40);

        if (!referenceResult.error) {
          refs = (referenceResult.data || []) as NotificationReferenceRow[];
        } else {
          const entityResult = await supabase
            .from('notifications')
            .select('id,entity_id,actor_id,comment_id')
            .eq('user_id', currentUserId)
            .order('created_at', { ascending: false })
            .limit(40);
          if (!entityResult.error) refs = (entityResult.data || []) as NotificationReferenceRow[];
        }

        if (refs.length) {
          const refMap = new Map(refs.map(row => [row.id, row]));
          rows = rows.map(item => {
            const row = refMap.get(item.id);
            return {
              ...item,
              reference_id: row?.reference_id || row?.entity_id || null,
              entity_id: row?.entity_id || item.entity_id || null,
              actor_id: row?.actor_id || item.actor_id || null,
              comment_id: row?.comment_id || item.comment_id || null,
            };
          });
        }

        const actorIds = Array.from(new Set(rows.map(item => item.actor_id).filter((id): id is string => Boolean(id))));
        if (actorIds.length) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id,username,full_name,avatar_url')
            .in('id', actorIds);
          const profileMap = new Map(((profiles || []) as Profile[]).map(person => [person.id, person]));
          rows = rows.map(item => item.actor_id
            ? { ...item, actor: profileMap.get(item.actor_id) || null }
            : item);
        }

        const commentIds = Array.from(new Set(rows
          .map(item => item.comment_id || item.sub_reference_id)
          .filter((id): id is string => Boolean(id))));
        if (commentIds.length) {
          const { data: comments } = await supabase
            .from('comments')
            .select('id,post_id')
            .in('id', commentIds);
          const postIdByCommentId = new Map(((comments || []) as Array<{ id: string; post_id: string }>).map(comment => [comment.id, comment.post_id]));
          rows = rows.map(item => {
            const commentId = item.comment_id || item.sub_reference_id;
            return commentId && postIdByCommentId.has(commentId)
              ? { ...item, post_id: postIdByCommentId.get(commentId) || null }
              : item;
          });
        }
      } catch (enrichError) {
        console.warn('[notifications] تعذر إثراء الإشعارات:', enrichError);
      }

      if (!active) return;
      setItems(rows);
      setLoading(false);
    };

    void load();
    return () => { active = false; };
  }, [isOpen, currentUserId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const markNotificationRead = async (item: NotificationEntry) => {
    if (item.is_read) return;
    setItems(current => current.map(existing => existing.id === item.id ? { ...existing, is_read: true } : existing));
    if (!supabaseConfigured) return;
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', item.id)
      .eq('user_id', currentUserId);
    if (updateError) {
      setItems(current => current.map(existing => existing.id === item.id ? { ...existing, is_read: false } : existing));
      setError('تعذر حفظ حالة الإشعار كمقروء. حاول مرة أخرى.');
    }
  };

  const activateNotification = (item: NotificationEntry) => {
    void markNotificationRead(item);
    const target = getNotificationTarget(item, currentUserId);
    if (!target) return;

    onClose();
    if (target.kind === 'post') {
      setLocation(`/post/${encodeURIComponent(target.postId)}`);
    } else if (target.kind === 'comment') {
      onOpenComments(target.postId, target.commentId);
      setLocation(`/post/${encodeURIComponent(target.postId)}?commentId=${encodeURIComponent(target.commentId)}`);
    } else {
      onOpenStory(target.storyId, target.ownerId);
      setLocation('/feed');
    }
  };

  if (!isOpen) return null;

  const renderCard = (item: NotificationEntry) => {
    const actorName = displayName(item.actor);
    const action = notificationAction(item);
    const profileHref = item.actor_id ? `/profile/${encodeURIComponent(item.actor_id)}` : null;

    return (
      <article key={item.id} className={`aani-notifications-card relative flex min-h-[80px] w-full items-center gap-3 rounded-[20px] border border-white/[0.04] px-3 py-3 text-right ${item.is_read ? 'bg-[#141414] text-[#8e8e93]' : 'bg-[#1a1a1a] text-[#f4f4f5]'}`}>
        {profileHref ? (
          <Link
            href={profileHref}
            onClick={event => {
              event.stopPropagation();
              void markNotificationRead(item);
              onClose();
            }}
            aria-label={`الانتقال إلى ملف ${actorName}`}
            className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#e6a17b]"
          >
            <NotificationAvatar item={item} />
          </Link>
        ) : <NotificationAvatar item={item} />}
        <button
          type="button"
          onClick={() => activateNotification(item)}
          aria-label={`${actorName} ${action}`}
          className="flex min-w-0 flex-1 items-center border-0 bg-transparent p-0 text-right outline-none focus-visible:ring-2 focus-visible:ring-[#e6a17b]"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] leading-6">
              <strong className="font-bold">{actorName}</strong>{' '}
              <span>{action}</span>
            </span>
            <time className="mt-1 block text-[11px] text-[#8e8e93]/80">{formatDate(item.created_at)}</time>
          </span>
        </button>
      </article>
    );
  };

  return (
    <div className="aani-notifications-page fixed inset-0 z-[150] overflow-hidden bg-[#0a0a0a] text-[#f4f4f5]" dir="rtl">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-notifications-title"
        className="relative z-[1] mx-auto flex h-full w-full max-w-[560px] flex-col border-x border-white/[0.04]"
      >
        <header className="relative flex min-h-[65px] shrink-0 items-center justify-center border-b border-white/[0.07] px-4" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
          <h1 id="aani-notifications-title" dir="ltr" className="flex items-center gap-2 text-[21px] font-bold">
            <Bell size={20} className="text-[#c98d73]" />
            <span dir="rtl">الإشعارات</span>
          </h1>
          <button type="button" onClick={onClose} className="absolute right-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-[#8e8e93] transition hover:bg-white/[0.05] hover:text-white" aria-label="إغلاق الإشعارات">
            <X size={22} />
          </button>
        </header>

        <div className="aani-notifications-list flex flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-4 pb-6 pt-4" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
          {loading && <p className="py-10 text-center text-sm text-[#8e8e93]">جارٍ تحميل الإشعارات…</p>}
          {error && <p role="alert" className="mb-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">{error}</p>}
          {!loading && !error && items.length === 0 && <p className="py-10 text-center text-sm text-[#8e8e93]">لا توجد إشعارات حالياً.</p>}
          {!loading && !error && items.map(renderCard)}
        </div>
      </section>
    </div>
  );
}
