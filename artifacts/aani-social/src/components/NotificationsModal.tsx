import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Bell, CheckCheck, Heart, MessageSquare, Phone, Repeat2, UserRound, X,
  type LucideIcon,
} from 'lucide-react';

import FollowRequestsSection from '@/components/FollowRequestsSection';
import PushNotificationsControl from '@/components/PushNotificationsControl';
import { OPEN_INCOMING_CALL_EVENT } from '@/components/CallManager';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { NotificationItem } from '@/lib/appShared';
import { displayName, formatDate, type Profile, type ProfileNotificationSettings } from '@/lib/types';

type NotificationsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  onOpenComments: (postId: string, commentId?: string) => void;
  onOpenStory: (storyId: string, ownerId: string) => void;
  notificationSettings?: ProfileNotificationSettings | null;
  language?: 'ar' | 'en';
  openFollowRequests?: boolean;
  onOpenFollowRequestsHandled?: () => void;
  onOpenFollowRequests?: () => void;
};

type NotificationEntry = NotificationItem & {
  reference_id?: string | null;
  comment_id?: string | null;
  post_id?: string | null;
};

type NotificationDisplayEntry = NotificationEntry & {
  aggregateCount: number;
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
  | { kind: 'comment'; postId: string; commentId: string | null }
  | { kind: 'story'; storyId: string; ownerId: string }
  | { kind: 'profile'; userId: string }
  | { kind: 'followRequests' }
  | { kind: 'conversation'; userId: string }
  | { kind: 'call'; callerId: string; callId: string | null };

type NotificationFilter = 'all' | 'likes' | 'comments' | 'other';

const PAGE_SIZE = 20;
const DEFAULT_NOTIFICATION_SETTINGS: ProfileNotificationSettings = {
  messages: true,
  followers: true,
  interactions: true,
  stories: true,
};

const FILTER_TABS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'likes', label: 'الإعجابات' },
  { id: 'comments', label: 'التعليقات' },
  { id: 'other', label: 'التفاعلات والقصص' },
];

const isStoryNotification = (item: NotificationEntry) => {
  if (item.type === 'story' || item.type === 'story_like') return true;
  return ['like', 'reply', 'mention'].includes(item.type) && /ستوري|قصة/i.test(item.content || '');
};

// تصفية سجلات قديمة لا تظهر في القائمة العامة:
// الرسائل والمكالمات الفائتة تُدار خارج قائمة الإشعارات (تبويب الرسائل/المكالمات).
const SUPPRESSED_NOTIFICATION_TYPES = ['message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call'];
const SUPPRESSED_NOTIFICATION_PATTERNS = ['مكالمة صوتية', 'أرسل لك رسالة'];

const isSuppressedLegacyNotification = (item: NotificationEntry): boolean => {
  if (SUPPRESSED_NOTIFICATION_TYPES.includes(String(item.type || '').toLowerCase())) return true;
  const text = `${item.content || ''}`;
  return SUPPRESSED_NOTIFICATION_PATTERNS.some(pattern => text.includes(pattern));
};

const notificationAction = (item: NotificationEntry, aggregateCount = 1) => {
  if (item.type === 'like' && aggregateCount > 1) {
    const target = isStoryNotification(item)
      ? 'قصتك'
      : item.comment_id ? 'تعليقك' : 'منشورك';
    return `و ${Intl.NumberFormat('ar-IQ').format(aggregateCount - 1)} آخرين أعجبوا بـ${target}`;
  }

  if (isStoryNotification(item)) {
    if (item.type === 'like') return 'أعجب بقصتك';
    if (item.type === 'reply') return 'ردّ على قصتك';
    return item.content || 'تفاعل مع قصتك';
  }
  if (item.type === 'like') return item.comment_id ? 'أعجب بتعليقك' : 'أعجب بمنشورك';

  const actions: Record<string, string> = {
    repost: 'أعاد نشر منشورك أو ريلز',
    comment: 'علّق على منشورك',
    reply: 'ردّ على تعليقك',
    follow: 'بدأ بمتابعتك',
    mention: 'أشار إليك في تعليق',
    message: 'أرسل لك رسالة',
    new_message: 'أرسل لك رسالة',
    call: item.content || 'اتصل بك',
    incoming_call: item.content || 'اتصل بك',
  };
  return actions[item.type] || item.content || 'أرسل لك إشعاراً جديداً';
};

