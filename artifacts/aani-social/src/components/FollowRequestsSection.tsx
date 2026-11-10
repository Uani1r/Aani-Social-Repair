import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, UserPlus, UserRound, X } from 'lucide-react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';
import { ListSkeleton } from '@/components/Skeletons';

type FollowRequestEntry = {
  requester_id: string;
  created_at: string;
  profile: Profile | null;
  isMock?: boolean;
};

type FollowRequestRow = Pick<FollowRequestEntry, 'requester_id' | 'created_at'>;

const MOCK_TTL_MS = 60 * 60 * 1000;
const MOCK_REQUESTS_COUNT = 2;
const mockExpiryStorageKey = (userId: string) => `aani:mock-follow-requests:expires:${userId}`;
const mockReadStorageKey = (userId: string) => `aani:mock-follow-requests:read:${userId}`;

const createMockRequests = (displayedAt: number): FollowRequestEntry[] => [
  {
    requester_id: 'mock-ahmad',
    created_at: new Date(displayedAt - 5 * 60 * 1000).toISOString(),
    isMock: true,
    profile: {
      id: 'mock-ahmad',
      username: 'ahmad',
      full_name: 'أحمد',
      display_name: 'أحمد',
      avatar_url: null,
      bio: '',
      is_private: false,
    },
  },
  {
    requester_id: 'mock-sara',
    created_at: new Date(displayedAt - 60 * 60 * 1000).toISOString(),
    isMock: true,
    profile: {
      id: 'mock-sara',
      username: 'sara',
      full_name: 'سارة',
      display_name: 'سارة',
      avatar_url: null,
      bio: '',
      is_private: false,
    },
  },
];

const formatRequestTime = (value: string) => {
  const difference = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(difference)) return '';
  const formatter = new Intl.RelativeTimeFormat('ar-IQ', { numeric: 'auto' });
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 60_000) return formatter.format(Math.round(difference / 1_000), 'second');
  if (absoluteDifference < 3_600_000) return formatter.format(Math.round(difference / 60_000), 'minute');
  if (absoluteDifference < 86_400_000) return formatter.format(Math.round(difference / 3_600_000), 'hour');
  return formatter.format(Math.round(difference / 86_400_000), 'day');
};

