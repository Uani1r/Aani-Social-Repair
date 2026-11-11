import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import { useLocation } from 'wouter';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { releaseOverlayBackForNavigation, goBackOrPush } from '@/lib/overlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

/**
 * شاشة كاملة بتبويبين: «أتابع» (من يتابعهم صاحب الملف) و«المتابعون» (من يتابعونه)،
 * تفتح على التبويب المطلوب وتنتقل بينهما بسلاسة مع حفظ كل قائمة في الذاكرة.
 * كل الاستعلامات تمر حصراً عبر جدول public.follows.
 */
export type FollowListKind = 'followers' | 'following';

type ListState = Profile[] | null | 'failed';

type SessionCache = {
  lists: Record<FollowListKind, ListState>;
  activeKind: FollowListKind;
  scrollTop: number;
};

const TAB_LABELS: Record<FollowListKind, string> = {
  following: 'أتابع',
  followers: 'المتابعون',
};

// جلسة القائمة لكل ملف شخصي: تبويب نشط + قوائم + موضع تمرير، لتستعاد عند الرجوع
const sessionCacheByTarget = new Map<string, SessionCache>();

export default function FollowListView({ kind, targetUserId, currentUserId, onClose, onDismiss, restoreSession = false }: {
  kind: FollowListKind;
  targetUserId: string;
  currentUserId: string;
  onClose: () => void;
  /** يُستدعى قبل الانتقال لملف من القائمة: يغلق الشاشة نظيفة مع الإبقاء على مدخل السجل */
  onDismiss: () => void;
  /** افتح من سياق محفوظ (رجوع من ملف مزار): نفس التبويب والقوائم وموضع التمرير */
  restoreSession?: boolean;
}) {
  const cachedSession = sessionCacheByTarget.get(targetUserId);
  const [activeKind, setActiveKind] = useState<FollowListKind>(
    restoreSession ? cachedSession?.activeKind ?? kind : kind,
  );
  const [lists, setLists] = useState<Record<FollowListKind, ListState>>(() =>
    restoreSession && cachedSession
      ? cachedSession.lists
      : { followers: null, following: null },
  );
  const [viewerFollowingIds, setViewerFollowingIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const backGestureRef = useRef<{ x: number; y: number } | null>(null);

  // إيماءة السحب للرجوع داخل القائمة: من الحافة اليمنى نحو اليسار →
  // تستهدف سجل الصفحات حصراً فيغلق السجل الكامل الأعلى (هذه الشاشة) ويعود للخلف
  const handleBackTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    backGestureRef.current = touch.clientX >= window.innerWidth - 56
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  };

  const handleBackTouchEnd = (event: ReactTouchEvent) => {
    const start = backGestureRef.current;
    backGestureRef.current = null;
    if (!start) return;
    const last = event.changedTouches[0];
    if (!last) return;
    const deltaX = last.clientX - start.x;
    const deltaY = last.clientY - start.y;
    if (deltaX <= -70 && Math.abs(deltaX) > Math.abs(deltaY)) goBackOrPush('/profile');
  };

  useOverlayBack(true, onClose, {
    restoreData: { type: 'follow-list', kind, targetUserId },
    replaceHistory: restoreSession,
  });
  useModalBodyScrollLock();

  // استعادة موضع التمرير المحفوظ عند الفتح من سياق محفوظ (رجوع من ملف مزار)
  useEffect(() => {
    if (!restoreSession) return undefined;
    const savedScrollTop = sessionCacheByTarget.get(targetUserId)?.scrollTop ?? 0;
    const frame = window.requestAnimationFrame(() => {
      if (listScrollRef.current) listScrollRef.current.scrollTop = savedScrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // جلب كسول لكل تبويب مع تخزين القائمة في الذاكرة للتنقل السريع بينهما
  useEffect(() => {
    if (lists[activeKind] !== null) return undefined;
    let active = true;
    void (async () => {
      try {
        if (!supabaseConfigured || !targetUserId) throw new Error('unconfigured');
        const relationColumn = activeKind === 'followers' ? 'follower_id' : 'following_id';
        const ownerColumn = activeKind === 'followers' ? 'following_id' : 'follower_id';

        const { data: relationRows, error: relationError } = await supabase
          .from('follows')
          .select(`${relationColumn}, created_at`)
          .eq(ownerColumn, targetUserId)
          .order('created_at', { ascending: true, nullsFirst: false })
          .limit(1000);
        if (relationError) throw relationError;

        const ids = (relationRows || [])
          .map((row: Record<string, unknown>) => row[relationColumn])
          .filter((id): id is string => typeof id === 'string' && Boolean(id));
        if (ids.length === 0) {
          if (active) setLists(current => ({ ...current, [activeKind]: [] }));
          return;
        }

        const { data: profileRows, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, is_private, is_deactivated')
          .in('id', ids);
        if (profileError) throw profileError;

        const byId = new Map<string, Profile>((profileRows || []).map(profile => [profile.id, profile as Profile]));
        if (active) {
          setLists(current => ({
            ...current,
            [activeKind]: ids.map(id => byId.get(id)).filter((person): person is Profile => Boolean(person)),
          }));
        }
      } catch {
        if (active) setLists(current => ({ ...current, [activeKind]: 'failed' }));
      }
    })();
    return () => { active = false; };
  }, [activeKind, lists, targetUserId]);

  // حالات متابعة المستخدم الحالي (لزر المتابعة/إلغاء المتابعة)
  useEffect(() => {
    if (!currentUserId || !supabaseConfigured) return undefined;
    let active = true;
    void supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', currentUserId)
      .limit(2000)
      .then(({ data }) => {
        if (!active) return;
        setViewerFollowingIds(new Set((data || []).map(row => row.following_id)));
      });
    return () => { active = false; };
  }, [currentUserId]);

  const toggleFollow = async (person: Profile) => {
    const isFollowing = viewerFollowingIds.has(person.id);
    setBusyId(person.id);
    setViewerFollowingIds(current => {
      const next = new Set(current);
      if (isFollowing) next.delete(person.id);
      else next.add(person.id);
      return next;
    });
    try {
      if (isFollowing) {
        await supabase.from('follows').delete()
          .eq('follower_id', currentUserId)
          .eq('following_id', person.id);
      } else {
        const { error } = await supabase.from('follows').insert({
          follower_id: currentUserId,
          following_id: person.id,
        });
        if (error) throw error;
      }
    } catch {
      // تراجع عن التغيير المتفائل عند الفشل
      setViewerFollowingIds(current => {
        const next = new Set(current);
        if (isFollowing) next.add(person.id);
        else next.delete(person.id);
        return next;
      });
    } finally {
      setBusyId(null);
    }
  };

  const activeList = lists[activeKind];

  // النقر على بطاقة: احفظ سياق القائمة في مدخل السجل الخاص بها، أغلق الشاشة
  // نظيفة (بدون قفل تمرير أو خلفية)، ثم انتقل للملف الشخصي
  const openProfileFromCard = (personId: string) => {
    const scrollTop = listScrollRef.current?.scrollTop ?? 0;
    sessionCacheByTarget.set(targetUserId, { lists, activeKind, scrollTop });
    try {
      window.history.replaceState(
        { ...window.history.state, aaniOverlayRestore: { type: 'follow-list', kind: activeKind, targetUserId } },
        '',
      );
    } catch {
      /* تجاهل فشل التاريخ */
    }
    releaseOverlayBackForNavigation();
    onDismiss();
    navigate(`/profile/${encodeURIComponent(personId)}`);
  };

  // حفظ موضع التمرير باستمرار في جلسة القائمة
  const handleListScroll = () => {
    const cached = sessionCacheByTarget.get(targetUserId)
      ?? sessionCacheByTarget.set(targetUserId, { lists, activeKind, scrollTop: 0 }).get(targetUserId);
    if (cached) cached.scrollTop = listScrollRef.current?.scrollTop ?? 0;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      dir="rtl"
      onTouchStart={handleBackTouchStart}
      onTouchEnd={handleBackTouchEnd}
    >
      <header className="shrink-0 border-b border-white/10 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 py-2.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="رجوع"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white transition hover:bg-white/10"
          >
            <ArrowRight size={24} />
          </button>
          <h1 className="text-base font-bold">{TAB_LABELS[activeKind]}</h1>
        </div>
        <div className="grid grid-cols-2" role="tablist" aria-label="قوائم المتابعة">
          {(Object.keys(TAB_LABELS) as FollowListKind[]).map(tabKind => {
            const selected = tabKind === activeKind;
            return (
              <button
                key={tabKind}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveKind(tabKind)}
                className={`relative pb-2.5 pt-1 text-center text-sm font-semibold transition ${
                  selected ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {TAB_LABELS[tabKind]}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-white transition-opacity ${
                    selected ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </header>

      <div ref={listScrollRef} onScroll={handleListScroll} className="min-h-0 flex-1 overflow-y-auto">
        {activeList === null && <ListSkeleton count={6} avatarClass="h-12 w-12" className="px-4 py-2" />}
        {activeList === 'failed' && <EmptyState className="min-h-64" />}
        {Array.isArray(activeList) && activeList.length === 0 && <EmptyState className="min-h-64" />}
        {Array.isArray(activeList) && activeList.length > 0 && (
          <ul>
            {activeList.map(person => {
              const following = viewerFollowingIds.has(person.id);
              return (
                // البطاقة كاملة قابلة للنقر: الصورة والاسم واليوزر وأي فراغ ينقل لملف الشخص
                // — النقل يتم دون إغلاق الشاشة حتى يعود المستخدم إليها بالضغط على الرجوع.
                <li
                  key={person.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openProfileFromCard(person.id)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openProfileFromCard(person.id);
                  }}
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition hover:bg-white/[0.03]"
                >
                  <Avatar profile={person} large />
                  <UserIdentity
                    name={displayName(person)}
                    username={person.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-sm font-semibold text-white"
                    usernameClassName="text-xs text-zinc-400"
                  />
                  {person.id !== currentUserId && (
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        void toggleFollow(person);
                      }}
                      disabled={busyId === person.id}
                      aria-pressed={following}
                      className={`relative z-10 shrink-0 rounded-full px-4 py-1.5 text-[13px] font-semibold transition disabled:opacity-50 ${
                        following
                          ? 'border border-[#53575B] bg-transparent text-white hover:bg-white/10'
                          : 'bg-white text-black hover:bg-neutral-200'
                      }`}
                    >
                      {following ? 'متابَع' : 'متابعة'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