const getLikeAggregationKey = (item: NotificationEntry) => {
  if (item.type !== 'like') return null;
  const referenceId = item.reference_id || item.entity_id || item.post_id;
  if (isStoryNotification(item)) return referenceId ? `story:${referenceId}` : null;
  if (item.comment_id) return `comment:${item.comment_id}`;
  return referenceId ? `post:${referenceId}` : null;
};

const aggregateNotifications = (items: NotificationEntry[]): NotificationDisplayEntry[] => {
  const aggregated: NotificationDisplayEntry[] = [];
  const groupIndexByKey = new Map<string, number>();
  const actorIdsByKey = new Map<string, Set<string>>();

  items.forEach(item => {
    const key = getLikeAggregationKey(item);
    if (!key) {
      aggregated.push({ ...item, aggregateCount: 1 });
      return;
    }

    const actorKey = item.actor_id || item.id;
    const groupIndex = groupIndexByKey.get(key);
    if (groupIndex === undefined) {
      groupIndexByKey.set(key, aggregated.length);
      actorIdsByKey.set(key, new Set([actorKey]));
      aggregated.push({ ...item, aggregateCount: 1 });
      return;
    }

    const actorIds = actorIdsByKey.get(key)!;
    if (actorIds.has(actorKey)) return;
    actorIds.add(actorKey);
    aggregated[groupIndex] = {
      ...aggregated[groupIndex],
      aggregateCount: aggregated[groupIndex].aggregateCount + 1,
    };
  });

  return aggregated;
};

const getNotificationTarget = (item: NotificationEntry, currentUserId: string): NotificationTarget | null => {
  const referenceId = item.reference_id || item.entity_id;
  if (isStoryNotification(item) && referenceId) {
    const ownerId = item.type === 'mention' || item.type === 'story' ? item.actor_id : currentUserId;
    return ownerId ? { kind: 'story', storyId: referenceId, ownerId } : null;
  }

  if (item.type === 'comment' || item.type === 'reply') {
    const postId = item.post_id || referenceId;
    return postId ? { kind: 'comment', postId, commentId: item.comment_id || null } : null;
  }

  if (['follow', 'followed', 'new_follower'].includes(item.type) && item.actor_id) {
    return { kind: 'profile', userId: item.actor_id };
  }

  if (item.type === 'follow_request') return { kind: 'followRequests' };

  if (['message', 'new_message'].includes(item.type) && item.actor_id) {
    return { kind: 'conversation', userId: item.actor_id };
  }

  if (['call', 'incoming_call'].includes(item.type) && item.actor_id) {
    return { kind: 'call', callerId: item.actor_id, callId: referenceId || null };
  }

  if ((item.type === 'like' || item.type === 'repost') && (referenceId || item.post_id)) {
    return { kind: 'post', postId: referenceId || item.post_id! };
  }

  return null;
};

const getFilterForNotification = (item: NotificationEntry): Exclude<NotificationFilter, 'all'> => {
  if (isStoryNotification(item)) return 'other';
  if (item.type === 'like') return 'likes';
  if (item.type === 'comment' || item.type === 'reply') return 'comments';
  return 'other';
};

const getPreferenceCategory = (item: NotificationEntry): keyof ProfileNotificationSettings => {
  if (isStoryNotification(item)) return 'stories';
  if (['follow', 'followed', 'follow_request', 'new_follower'].includes(item.type)) return 'followers';
  if (['message', 'new_message', 'call', 'incoming_call'].includes(item.type)) return 'messages';
  return 'interactions';
};

