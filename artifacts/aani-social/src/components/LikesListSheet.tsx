import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Link } from 'wouter';
import { toast } from 'sonner';

import Avatar from './Avatar';
import UserIdentity from './UserIdentity';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

type LikeUser = {
  id: string;
  profile: Partial<Profile>;
  isFollowing: boolean;
  requestPending: boolean;
};

function normalizeProfile(value: unknown, id: string): Partial<Profile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { id, full_name: 'مستخدم' };
  }

  const row = value as Record<string, unknown>;
  return {
    id,
    username: typeof row.username === 'string' ? row.username : undefined,
    full_name: typeof row.full_name === 'string' ? row.full_name : undefined,
    display_name: typeof row.display_name === 'string' || row.display_name === null
      ? row.display_name
      : undefined,
    avatar_url: typeof row.avatar_url === 'string' || row.avatar_url === null
      ? row.avatar_url
      : null,
    is_private: row.is_private === true,
  };
}

export default function LikesListSheet({ postId, currentUserId, open, onClose }: {
  postId: string;
  currentUserId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<LikeUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [pendingFollowId, setPendingFollowId] = useState<string | null>(null);
  const {
    dragOffset,
    dragging,
    onClickCapture: onHandleClickCapture,
    onPointerDown: onHandlePointerDown,
    onTouchStart: onHandleTouchStart,
    onTouchMove: onHandleTouchMove,
    onTouchEnd: onHandleTouchEnd,
    onTouchCancel: onHandleTouchCancel,
  } = useBottomSheetDismiss(open, onClose);

  useEffect(() => {
    if (!open) return undefined;

    let active = true;
    setUsers([]);
    setError(false);
    setLoading(true);

    void (async () => {
      if (!supabaseConfigured) throw new Error('Supabase is not configured');

      const likes: Array<{ user_id?: string | null }> = [];
      for (let offset = 0; ; offset += 500) {
        const { data: page, error: likesError } = await supabase
          .from('likes')
          .select('user_id, created_at')
          .eq('post_id', postId)
          .order('created_at', { ascending: false })
          .range(offset, offset + 499);
        if (likesError) throw likesError;
        const rows = (page ?? []) as Array<{ user_id?: string | null }>;
        likes.push(...rows);
        if (rows.length < 500) break;
      }

      const likerIds = Array.from(new Set(
        likes
          .map(row => String(row.user_id || ''))
          .filter(Boolean),
      ));
      if (likerIds.length === 0) {
        if (active) setUsers([]);
        return;
      }

      const profilesById = new Map<string, Partial<Profile>>();
      for (let offset = 0; offset < likerIds.length; offset += 200) {
        const profileIds = likerIds.slice(offset, offset + 200);
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, is_private')
          .in('id', profileIds);
        if (profilesError) throw profilesError;
        (profiles ?? []).forEach((profile: Record<string, unknown>) => {
          if (typeof profile.id === 'string') profilesById.set(profile.id, normalizeProfile(profile, profile.id));
        });
      }

      const otherIds = likerIds.filter(id => id !== currentUserId);
      const followingIds = new Set<string>();
      const pendingRequestIds = new Set<string>();
      if (otherIds.length > 0 && currentUserId) {
        for (let offset = 0; offset < otherIds.length; offset += 200) {
          const userIds = otherIds.slice(offset, offset + 200);
          const [followsResult, requestsResult] = await Promise.all([
            supabase
              .from('follows')
              .select('following_id')
              .eq('follower_id', currentUserId)
              .in('following_id', userIds),
            supabase
              .from('follow_requests')
              .select('recipient_id')
              .eq('requester_id', currentUserId)
              .in('recipient_id', userIds),
          ]);
          if (followsResult.error) throw followsResult.error;
          if (requestsResult.error) throw requestsResult.error;
          (followsResult.data ?? []).forEach((row: { following_id: string }) => followingIds.add(row.following_id));
          (requestsResult.data ?? []).forEach((row: { recipient_id: string }) => pendingRequestIds.add(row.recipient_id));
        }
      }

      if (!active) return;
      setUsers(likerIds.map(id => ({
        id,
        profile: profilesById.get(id) ?? { id, full_name: 'مستخدم' },
        isFollowing: followingIds.has(id),
        requestPending: pendingRequestIds.has(id),
      })));
    })().catch(loadError => {
      console.error('[likes] تعذر تحميل قائمة الإعجابات:', loadError);
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [currentUserId, open, postId]);

  const toggleFollow = async (user: LikeUser) => {
    if (!supabaseConfigured || !currentUserId || user.id === currentUserId || pendingFollowId) return;
    setPendingFollowId(user.id);

    try {
      if (user.isFollowing) {
        const { error: followError } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', currentUserId)
          .eq('following_id', user.id);
        if (followError) throw followError;
        setUsers(current => current.map(item => item.id === user.id
          ? { ...item, isFollowing: false }
          : item));
        toast.success('تم إلغاء المتابعة');
      } else if (user.requestPending) {
        const { error: requestError } = await supabase
          .from('follow_requests')
          .delete()
          .eq('requester_id', currentUserId)
          .eq('recipient_id', user.id);
        if (requestError) throw requestError;
        setUsers(current => current.map(item => item.id === user.id
          ? { ...item, requestPending: false }
          : item));
        toast.success('تم إلغاء طلب المتابعة');
      } else if (user.profile.is_private) {
        const { error: requestError } = await supabase.from('follow_requests').insert({
          requester_id: currentUserId,
          recipient_id: user.id,
        });
        if (requestError && requestError.code !== '23505') throw requestError;
        setUsers(current => current.map(item => item.id === user.id
          ? { ...item, requestPending: true }
          : item));
        toast.success(requestError ? 'سبق إرسال طلب المتابعة' : 'تم إرسال طلب المتابعة');
      } else {
        const { error: followError } = await supabase.from('follows').insert({
          follower_id: currentUserId,
          following_id: user.id,
        });
        if (followError && followError.code !== '23505') throw followError;
        setUsers(current => current.map(item => item.id === user.id
          ? { ...item, isFollowing: true }
          : item));
        toast.success(followError ? 'الحساب متابَع بالفعل' : 'تمت متابعة الحساب');
      }
    } catch (followError) {
      console.error('[likes] تعذر تحديث المتابعة:', followError);
      toast.error('تعذر تحديث حالة المتابعة. حاول مرة أخرى.');
    } finally {
      setPendingFollowId(null);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="comments-sheet-overlay fixed inset-0 z-[2000] flex items-end justify-center"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="الإعجابات"
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onPointerCancel={event => event.stopPropagation()}
      onTouchStart={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
      onTouchEnd={event => event.stopPropagation()}
      onTouchCancel={event => event.stopPropagation()}
    >
      <div className="absolute inset-0" onClick={onClose} />

      <section
        aria-label="الإعجابات"
        className="comments-sheet-panel relative z-10 flex w-full flex-col text-white"
        style={{
          transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
          transition: dragging ? 'none' : undefined,
        }}
        onClick={event => event.stopPropagation()}
      >
        <div
          className="comments-sheet-handle-area"
          onClickCapture={onHandleClickCapture}
          onPointerDown={event => {
            event.stopPropagation();
            onHandlePointerDown(event);
          }}
          onTouchStart={event => {
            event.stopPropagation();
            onHandleTouchStart(event);
          }}
          onTouchMove={event => {
            event.stopPropagation();
            onHandleTouchMove(event);
          }}
          onTouchEnd={event => {
            event.stopPropagation();
            onHandleTouchEnd(event);
          }}
          onTouchCancel={event => {
            event.stopPropagation();
            onHandleTouchCancel();
          }}
        >
          <span className="comments-sheet-handle" aria-hidden="true" />
        </div>

        <header className="comments-sheet-header flex shrink-0 items-center justify-between px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
            aria-label="إغلاق الإعجابات"
          >
            <X size={20} />
          </button>
          <h2 className="text-base font-bold text-zinc-100">الإعجابات</h2>
          <div className="w-8" />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {loading ? (
            <p className="py-8 text-center text-xs text-zinc-400">جارٍ تحميل قائمة الإعجابات...</p>
          ) : error ? (
            <p className="py-8 text-center text-xs text-zinc-400">تعذر تحميل قائمة الإعجابات.</p>
          ) : users.length === 0 ? (
            <p className="py-8 text-center text-xs text-zinc-400">لا توجد إعجابات بعد.</p>
          ) : (
            <ul className="space-y-1">
              {users.map(user => (
                <li key={user.id} className="flex items-center gap-3 rounded-xl px-1 py-2">
                  <Link href={`/profile/${encodeURIComponent(user.id)}`} aria-label={`الملف الشخصي لـ ${displayName(user.profile)}`}>
                    <Avatar profile={user.profile} />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <UserIdentity
                      name={<Link href={`/profile/${encodeURIComponent(user.id)}`} className="hover:underline">{displayName(user.profile)}</Link>}
                      username={user.profile.username || 'اسم المستخدم غير متاح'}
                      nameClassName="text-xs font-semibold text-white"
                      usernameClassName="text-[10px] text-zinc-400"
                    />
                  </div>
                  {user.id !== currentUserId && currentUserId && (
                    <button
                      type="button"
                      onClick={() => void toggleFollow(user)}
                      disabled={pendingFollowId !== null}
                      className={`shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition disabled:opacity-50 ${user.isFollowing || user.requestPending
                        ? 'border-white/15 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
                        : 'border-pink-400/40 bg-pink-500/15 text-pink-200 hover:bg-pink-500/25'
                      }`}
                      aria-label={user.isFollowing
                        ? `إلغاء متابعة ${displayName(user.profile)}`
                        : user.requestPending
                          ? `إلغاء طلب متابعة ${displayName(user.profile)}`
                          : `متابعة ${displayName(user.profile)}`}
                    >
                      {user.isFollowing ? 'إلغاء المتابعة' : user.requestPending ? 'إلغاء الطلب' : 'متابعة'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
