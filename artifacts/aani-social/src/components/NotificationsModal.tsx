import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight, AtSign, Bell, CheckCheck, Heart, MessageCircle, Repeat2, UserRound, X,
  type LucideIcon,
} from 'lucide-react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { NotificationItem } from '@/lib/appShared';
import { displayName, formatDate, type Profile } from '@/lib/types';

type NotificationsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
};

type NotificationEntry = NotificationItem & {
  reference_id?: string | null;
  isMock?: boolean;
};

type NotificationReferenceRow = {
  id: string;
  reference_id?: string | null;
  entity_id?: string | null;
  actor_id?: string | null;
};

const mockProfile = (id: string, fullName: string, username: string): Profile => ({
  id,
  username,
  full_name: fullName,
  avatar_url: null,
  bio: '',
});

const mockTime = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const MOCK_NOTIFICATIONS: NotificationEntry[] = [
  {
    id: 'demo-repost', user_id: 'demo', actor_id: 'demo-sara', type: 'repost',
    content: '', is_read: false, created_at: mockTime(4), isMock: true,
    actor: mockProfile('demo-sara', 'سارة العتيبي', 'sara'),
  },
  {
    id: 'demo-like', user_id: 'demo', actor_id: 'demo-omar', type: 'like',
    content: '', is_read: false, created_at: mockTime(18), isMock: true,
    actor: mockProfile('demo-omar', 'عمر الحربي', 'omar'),
  },
  {
    id: 'demo-comment', user_id: 'demo', actor_id: 'demo-lina', type: 'comment',
    content: '', is_read: true, created_at: mockTime(42), isMock: true,
    actor: mockProfile('demo-lina', 'لينا أحمد', 'lina'),
  },
  {
    id: 'demo-follow', user_id: 'demo', actor_id: 'demo-nawaf', type: 'follow',
    content: '', is_read: false, created_at: mockTime(95), isMock: true,
    actor: mockProfile('demo-nawaf', 'نواف الشمري', 'nawaf'),
  },
  {
    id: 'demo-mention', user_id: 'demo', actor_id: 'demo-noor', type: 'mention',
    content: '', is_read: true, created_at: mockTime(180), isMock: true,
    actor: mockProfile('demo-noor', 'نور خالد', 'noor'),
  },
  {
    id: 'demo-reply', user_id: 'demo', actor_id: 'demo-yousef', type: 'reply',
    content: '', is_read: false, created_at: mockTime(300), isMock: true,
    actor: mockProfile('demo-yousef', 'يوسف صالح', 'yousef'),
  },
];

const notificationAction = (type: string, content: string) => {
  const actions: Record<string, string> = {
    repost: 'أعاد نشر منشورك أو ريلز',
    like: 'أعجب بمنشورك أو تعليقك',
    comment: 'علّق على منشورك',
    reply: 'ردّ على تعليقك',
    follow: 'بدأ بمتابعتك',
    mention: 'أشار إليك في تعليق أو قصة',
  };
  return actions[type] || content || 'أرسل لك إشعاراً جديداً';
};

function ActionBadge({ type }: { type: string }) {
  let Icon: LucideIcon = Bell;
  let color = 'text-[#e6a17b]';
  let label = 'إشعار';

  if (type === 'repost') {
    Icon = Repeat2;
    label = 'إعادة نشر';
  } else if (type === 'like') {
    Icon = Heart;
    color = 'text-rose-400';
    label = 'إعجاب';
  } else if (type === 'comment' || type === 'reply') {
    Icon = MessageCircle;
    color = 'text-sky-300';
    label = 'تعليق';
  } else if (type === 'follow') {
    Icon = UserRound;
    color = 'text-emerald-300';
    label = 'متابعة';
  } else if (type === 'mention') {
    Icon = AtSign;
    color = 'text-violet-300';
    label = 'إشارة';
  }

  return (
    <span
      aria-label={label}
      className={`absolute -bottom-1 -left-1 grid h-[22px] w-[22px] place-items-center rounded-full border border-[#e6a17b]/35 bg-[#121214] ${color}`}
    >
      <Icon size={12} strokeWidth={2.4} />
    </span>
  );
}

