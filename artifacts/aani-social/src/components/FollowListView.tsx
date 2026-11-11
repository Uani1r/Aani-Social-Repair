import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import { Link } from 'wouter';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

/**
 * شاشة كاملة لقائمة المتابعين أو المُتابَعين:
 * شريط علوي بزر رجوع وعنوان، وقائمة حسابات (صورة + اسم + يوزر)
 * مع زر متابعة/إلغاء متابعة، والانتقال للملف بالنقر على أي حساب.
 * كل الاستعلامات تمر حصراً عبر جدول public.follows.
 */
export type FollowListKind = 'followers' | 'following';

export default function FollowListView({ kind, targetUserId, currentUserId, onClose }: {
  kind: FollowListKind;
  targetUserId: string;
  currentUserId: string;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<Profile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerFollowingIds, setViewerFollowingIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  useOverlayBack(true, onClose);
  useModalBodyScrollLock();

  // القائمة: علاقات المتابعة من جدول follows ثم بيانات الحسابات من profiles
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!supabaseConfigured || !targetUserId) throw new Error('unconfigured');
        const relationColumn = kind === 'followers' ? 'follower_id' : 'following_id';
        const ownerColumn = kind === 'followers' ? 'following_id' : 'follower_id';

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
          if (active) setPeople([]);
          return;
        }

        const { data: profileRows, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, is_private, is_deactivated')
          .in('id', ids);
        if (profileError) throw profileError;

        const byId = new Map<string, Profile>((profileRows || []).map(profile => [profile.id, profile as Profile]));
        if (active) setPeople(ids.map(id => byId.get(id)).filter((person): person is Profile => Boolean(person)));
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; };
  }, [kind, targetUserId]);

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

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex flex-col bg-black text-white" role="dialog" aria-modal="true" dir="rtl">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-3 py-2.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="رجوع"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white transition hover:bg-white/10"
        >
          <ArrowRight size={24} />
        </button>
        <h1 className="text-base font-bold">
          {kind === 'followers' ? 'المتابعون' : 'المتابَعون'}
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {people === null && !failed && <ListSkeleton count={6} avatarClass="h-12 w-12" className="px-4 py-2" />}
        {failed && <EmptyState className="min-h-64" />}
        {people !== null && !failed && people.length === 0 && <EmptyState className="min-h-64" />}
        {people !== null && !failed && people.length > 0 && (
          <ul>
            {people.map(person => {
              const following = viewerFollowingIds.has(person.id);
              return (
                <li key={person.id} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-white/[0.03]">
                  <Link href={`/profile/${encodeURIComponent(person.id)}`} onClick={onClose} className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar profile={person} large />
                    <UserIdentity
                      name={displayName(person)}
                      username={person.username}
                      className="min-w-0 flex-1"
                      nameClassName="text-sm font-semibold text-white"
                      usernameClassName="text-xs text-zinc-400"
                    />
                  </Link>
                  {person.id !== currentUserId && (
                    <button
                      type="button"
                      onClick={() => void toggleFollow(person)}
                      disabled={busyId === person.id}
                      aria-pressed={following}
                      className={`shrink-0 rounded-full px-4 py-1.5 text-[13px] font-semibold transition disabled:opacity-50 ${
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