export default function FollowRequestsSection({
  currentUserId,
  dir = 'rtl',
  openInitially = false,
  onOpenInitiallyHandled,
}: {
  currentUserId: string;
  dir?: 'rtl' | 'ltr';
  openInitially?: boolean;
  onOpenInitiallyHandled?: () => void;
}) {
  const [requests, setRequests] = useState<FollowRequestEntry[]>([]);
  const [mockRequests, setMockRequests] = useState<FollowRequestEntry[]>([]);
  const [mockVisible, setMockVisible] = useState(false);
  const [mockUnreadCount, setMockUnreadCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refreshUnreadCountRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setMockVisible(false);
    setMockRequests([]);
    setMockUnreadCount(0);
    if (!currentUserId) return undefined;

    let expiresAt: number;
    let alreadyRead = false;
    try {
      const savedExpiry = window.localStorage.getItem(mockExpiryStorageKey(currentUserId));
      if (savedExpiry === null) {
        expiresAt = Date.now() + MOCK_TTL_MS;
        window.localStorage.setItem(mockExpiryStorageKey(currentUserId), String(expiresAt));
      } else {
        expiresAt = Number(savedExpiry);
      }
      alreadyRead = window.localStorage.getItem(mockReadStorageKey(currentUserId)) === 'true';
    } catch {
      expiresAt = Date.now() + MOCK_TTL_MS;
    }

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;

    const displayedAt = expiresAt - MOCK_TTL_MS;
    setMockRequests(createMockRequests(displayedAt));
    setMockVisible(true);
    setMockUnreadCount(alreadyRead ? 0 : MOCK_REQUESTS_COUNT);
    const timeoutId = window.setTimeout(() => {
      setMockVisible(false);
      setMockRequests([]);
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeoutId);
  }, [currentUserId]);

  useEffect(() => {
    setRequests([]);
    if (!supabaseConfigured || !currentUserId) {
      setLoading(false);
      return undefined;
    }

    let active = true;

    const refreshUnreadCount = async () => {
      const { count, error: countError } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUserId)
        .eq('type', 'follow_request')
        .eq('is_read', false);
      if (!active) return;
      if (countError) {
        console.warn('[notifications] تعذر تحميل عدد طلبات المتابعة الجديدة:', countError);
        return;
      }
      setUnreadCount(count || 0);
    };

    const loadRequests = async () => {
      setLoading(true);
      const { data, error: requestsError } = await supabase
        .from('follow_requests')
        .select('requester_id,created_at')
        .eq('recipient_id', currentUserId)
        .order('created_at', { ascending: false });
      if (!active) return;
      if (requestsError) {
        console.warn('[notifications] تعذر تحميل طلبات المتابعة:', requestsError);
        setError('تعذر تحميل طلبات المتابعة. حاول مرة أخرى.');
        setRequests([]);
        setLoading(false);
        return;
      }

      const rows = (data || []) as FollowRequestRow[];
      const requesterIds = [...new Set(rows.map(row => row.requester_id))];
      const { data: profiles, error: profilesError } = requesterIds.length
        ? await supabase
          .from('profiles')
          .select('id,username,full_name,display_name,avatar_url,bio,is_private')
          .in('id', requesterIds)
        : { data: [], error: null };
      if (!active) return;
      if (profilesError) console.warn('[notifications] تعذر تحميل ملفات أصحاب طلبات المتابعة:', profilesError);
      const profileById = new Map<string, Profile>(
        ((profiles || []) as Profile[]).map(profile => [profile.id, profile] as [string, Profile]),
      );
      setRequests(rows.map(row => ({
        ...row,
        profile: profileById.get(row.requester_id) || null,
      })));
      setLoading(false);
    };

    refreshUnreadCountRef.current = () => { void refreshUnreadCount(); };
    void loadRequests();
    void refreshUnreadCount();

    const channel = supabase
      .channel(`follow-requests-notifications-${currentUserId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'follow_requests',
        filter: `recipient_id=eq.${currentUserId}`,
      }, () => {
        void loadRequests();
        void refreshUnreadCount();
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${currentUserId}`,
      }, payload => {
        if ((payload.new as { type?: string } | null)?.type === 'follow_request') {
          void refreshUnreadCount();
        }
      })
      .subscribe();

    return () => {
      active = false;
      refreshUnreadCountRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  const openRequests = useCallback(() => {
    setOverlayOpen(true);
    setUnreadCount(0);
    setMockUnreadCount(0);
    setError('');
    try {
      window.localStorage.setItem(mockReadStorageKey(currentUserId), 'true');
    } catch {
      // The demo stays usable if browser storage is unavailable.
    }
    if (!supabaseConfigured) return;
    void (async () => {
      const { error: updateError } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', currentUserId)
        .eq('type', 'follow_request')
        .eq('is_read', false);
      if (updateError) {
        console.warn('[notifications] تعذر تحديد طلبات المتابعة كمقروءة:', updateError);
        setError('تعذر حفظ طلبات المتابعة كمقروءة.');
        refreshUnreadCountRef.current?.();
      }
    })();
  }, [currentUserId]);

  useEffect(() => {
    if (!openInitially) return;
    openRequests();
    onOpenInitiallyHandled?.();
  }, [onOpenInitiallyHandled, openInitially, openRequests]);

  const respondToRequest = async (requesterId: string, accept: boolean) => {
    if (busyRequestId) return;
    if (mockRequests.some(request => request.requester_id === requesterId)) {
      setMockRequests(current => current.filter(request => request.requester_id !== requesterId));
      return;
    }
    if (!supabaseConfigured) return;
    setBusyRequestId(requesterId);
    setError('');

    if (accept) {
      const { error: followError } = await supabase
        .from('follows')
        .insert({ follower_id: requesterId, following_id: currentUserId });
      if (followError && followError.code !== '23505') {
        setError('تعذر قبول طلب المتابعة. حاول مرة أخرى.');
        setBusyRequestId(null);
        return;
      }
    }

    const { error: deleteError } = await supabase
      .from('follow_requests')
      .delete()
      .eq('requester_id', requesterId)
      .eq('recipient_id', currentUserId);
    if (deleteError) {
      setError(accept ? 'تم قبول الطلب لكن تعذر إزالته من القائمة.' : 'تعذر رفض طلب المتابعة. حاول مرة أخرى.');
      setBusyRequestId(null);
      return;
    }

    setRequests(current => current.filter(request => request.requester_id !== requesterId));
    setBusyRequestId(null);
  };

  useEffect(() => {
    if (!overlayOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOverlayOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [overlayOpen]);

  const visibleRequests = [
    ...requests,
    ...(mockVisible ? mockRequests : []),
  ].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  const totalUnreadCount = unreadCount + mockUnreadCount;

  if (!requests.length && !mockVisible && !overlayOpen) return null;

  return (
    <>
      <div className="px-4 pt-4">
        <button
          type="button"
          onClick={openRequests}
          className="flex w-full items-center justify-between rounded-[20px] border border-[#c98a66]/[0.2] bg-[#141414] px-4 py-4 text-right transition active:scale-[0.98] active:bg-[#1a1a1a]"
          aria-label={`فتح طلبات المتابعة${totalUnreadCount ? `، ${totalUnreadCount} طلب جديد` : ''}`}
        >
          <span className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-[#222] text-[#c98a66]">
              <UserPlus size={22} strokeWidth={2} />
            </span>
            <span className="text-[15px] font-bold text-[#f0f0f0]">طلبات المتابعة</span>
          </span>
          {totalUnreadCount > 0 && (
            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-[#c98a66] px-1.5 text-[13px] font-extrabold text-black">
              {Intl.NumberFormat('ar-IQ').format(totalUnreadCount)}
            </span>
          )}
        </button>
      </div>

      <div
        className={`fixed inset-0 z-[170] flex transform flex-col bg-[#0a0a0a] text-[#f0f0f0] transition-transform duration-[400ms] [transition-timing-function:cubic-bezier(0.25,0.8,0.25,1)] ${overlayOpen ? 'pointer-events-auto translate-y-0' : 'pointer-events-none translate-y-full'}`}
        dir={dir}
        role="dialog"
        aria-modal={overlayOpen}
        aria-labelledby="aani-follow-requests-title"
        aria-hidden={!overlayOpen}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[#1f1f1f] px-4 py-5" style={{ paddingTop: 'max(20px, env(safe-area-inset-top))' }}>
          <button
            type="button"
            onClick={() => setOverlayOpen(false)}
            tabIndex={overlayOpen ? 0 : -1}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#f0f0f0]"
            aria-label="العودة إلى الإشعارات"
          >
            <ChevronLeft size={24} />
          </button>
          <h2 id="aani-follow-requests-title" className="text-[20px] font-bold">طلبات المتابعة</h2>
          <button
            type="button"
            onClick={() => setOverlayOpen(false)}
            tabIndex={overlayOpen ? 0 : -1}
            className="mr-auto grid h-9 w-9 place-items-center rounded-lg text-[#888]"
            aria-label="إغلاق طلبات المتابعة"
          >
            <X size={22} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
          {error && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">{error}</p>}
          {loading && <ListSkeleton count={4} className="px-2" />}
          {!loading && visibleRequests.length === 0 && <p className="py-8 text-center text-sm text-[#888]">لا توجد طلبات متابعة حالياً.</p>}
          {visibleRequests.map(request => {
            const name = displayName(request.profile);
            return (
              <article key={request.requester_id} className="flex min-h-[96px] items-center gap-3 rounded-[20px] bg-[#141414] p-4">
                <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-[#222] text-[#555]">
                  {request.profile?.avatar_url
                    ? <img src={request.profile.avatar_url} alt="" className="h-full w-full object-cover" />
                    : <UserRound size={28} strokeWidth={1.8} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <strong className="truncate text-[16px] font-bold text-[#f0f0f0]">{name}</strong>
                  <time className="text-[12px] text-[#888]">{formatRequestTime(request.created_at)}</time>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={!overlayOpen || Boolean(busyRequestId)}
                    onClick={() => void respondToRequest(request.requester_id, true)}
                    className="rounded-[10px] bg-[#c98a66] px-4 py-2 text-[14px] font-bold text-black transition active:opacity-70 disabled:opacity-50"
                  >قبول</button>
                  <button
                    type="button"
                    disabled={!overlayOpen || Boolean(busyRequestId)}
                    onClick={() => void respondToRequest(request.requester_id, false)}
                    className="rounded-[10px] bg-[#222] px-4 py-2 text-[14px] font-bold text-[#f0f0f0] transition active:opacity-70 disabled:opacity-50"
                  >رفض</button>
                </span>
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}