function NotificationAvatar({ item }: { item: NotificationEntry }) {
  const name = displayName(item.actor);
  return (
    <span className="relative mt-0.5 block h-[46px] w-[46px] shrink-0 rounded-full bg-gradient-to-br from-[#34343b] to-[#1c1c1f] text-center text-sm font-bold leading-[46px] text-[#f4f4f5]">
      {item.actor?.avatar_url ? (
        <img src={item.actor.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        name.slice(0, 1)
      )}
      <ActionBadge type={item.type} />
    </span>
  );
}

export default function NotificationsModal({ isOpen, onClose, currentUserId }: NotificationsModalProps) {
  const [items, setItems] = useState<NotificationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [readMockIds, setReadMockIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!isOpen) return undefined;
    if (!supabaseConfigured) {
      setError('إعدادات Supabase غير مكتملة. يمكنك تجربة الواجهة بالبيانات التجريبية.');
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
          .select('id,reference_id,actor_id')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .limit(40);

        if (!referenceResult.error) {
          refs = (referenceResult.data || []) as NotificationReferenceRow[];
        } else {
          const entityResult = await supabase
            .from('notifications')
            .select('id,entity_id,actor_id')
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
            };
          });

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

  const visibleItems = useMemo(() => showSamples
    ? MOCK_NOTIFICATIONS.map(item => ({ ...item, is_read: item.is_read || readMockIds.has(item.id) }))
    : items,
  [items, readMockIds, showSamples]);

  const markNotificationRead = async (item: NotificationEntry) => {
    if (item.is_read) return;
    if (item.isMock) {
      setReadMockIds(current => new Set(current).add(item.id));
      return;
    }

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

  const markAllRead = async () => {
    if (showSamples) {
      setReadMockIds(new Set(MOCK_NOTIFICATIONS.map(item => item.id)));
      return;
    }
    if (!supabaseConfigured || !items.some(item => !item.is_read)) return;
    setUpdating(true);
    setError('');
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', currentUserId)
      .eq('is_read', false);
    if (updateError) setError(updateError.message);
    else setItems(current => current.map(item => ({ ...item, is_read: true })));
    setUpdating(false);
  };

  if (!isOpen) return null;

  const renderCard = (item: NotificationEntry) => {
    const actorName = displayName(item.actor);
    const targetId = item.reference_id || item.entity_id;
    const target = !item.isMock && item.type === 'repost' && targetId
      ? `/post/${encodeURIComponent(targetId)}`
      : null;
    const card = (
      <article className={`aani-notifications-card relative flex w-full items-center gap-3 rounded-xl border border-white/[0.04] py-3.5 pr-3 pl-9 text-right ${item.is_read ? 'bg-[#121214] text-[#8e8e93]' : 'bg-gradient-to-l from-[#1c1c1f] to-[#121214] text-[#f4f4f5]'}`}>
        {!item.is_read && <span aria-label="غير مقروء" className="absolute left-3 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#e6a17b] shadow-[0_0_8px_rgba(230,161,123,0.85)]" />}
        <NotificationAvatar item={item} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-6">
            <strong className="font-bold">{actorName}</strong>{' '}
            <span>{notificationAction(item.type, item.content)}</span>
          </span>
          <time className="mt-1 block text-[11px] text-[#8e8e93]/80">{formatDate(item.created_at)}</time>
        </span>
      </article>
    );

    const onActivate = () => {
      void markNotificationRead(item);
      if (target) onClose();
    };

    return target ? (
      <Link key={item.id} href={target} onClick={onActivate} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[#e6a17b]">
        {card}
      </Link>
    ) : (
      <button key={item.id} type="button" onClick={onActivate} aria-label={`${actorName} ${notificationAction(item.type, item.content)}`} className="block w-full border-0 bg-transparent p-0 text-right outline-none focus-visible:ring-2 focus-visible:ring-[#e6a17b]">
        {card}
      </button>
    );
  };

  const unreadCount = visibleItems.filter(item => !item.is_read).length;

  return (
    <div className="aani-notifications-page fixed inset-0 z-[150] overflow-hidden text-[#f4f4f5]" dir="rtl">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-notifications-title"
        className="relative z-[1] mx-auto flex h-full w-full max-w-[560px] flex-col border-x border-white/[0.04]"
      >
        <header className="flex items-center justify-between border-b border-white/[0.07] px-4 pb-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
          <button type="button" onClick={onClose} className="flex min-h-10 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-[#e6a17b] transition hover:bg-white/[0.05] active:scale-[0.985]" aria-label="العودة للصفحة السابقة">
            <ArrowRight size={19} />
            <span>رجوع</span>
          </button>
          <h1 id="aani-notifications-title" className="flex items-center gap-2 text-lg font-bold">
            <Bell size={18} className="text-[#e6a17b]" /> الإشعارات
          </h1>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl text-[#8e8e93] transition hover:bg-white/[0.05] hover:text-white" aria-label="إغلاق الإشعارات">
            <X size={19} />
          </button>
        </header>

        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-xs text-[#8e8e93]">{unreadCount ? `${unreadCount} إشعارات غير مقروءة` : 'أنت على اطلاع بكل جديد'}</p>
          <div className="flex shrink-0 items-center gap-3">
            {visibleItems.some(item => !item.is_read) && (
              <button type="button" onClick={() => void markAllRead()} disabled={updating} className="flex items-center gap-1 text-xs font-semibold text-[#e6a17b] disabled:opacity-50">
                <CheckCheck size={14} /> {updating && !showSamples ? 'جارٍ التحديث…' : 'تحديد الكل كمقروء'}
              </button>
            )}
            <button type="button" onClick={() => setShowSamples(value => !value)} className="rounded-full border border-[#e6a17b]/30 px-3 py-1.5 text-xs font-semibold text-[#e6a17b] transition hover:bg-[#e6a17b]/10">
              {showSamples ? 'إخفاء النماذج' : 'عرض نماذج'}
            </button>
          </div>
        </div>

        {showSamples && <p className="mx-4 mb-2 rounded-lg border border-[#e6a17b]/20 bg-[#e6a17b]/[0.06] px-3 py-2 text-xs text-[#e6a17b]">بيانات محلية للتجربة فقط، ولن تُحفظ في حسابك.</p>}

        <div className="aani-notifications-list flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-1" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
          {loading && !showSamples && <p className="py-10 text-center text-sm text-[#8e8e93]">جارٍ تحميل الإشعارات…</p>}
          {!showSamples && error && <p role="alert" className="mb-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">{error}</p>}
          {!loading && !showSamples && !error && items.length === 0 && <p className="py-10 text-center text-sm text-[#8e8e93]">لا توجد إشعارات حالياً. يمكنك عرض النماذج لتجربة الأنواع والحالات.</p>}
          {showSamples && visibleItems.map(renderCard)}
          {!showSamples && !loading && !error && visibleItems.map(renderCard)}
        </div>
      </section>
    </div>
  );
}
