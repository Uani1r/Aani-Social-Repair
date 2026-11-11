import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Link } from 'wouter';

import Avatar from './Avatar';
import { ListSkeleton } from './Skeletons';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import EmptyState from '@/components/EmptyState';
import FollowButton from '@/components/FollowButton';
import { setFollowState } from '@/lib/followState';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { cleanUsername, displayName, type Profile } from '@/lib/types';

type LikeUser = {
  id: string;
  profile: Partial<Profile>;
  isFollowing: boolean;
  isFollower: boolean;
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
  // زر الرجوع (الهاتف/المتصفح) يغلق قائمة الإعجابات دون مغادرة الصفحة
  useOverlayBack(open, onClose);
  const [users, setUsers] = useState<LikeUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
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
      const followerIds = new Set<string>();
      const pendingRequestIds = new Set<string>();
      if (otherIds.length > 0 && currentUserId) {
        for (let offset = 0; offset < otherIds.length; offset += 200) {
          const userIds = otherIds.slice(offset, offset + 200);
          const [followsResult, followersResult, requestsResult] = await Promise.all([
            supabase
              .from('follows')
              .select('following_id')
              .eq('follower_id', currentUserId)
              .in('following_id', userIds),
            supabase
              .from('follows')
              .select('follower_id')
              .eq('following_id', currentUserId)
              .in('follower_id', userIds),
            supabase
              .from('follow_requests')
              .select('recipient_id')
              .eq('requester_id', currentUserId)
              .in('recipient_id', userIds),
          ]);
          if (followsResult.error) throw followsResult.error;
          if (followersResult.error) throw followersResult.error;
          if (requestsResult.error) throw requestsResult.error;
          (followsResult.data ?? []).forEach((row: { following_id: string }) => followingIds.add(row.following_id));
          (followersResult.data ?? []).forEach((row: { follower_id: string }) => followerIds.add(row.follower_id));
          (requestsResult.data ?? []).forEach((row: { recipient_id: string }) => pendingRequestIds.add(row.recipient_id));
        }
      }

      if (!active) return;
      const loadedUsers = likerIds.map(id => ({
        id,
        profile: profilesById.get(id) ?? { id, full_name: 'مستخدم' },
        isFollowing: followingIds.has(id),
        isFollower: followerIds.has(id),
        requestPending: pendingRequestIds.has(id),
      }));
      setUsers(loadedUsers);
      // زرع حالة المتابعة في المخزن الموحد ليتزامن الزر عبر كل الشاشات
      loadedUsers.forEach(user => setFollowState(user.id, {
        following: user.isFollowing,
        requestSent: user.requestPending,
      }));
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

  const sortedUsers = [...users].sort((first, second) => {
    const priority = (user: LikeUser) => user.isFollowing ? 0 : user.isFollower ? 1 : 2;
    return priority(first) - priority(second);
  });

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
            <ListSkeleton count={6} compact />
          ) : error ? (
            <p className="py-8 text-center text-xs text-zinc-400">تعذر تحميل قائمة الإعجابات.</p>
          ) : users.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="space-y-1">
              {sortedUsers.map(user => {
                const name = displayName(user.profile);
                const username = cleanUsername(user.profile.username);
                return (
                  <li key={user.id} dir="rtl" className="flex min-w-0 flex-row items-center gap-3 rounded-xl px-1 py-2">
                    <Link
                      href={`/profile/${encodeURIComponent(user.id)}`}
                      aria-label={`الملف الشخصي لـ ${name}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                      onClick={onClose}
                    >
                      <Avatar profile={user.profile} />
                      <div className="min-w-0 flex-1 text-right" dir="rtl">
                        <span
                          className="block whitespace-normal break-words leading-5 hover:underline"
                          style={{ color: '#ffffff', fontWeight: 600 }}
                        >
                          {name}
                        </span>
                        <span
                          dir="ltr"
                          className="block whitespace-normal break-all text-right leading-5"
                          style={{ color: '#a0a0a0', fontSize: 13 }}
                        >
                          {username || 'اسم المستخدم غير متاح'}
                        </span>
                      </div>
                    </Link>
                    {user.id !== currentUserId && currentUserId && (
                      <FollowButton
                        targetUserId={user.id}
                        currentUserId={currentUserId}
                        isPrivate={user.profile.is_private}
                        followsMe={user.isFollower}
                        initialFollowing={user.isFollowing}
                        initialRequestSent={user.requestPending}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