function ActionBadge({ item }: { item: NotificationEntry }) {
  let Icon: LucideIcon = Bell;
  let label = 'إشعار';
  let color = '#c98a66';
  let isStory = false;

  if (isStoryNotification(item)) {
    label = 'قصة';
    color = '#eccc68';
    isStory = true;
  } else if (item.type === 'like') {
    Icon = Heart;
    label = 'إعجاب';
    color = '#ff4757';
  } else if (item.type === 'comment' || item.type === 'reply') {
    Icon = MessageSquare;
    label = 'تعليق';
    color = '#70a1ff';
  } else if (item.type === 'repost') {
    Icon = Repeat2;
    label = 'إعادة نشر';
    color = '#2ed573';
  } else if (['message', 'new_message'].includes(item.type)) {
    Icon = MessageSquare;
    label = 'رسالة';
    color = '#70a1ff';
  } else if (['call', 'incoming_call'].includes(item.type)) {
    Icon = Phone;
    label = 'مكالمة';
    color = '#2ed573';
  }

  return (
    <span
      aria-label={label}
      role="img"
      className="absolute bottom-0 left-[-6px] z-[2] grid h-5 w-5 place-items-center"
      style={{ color, filter: 'drop-shadow(0px 2px 4px rgba(0,0,0,0.8))' }}
    >
      {isStory ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a10 10 0 0 1 10 10" />
        </svg>
      ) : (
        <Icon size={16} strokeWidth={2.5} style={item.type === 'like' ? { fill: 'rgba(255, 71, 87, 0.2)' } : undefined} />
      )}
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
  notificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
  language = 'ar',
  openFollowRequests = false,
  onOpenFollowRequestsHandled,
  onOpenFollowRequests,
}: NotificationsModalProps) {
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<NotificationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [activeFilter, setActiveFilter] = useState<NotificationFilter>('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<(() => void) | null>(null);
  const cleanupAttemptedUsersRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isOpen) return undefined;
    if (!supabaseConfigured) {
      setError('إعدادات Supabase غير مكتملة.');
      setItems([]);
      setLoading(false);
      setHasMore(false);
      return undefined;
    }

    let active = true;
    let nextOffset = 0;
    let canLoadMore = true;
    let pageRequestInProgress = false;
    let realtimeRefreshPending = false;
    setItems([]);
    setLoading(true);
    setLoadingMore(false);
    setHasMore(true);
    setError('');
    setReadError('');

    let fetchPage: (offset: number, replace: boolean) => Promise<void>;
    fetchPage = async (offset: number, replace: boolean) => {
      if (!active || pageRequestInProgress || (!replace && offset !== 0 && !canLoadMore)) return;
      pageRequestInProgress = true;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError('');

      try {
        const { data, error: queryError } = await supabase
          .from('notifications')
          .select('id,content,type,is_read,created_at')
          .eq('user_id', currentUserId)
          .neq('type', 'follow_request')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        if (!active) return;
        if (queryError) {
          setError(queryError.message);
          if (replace) setItems([]);
          return;
        }

        let rows = (data || []) as NotificationEntry[];
        try {
          let refs: NotificationReferenceRow[] = [];
          const referenceResult = await supabase
            .from('notifications')
            .select('id,reference_id,entity_id,actor_id,comment_id')
            .eq('user_id', currentUserId)
            .neq('type', 'follow_request')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + PAGE_SIZE - 1);

          if (!referenceResult.error) {
            refs = (referenceResult.data || []) as NotificationReferenceRow[];
          } else {
            const entityResult = await supabase
              .from('notifications')
              .select('id,entity_id,actor_id,comment_id')
              .eq('user_id', currentUserId)
              .neq('type', 'follow_request')
              .order('created_at', { ascending: false })
              .order('id', { ascending: false })
              .range(offset, offset + PAGE_SIZE - 1);
            if (!entityResult.error) refs = (entityResult.data || []) as NotificationReferenceRow[];
          }
          if (!active) return;

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
              .select('id,username,full_name,display_name,avatar_url')
              .in('id', actorIds);
            if (!active) return;
            const profileMap = new Map(((profiles || []) as Profile[]).map(person => [person.id, person]));
            rows = rows.map(item => item.actor_id
              ? { ...item, actor: profileMap.get(item.actor_id) || null }
              : item);
          }

          const commentIds = Array.from(new Set(rows
            .map(item => item.comment_id)
            .filter((id): id is string => Boolean(id))));
          if (commentIds.length) {
            const { data: comments } = await supabase
              .from('comments')
              .select('id,post_id')
              .in('id', commentIds);
            if (!active) return;
            const postIdByCommentId = new Map(((comments || []) as Array<{ id: string; post_id: string }>).map(comment => [comment.id, comment.post_id]));
            rows = rows.map(item => item.comment_id && postIdByCommentId.has(item.comment_id)
              ? { ...item, post_id: postIdByCommentId.get(item.comment_id) || null }
              : item);
          }
        } catch (enrichError) {
          console.warn('[notifications] تعذر إثراء الإشعارات:', enrichError);
        }

        if (!active) return;
        setItems(current => {
          const existingIds = new Set(current.map(item => item.id));
          const merged = replace
            ? rows
            : [...current, ...rows.filter(item => !existingIds.has(item.id))];
          return merged.sort((left, right) => (
            (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0)
            || right.id.localeCompare(left.id)
          ));
        });
        nextOffset = replace
          ? offset + (data || []).length
          : Math.max(nextOffset, offset + (data || []).length);
        canLoadMore = (data || []).length === PAGE_SIZE;
        setHasMore(canLoadMore);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'تعذر تحميل الإشعارات.');
      } finally {
        pageRequestInProgress = false;
        if (active) {
          setLoading(false);
          setLoadingMore(false);
          if (realtimeRefreshPending) {
            realtimeRefreshPending = false;
            void fetchPage(0, false);
          }
        }
      }
    };

    const loadMore = () => { void fetchPage(nextOffset, nextOffset === 0); };
    loadMoreRef.current = loadMore;

    const loadInitialPage = async () => {
      if (!cleanupAttemptedUsersRef.current.has(currentUserId)) {
        cleanupAttemptedUsersRef.current.add(currentUserId);
        try {
          const { error: cleanupError } = await supabase.rpc('aani_cleanup_old_notifications');
          if (cleanupError) console.warn('[notifications] تعذر حذف الإشعارات القديمة:', cleanupError);
        } catch (cleanupError) {
          console.warn('[notifications] تعذر حذف الإشعارات القديمة:', cleanupError);
        }
      }
      if (!active) return;
      await fetchPage(0, true);
    };

    void loadInitialPage();
    const channel = supabase.channel(`aani-notifications-modal-${currentUserId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${currentUserId}`,
      }, () => {
        if (pageRequestInProgress) realtimeRefreshPending = true;
        else void fetchPage(0, false);
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${currentUserId}`,
      }, payload => {
        const updated = payload.new as { id?: unknown; is_read?: unknown };
        if (typeof updated.id !== 'string' || typeof updated.is_read !== 'boolean') return;
        setItems(current => current.map(item => item.id === updated.id ? { ...item, is_read: updated.is_read as boolean } : item));
      })
      .subscribe();
    return () => {
      active = false;
      if (loadMoreRef.current === loadMore) loadMoreRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [isOpen, currentUserId]);

  useEffect(() => {
    if (!isOpen || !hasMore || loading || loadingMore || error) return undefined;
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current?.();
    }, { root, rootMargin: '120px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [error, hasMore, isOpen, items.length, loading, loadingMore]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const visibleItems = useMemo(() => {
    const aggregated = aggregateNotifications(items)
      .filter(item => !isSuppressedLegacyNotification(item))
      .filter(item => notificationSettings[getPreferenceCategory(item)] !== false);
    return activeFilter === 'all'
      ? aggregated
      : aggregated.filter(item => getFilterForNotification(item) === activeFilter);
  }, [activeFilter, items, notificationSettings]);

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
      setReadError('تعذر حفظ حالة الإشعار كمقروء. حاول مرة أخرى.');
    }
  };

  const markAllNotificationsRead = async () => {
    if (!supabaseConfigured || markingAllRead) return;
    const previousReadStates = new Map(items.map(item => [item.id, item.is_read]));
    setMarkingAllRead(true);
    setReadError('');
    setItems(current => current.map(item => ({ ...item, is_read: true })));
    try {
      const { error: updateError } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', currentUserId)
        .eq('is_read', false);
      if (updateError) throw updateError;
    } catch {
      setItems(current => current.map(item => ({
        ...item,
        is_read: previousReadStates.get(item.id) ?? item.is_read,
      })));
      setReadError('تعذر تحديد الإشعارات كمقروءة. حاول مرة أخرى.');
    } finally {
      setMarkingAllRead(false);
    }
  };

  const activateNotification = (item: NotificationEntry) => {
    void markNotificationRead(item);
    const target = getNotificationTarget(item, currentUserId);
    if (!target) return;

    if (target.kind === 'followRequests') {
      onOpenFollowRequests?.();
      return;
    }

    onClose();
    if (target.kind === 'post') {
      setLocation(`/post/${encodeURIComponent(target.postId)}`);
    } else if (target.kind === 'comment') {
      onOpenComments(target.postId, target.commentId || undefined);
      const query = target.commentId
        ? `commentId=${encodeURIComponent(target.commentId)}`
        : 'showComments=1';
      setLocation(`/post/${encodeURIComponent(target.postId)}?${query}`);
    } else if (target.kind === 'profile') {
      setLocation(`/profile/${encodeURIComponent(target.userId)}`);
    } else if (target.kind === 'story') {
      onOpenStory(target.storyId, target.ownerId);
      setLocation('/feed');
    } else if (target.kind === 'call') {
      setLocation(`/messages/${encodeURIComponent(target.callerId)}`);
      window.dispatchEvent(new CustomEvent(OPEN_INCOMING_CALL_EVENT, {
        detail: { callerId: target.callerId, callId: target.callId },
      }));
    } else {
      setLocation(`/messages/${encodeURIComponent(target.userId)}`);
    }
  };

  if (!isOpen) return null;

  const renderCard = (item: NotificationDisplayEntry) => {
    const actorName = displayName(item.actor);
    const action = notificationAction(item, item.aggregateCount);
    const profileHref = item.actor_id ? `/profile/${encodeURIComponent(item.actor_id)}` : null;

    return (
      <article key={item.id} className={`aani-notifications-card relative flex min-h-[80px] w-full items-center gap-3 rounded-[20px] border border-white/[0.04] px-3 py-3 text-right ${item.is_read ? 'bg-[#141414] text-[#8e8e93]' : 'bg-[#1a1a1a] text-[#f4f4f5]'}`}>
        {item.is_read === false && (
          <span
            aria-hidden="true"
            className="absolute left-[14px] top-1/2 z-10 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[#c98a66] [box-shadow:0_0_8px_#c98a66]"
          />
        )}
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
          className="flex min-w-0 flex-1 items-center border-0 bg-transparent p-0 pl-4 text-right outline-none focus-visible:ring-2 focus-visible:ring-[#e6a17b]"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] leading-6">
              <strong className="font-bold">{actorName}</strong>{' '}
              <span>{action}</span>
            </span>
            <span className="mt-1 flex items-center justify-between gap-2" style={{ fontFamily: "'Tajawal', sans-serif" }}>
              {item.aggregateCount > 1 ? (
                <span aria-label={`إجمالي ${item.aggregateCount} تفاعلات`} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-[#aaa]">
                  {Intl.NumberFormat('ar-IQ').format(item.aggregateCount)}
                </span>
              ) : <span />}
              <time className="block text-left text-[11px] text-[#8e8e93]/80">{formatDate(item.created_at)}</time>
            </span>
          </span>
        </button>
      </article>
    );
  };

  return (
    <div className="aani-notifications-page fixed inset-0 z-[150] overflow-hidden bg-[#0a0a0a] text-[#f4f4f5]" dir={language === 'ar' ? 'rtl' : 'ltr'}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-notifications-title"
        className="relative z-[1] mx-auto flex h-full w-full max-w-[560px] flex-col border-x border-white/[0.04]"
      >
        <header className="relative flex min-h-[65px] shrink-0 items-center justify-center border-b border-white/[0.07] px-4" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
          <h1 id="aani-notifications-title" className="flex items-center gap-2 text-[21px] font-bold">
            <Bell size={20} className="text-[#c98d73]" />
            <span>الإشعارات</span>
          </h1>
          <button
            type="button"
            onClick={() => { void markAllNotificationsRead(); }}
            disabled={markingAllRead}
            className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold text-[#c98d73] transition hover:bg-white/[0.05] disabled:opacity-50 sm:left-4 sm:text-xs"
            aria-label="تحديد كل الإشعارات كمقروءة"
          >
            <CheckCheck size={16} />
            <span>قراءة الكل</span>
          </button>
          <button type="button" onClick={onClose} className="absolute right-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-[#8e8e93] transition hover:bg-white/[0.05] hover:text-white" aria-label="إغلاق الإشعارات">
            <X size={22} />
          </button>
        </header>

        {notificationSettings.followers !== false && (
          <FollowRequestsSection
            currentUserId={currentUserId}
            dir={language === 'ar' ? 'rtl' : 'ltr'}
            openInitially={openFollowRequests}
            onOpenInitiallyHandled={onOpenFollowRequestsHandled}
          />
        )}

        <div role="tablist" aria-label="تصفية الإشعارات" className="flex shrink-0 gap-1 border-b border-white/[0.06] px-3 py-2">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeFilter === tab.id}
              onClick={() => setActiveFilter(tab.id)}
              className={`min-h-9 flex-1 rounded-full px-1.5 text-[11px] font-semibold transition sm:text-xs ${activeFilter === tab.id ? 'bg-white/[0.12] text-white' : 'text-[#8e8e93] hover:bg-white/[0.05] hover:text-white'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          ref={listRef}
          className="aani-notifications-list flex flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-4 pb-6 pt-4"
          style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
          onScroll={event => {
            const element = event.currentTarget;
            if (element.scrollHeight - element.scrollTop - element.clientHeight <= 120) loadMoreRef.current?.();
          }}
        >
          <PushNotificationsControl currentUserId={currentUserId} />
          {loading && items.length === 0 && <p className="py-10 text-center text-sm text-[#8e8e93]">جارٍ تحميل الإشعارات…</p>}
          {error && <p role="alert" className="mb-1 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">تعذر تحميل الإشعارات: {error}</p>}
          {readError && <p role="status" className="mb-1 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs text-amber-100">{readError}</p>}
          {!loading && !error && visibleItems.length === 0 && (
            <p className="py-10 text-center text-sm text-[#8e8e93]">
              {items.length === 0 ? 'لا توجد إشعارات حالياً.' : 'لا توجد إشعارات ضمن هذا التصنيف.'}
            </p>
          )}
          {visibleItems.map(renderCard)}
          {loadingMore && <p className="py-3 text-center text-xs text-[#8e8e93]">جارٍ تحميل المزيد…</p>}
          {error && hasMore && (
            <button type="button" onClick={() => loadMoreRef.current?.()} className="mx-auto rounded-full px-4 py-2 text-xs text-[#c98d73] hover:bg-white/[0.05]">إعادة المحاولة</button>
          )}
          <div ref={sentinelRef} aria-hidden="true" className="h-px shrink-0" />
        </div>
      </section>
    </div>
  );
}
