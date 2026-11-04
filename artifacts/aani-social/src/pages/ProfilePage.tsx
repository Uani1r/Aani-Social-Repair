import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import FeedPostCard from '@/components/FeedPostCard';
import UserIdentity from '@/components/UserIdentity';
import { usePosts } from '@/hooks/usePosts';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

export default function ProfilePage({
  targetUserId,
  currentUserId,
  profile,
  onProfileUpdate,
  onOpenComments,
  onOpenStories,
}: {
  targetUserId: string;
  currentUserId: string;
  profile: Profile | null;
  onProfileUpdate: (next: Profile) => void;
  onOpenComments: (postId: string) => void;
  onOpenStories: (profileId: string) => void;
}) {
  const activeUserId = targetUserId || currentUserId;
  const own = activeUserId === currentUserId;

  const [person, setPerson] = useState<Profile | null>(own ? profile : null);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [postCount, setPostCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followRequestSent, setFollowRequestSent] = useState(false);
  const [followRequests, setFollowRequests] = useState<Array<{ profile: Profile; created_at: string }>>([]);
  const [hasActiveStories, setHasActiveStories] = useState(false);
  const [hasCloseFriendsStory, setHasCloseFriendsStory] = useState(false);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [, setLocation] = useLocation();

  const { posts, loading, refresh, error } = usePosts('profile', activeUserId, currentUserId);

  useEffect(() => {
    if (!supabaseConfigured || !activeUserId) return;
    let active = true;
    const loadProfileData = async () => {
      const [{ data: prof }, { count: fCount }, { count: fingCount }, { count: pCount }, { data: checkFollow }, { data: checkRequest }, { data: activeStories, error: activeStoriesError }, { data: incomingRequests }] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', activeUserId).maybeSingle(),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', activeUserId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', activeUserId),
        supabase.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', activeUserId),
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', currentUserId).eq('following_id', activeUserId).maybeSingle(),
        own ? Promise.resolve({ data: null }) : supabase.from('follow_requests').select('requester_id').eq('requester_id', currentUserId).eq('recipient_id', activeUserId).maybeSingle(),
        supabase.from('stories').select('id, is_close_friends').eq('user_id', activeUserId).limit(50),
        own
          ? supabase.from('follow_requests').select('requester_id, created_at').eq('recipient_id', currentUserId).order('created_at', { ascending: false }).limit(100)
          : Promise.resolve({ data: [] }),
      ]);

      const requestRows = (incomingRequests || []) as Array<{ requester_id: string; created_at: string }>;
      const requesterIds = [...new Set(requestRows.map(row => row.requester_id))];
      const { data: requesterProfiles } = requesterIds.length
        ? await supabase.from('profiles').select('id, username, full_name, avatar_url, bio, is_private').in('id', requesterIds)
        : { data: [] };
      if (!active) return;
      if (activeStoriesError) {
        console.error('[profile stories] تعذر التحقق من القصص النشطة:', activeStoriesError);
        toast.error(`تعذر التحقق من قصص الحساب: ${activeStoriesError.message}`);
      }

      if (prof) setPerson(prof as Profile);
      setFollowers(fCount || 0);
      setFollowing(fingCount || 0);
      setPostCount(pCount || 0);
      setIsFollowing(Boolean(checkFollow));
      setFollowRequestSent(Boolean(checkRequest));
      setHasActiveStories(Boolean(activeStories?.length));
      setHasCloseFriendsStory(Boolean(activeStories?.some(story => story.is_close_friends)));
      const profileById = new Map<string, Profile>(((requesterProfiles || []) as Profile[]).map(requester => [requester.id, requester] as [string, Profile]));
      setFollowRequests(requestRows.flatMap(row => {
        const requester = profileById.get(row.requester_id);
        return requester ? [{ profile: requester, created_at: row.created_at }] : [];
      }));
    };
    void loadProfileData();
    return () => { active = false; };
  }, [activeUserId, currentUserId, own]);

  const toggleFollow = async () => {
    if (!supabaseConfigured || own || !person) return;
    if (isFollowing) {
      const { error } = await supabase.from('follows').delete().eq('follower_id', currentUserId).eq('following_id', activeUserId);
      if (error) {
        toast.error('تعذرت إزالة المتابعة');
        return;
      }
      setFollowers(prev => Math.max(0, prev - 1));
      setIsFollowing(false);
      return;
    }

    if (followRequestSent) {
      const { error } = await supabase.from('follow_requests').delete().eq('requester_id', currentUserId).eq('recipient_id', activeUserId);
      if (error) {
        toast.error('تعذر إلغاء طلب المتابعة');
        return;
      }
      setFollowRequestSent(false);
      toast.success('تم إلغاء طلب المتابعة');
      return;
    }

    if (person.is_private) {
      const { error } = await supabase.from('follow_requests').insert({ requester_id: currentUserId, recipient_id: activeUserId });
      if (error) {
        toast.error('تعذر إرسال طلب المتابعة');
        return;
      }
      setFollowRequestSent(true);
      toast.success('تم إرسال طلب المتابعة');
      return;
    }

    const { error } = await supabase.from('follows').insert({ follower_id: currentUserId, following_id: activeUserId });
    if (error && error.code !== '23505') {
      toast.error('تعذرت متابعة هذا الحساب');
      return;
    }
    setFollowers(prev => prev + (error ? 0 : 1));
    setIsFollowing(true);
  };

  const respondToFollowRequest = async (requesterId: string, accept: boolean) => {
    if (!supabaseConfigured || !own || busyRequestId) return;
    setBusyRequestId(requesterId);

    if (accept) {
      const { error } = await supabase.from('follows').insert({ follower_id: requesterId, following_id: currentUserId });
      if (error && error.code !== '23505') {
        toast.error('تعذر قبول طلب المتابعة');
        setBusyRequestId(null);
        return;
      }
      if (!error) setFollowers(value => value + 1);
    }

    const { error: deleteError } = await supabase
      .from('follow_requests')
      .delete()
      .eq('requester_id', requesterId)
      .eq('recipient_id', currentUserId);
    if (deleteError) {
      toast.error(accept ? 'تمت الموافقة لكن تعذر إخفاء الطلب' : 'تعذر رفض طلب المتابعة');
      setBusyRequestId(null);
      return;
    }

    setFollowRequests(current => current.filter(request => request.profile.id !== requesterId));
    setBusyRequestId(null);
    toast.success(accept ? 'تم قبول طلب المتابعة' : 'تم رفض طلب المتابعة');
  };

  const toggleAccountPrivacy = async () => {
    if (!supabaseConfigured || !own || !person || privacySaving) return;
    const isPrivate = !Boolean(person.is_private);
    setPrivacySaving(true);
    const { error } = await supabase.from('profiles').update({ is_private: isPrivate }).eq('id', currentUserId);
    if (error) {
      toast.error('تعذر تحديث خصوصية الحساب');
      setPrivacySaving(false);
      return;
    }

    const updatedProfile = { ...person, is_private: isPrivate };
    setPerson(updatedProfile);
    onProfileUpdate(updatedProfile);
    toast.success(isPrivate ? 'أصبح الحساب خاصاً' : 'أصبح الحساب عاماً');
    setPrivacySaving(false);
  };

  if (!person) return <div className="status-box">جاري تحميل البروفايل...</div>;

  return (
    <section className="new-view space-y-4 max-w-lg mx-auto">
      <div className="profile-banner card flex items-start gap-5 p-4 border border-zinc-800 rounded-2xl bg-zinc-900/80">
        <button
          type="button"
          disabled={!hasActiveStories}
          aria-label={hasActiveStories ? 'عرض قصص الحساب' : `صورة ${displayName(person)}`}
          onClick={() => {
            if (!hasActiveStories) return;
            onOpenStories(activeUserId);
            setLocation('/feed');
          }}
          className="shrink-0 rounded-full disabled:cursor-default"
        >
          <span
            className="flex h-[72px] w-[72px] items-center justify-center rounded-full p-[3px]"
            style={{
              background: hasActiveStories
                ? hasCloseFriendsStory
                  ? 'conic-gradient(from 0deg, #16a34a, #4ade80, #15803d, #16a34a)'
                  : 'conic-gradient(from 0deg, #CE1126, #FFFFFF, #000000, #007A3D, #CE1126)'
                : 'transparent',
            }}
          >
            <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-zinc-900">
              <Avatar profile={person} extraLarge />
            </span>
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <UserIdentity
            name={displayName(person)}
            username={person.username}
            className="w-full"
            nameClassName="text-sm font-bold text-white"
            usernameClassName="text-xs text-zinc-400"
          />

          <div className="mt-3 flex w-full items-center justify-between text-center text-xs text-zinc-300">
            <div className="flex flex-col items-center">
              <b className="text-white">{postCount}</b>
              <span>منشور</span>
            </div>
            <div className="flex flex-col items-center">
              <b className="text-white">{followers}</b>
              <span>متابِع</span>
            </div>
            <div className="flex flex-col items-center">
              <b className="text-white">{following}</b>
              <span>يتابع</span>
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-400">{person.bio || 'لا توجد نبذة شخصية'}</p>

          {own && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black/30 px-3 py-2">
              <div>
                <span className="block text-[11px] font-bold text-white">خصوصية الحساب</span>
                <span className="text-[10px] text-zinc-400">{person.is_private ? 'خاص — القصص للمتابعين المقبولين' : 'عام — القصص متاحة من الملف الشخصي'}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(person.is_private)}
                onClick={() => void toggleAccountPrivacy()}
                disabled={privacySaving}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${person.is_private ? 'bg-pink-600' : 'bg-zinc-700'} disabled:opacity-50`}
              >
                <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${person.is_private ? 'right-1' : 'right-6'}`} />
              </button>
            </div>
          )}

          {!own && (
            <div className="flex gap-2 mt-2">
              <button
                className={`action-button text-xs px-4 py-1.5 rounded-xl font-bold ${isFollowing || followRequestSent ? 'bg-zinc-800 text-zinc-300' : 'bg-pink-600 text-white'}`}
                onClick={() => void toggleFollow()}
              >
                {isFollowing ? 'إلغاء المتابعة' : followRequestSent ? 'إلغاء طلب المتابعة' : person.is_private ? 'طلب متابعة' : 'متابعة'}
              </button>
              <Link href={`/messages/${activeUserId}`} className="action-button text-xs px-4 py-1.5 rounded-xl bg-zinc-800 text-white font-medium">رسالة</Link>
            </div>
          )}
        </div>
      </div>

      {own && followRequests.length > 0 && (
        <section className="card space-y-2 border border-zinc-800 p-3">
          <h2 className="text-xs font-bold text-white">طلبات المتابعة ({followRequests.length})</h2>
          {followRequests.map(request => (
            <div key={request.profile.id} className="flex items-center gap-4 rounded-xl bg-black/20 p-2">
              <Avatar profile={request.profile} />
              <UserIdentity
                name={displayName(request.profile)}
                username={request.profile.username}
                className="min-w-0 flex-1"
                nameClassName="text-[11px] text-white"
                usernameClassName="text-[10px] text-zinc-400"
              />
              <button
                type="button"
                disabled={Boolean(busyRequestId)}
                onClick={() => void respondToFollowRequest(request.profile.id, true)}
                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-50"
              >قبول</button>
              <button
                type="button"
                disabled={Boolean(busyRequestId)}
                onClick={() => void respondToFollowRequest(request.profile.id, false)}
                className="rounded-lg bg-zinc-800 px-2.5 py-1 text-[10px] font-bold text-zinc-300 disabled:opacity-50"
              >رفض</button>
            </div>
          ))}
        </section>
      )}

      <h2 className="section-label my-2 text-sm font-bold text-white">منشورات وريلز المستخدم</h2>
      {loading && <div className="status-box">جاري تحميل المنشورات...</div>}
      {!loading && error && (
        <div role="alert" className="empty-state card space-y-3 p-6 text-center text-zinc-300 text-xs">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()} className="rounded-full bg-pink-600 px-4 py-2 font-semibold text-white">
            إعادة المحاولة
          </button>
        </div>
      )}
      {!loading && !error && posts.length === 0 && <div className="empty-state card text-center p-6 text-zinc-400 text-xs">لا يوجد محتوى منشور حالياً لهذا المستخدم</div>}

      {!loading && posts.length > 0 && (
        <div className="posts-list space-y-3">
          {posts.map(post => (
            <FeedPostCard key={post.id} post={post} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />
          ))}
        </div>
      )}
    </section>
  );
}
