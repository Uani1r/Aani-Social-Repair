import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import FeedPostCard from '@/components/FeedPostCard';
import UserIdentity from '@/components/UserIdentity';
import { usePosts } from '@/hooks/usePosts';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { cleanUsername, displayName, type Profile } from '@/lib/types';
import './ProfilePage.css';

const COVER_IMAGE = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe';
const FALLBACK_AVATAR = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb';
const PROFILE_BIO = 'المحطة القادمة: كل مكان 🌍 | احصل على شريحة واحدة وابقَ متصلاً في أكثر من 200 وجهة.';

const HIGHLIGHTS = [
  { label: 'صور', image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d' },
  { label: 'رحلات', image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330' },
  { label: 'عمل', image: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e' },
];

function VerifiedBadge() {
  return (
    <svg className="h-5 w-5 shrink-0 text-[#1D9BF0]" viewBox="0 0 24 24" aria-label="حساب موثّق" role="img">
      <path fill="currentColor" d="M12 1.6 15.1 3l3.3-.3 1.1 3.1 2.7 1.8-.9 3.2.9 3.2-2.7 1.8-1.1 3.1-3.3-.3-3.1 1.4-3.1-1.4-3.3.3-1.1-3.1-2.7-1.8.9-3.2-.9-3.2 2.7-1.8 1.1-3.1 3.3.3L12 1.6Z" />
      <path d="m7.3 12.2 3 3 6.5-6.5" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function ProfileTabs() {
  return (
    <div className="flex items-center justify-around border-b border-[#2F3336] mt-4" aria-label="تبويبات الملف الشخصي">
      <button type="button" aria-label="المنشورات" aria-current="page" className="flex flex-1 flex-col items-center justify-center pb-3 pt-3 relative">
        <svg className="h-[26px] w-[26px] text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
        </svg>
        <span className="absolute bottom-0 h-[3px] w-12 rounded-t-sm bg-[#1D9BF0]" />
      </button>
      <button type="button" aria-label="الفيديو" className="flex flex-1 flex-col items-center justify-center pb-3 pt-3 relative">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 8l6 4-6 4V8z" />
        </svg>
      </button>
      <button type="button" aria-label="إعادات النشر" className="flex flex-1 flex-col items-center justify-center pb-3 pt-3 relative">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
      <button type="button" aria-label="الوسائط" className="flex flex-1 flex-col items-center justify-center pb-3 pt-3 relative">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
        </svg>
      </button>
    </div>
  );
}

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
  const [hasUnseenActiveStories, setHasUnseenActiveStories] = useState(false);
  const [hasCloseFriendsStory, setHasCloseFriendsStory] = useState(false);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const usernameWrapperRef = useRef<HTMLDivElement>(null);
  const [, setLocation] = useLocation();

  const fromSearch = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'search';
  const { posts, loading, refresh, error } = usePosts('profile', activeUserId, currentUserId);
  const username = cleanUsername(person?.username) || 'Sufi495';

  useEffect(() => {
    if (own && profile) setPerson(profile);
  }, [own, profile]);

  useEffect(() => {
    const usernameWrapper = usernameWrapperRef.current;
    if (!usernameWrapper) return;

    const updateUsernameScrollState = () => {
      if (window.scrollY > 90) {
        usernameWrapper.classList.add('scrolled');
      } else {
        usernameWrapper.classList.remove('scrolled');
      }
    };

    window.addEventListener('scroll', updateUsernameScrollState, { passive: true });
    updateUsernameScrollState();
    return () => window.removeEventListener('scroll', updateUsernameScrollState);
  }, [person]);

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
        ? await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url, bio, is_private').in('id', requesterIds)
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
      const activeStoryIds = ((activeStories || []) as Array<{ id: string }>).map(story => story.id);
      let seenStoryIds = new Set<string>();
      try {
        const rawSeenStoryIds = localStorage.getItem(`aani:seen-story-ids:${currentUserId}`);
        const parsedSeenStoryIds: unknown = rawSeenStoryIds ? JSON.parse(rawSeenStoryIds) : [];
        if (Array.isArray(parsedSeenStoryIds)) seenStoryIds = new Set(parsedSeenStoryIds.filter((id): id is string => typeof id === 'string'));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      setHasActiveStories(activeStoryIds.length > 0);
      setHasUnseenActiveStories(activeStoryIds.some(storyId => !seenStoryIds.has(storyId)));
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

  if (!person) {
    return (
      <section className="profile-screen mx-auto w-full max-w-[600px] bg-black text-white" dir="rtl">
        {fromSearch && (
          <div className="flex justify-start px-2 pt-2">
            <button type="button" aria-label="العودة إلى البحث" onClick={() => setLocation('/search')} className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-zinc-800">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 18l-6-6 6-6" /></svg>
            </button>
          </div>
        )}
        <div className="status-box mx-4 mt-4">جاري تحميل البروفايل...</div>
      </section>
    );
  }

  const formattedFollowers = followers.toLocaleString('en-US');
  const formattedFollowing = following.toLocaleString('en-US');

  return (
    <section className="profile-screen relative mx-auto min-h-[150vh] w-full max-w-[600px] select-none bg-black text-white" dir="rtl">
      <div className="profile-header-container">
        <div className="notch-safe-area" />
        <div className="relative z-30 flex items-center justify-end px-4 py-2 bg-black/40 backdrop-blur-md">
          <button
            type="button"
            aria-label="المزيد من خيارات الملف الشخصي"
            aria-expanded={showProfileMenu}
            onClick={() => setShowProfileMenu(open => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
            </svg>
          </button>
          {showProfileMenu && (
            <div role="menu" className="absolute left-4 top-full z-[60] max-h-[70dvh] w-[min(340px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-[#2F3336] bg-[#111] p-3 text-white shadow-xl">
              {own ? (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-[#2F3336] pb-3">
                    <div>
                      <span className="block text-sm font-bold">خصوصية الحساب</span>
                      <span className="text-xs text-[#71767B]">{person.is_private ? 'خاص — القصص للمتابعين المقبولين' : 'عام — القصص متاحة من الملف الشخصي'}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(person.is_private)}
                      aria-label="خصوصية الحساب"
                      onClick={() => void toggleAccountPrivacy()}
                      disabled={privacySaving}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition ${person.is_private ? 'bg-pink-600' : 'bg-zinc-700'} disabled:opacity-50`}
                    >
                      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${person.is_private ? 'right-1' : 'right-6'}`} />
                    </button>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      window.dispatchEvent(new Event('aani:open-profile-settings'));
                      setShowProfileMenu(false);
                    }}
                    className="w-full border-b border-[#2F3336] py-3 text-right text-sm hover:text-[#1D9BF0]"
                  >الإعدادات</button>
                  <div className="pt-3">
                    <h2 className="mb-2 text-xs font-bold">طلبات المتابعة ({followRequests.length})</h2>
                    {followRequests.length === 0 && <p className="text-xs text-[#71767B]">لا توجد طلبات متابعة جديدة.</p>}
                    {followRequests.map(request => (
                      <div key={request.profile.id} className="flex items-center gap-2 border-t border-[#2F3336] py-2">
                        <Avatar profile={request.profile} />
                        <UserIdentity name={displayName(request.profile)} username={request.profile.username} className="min-w-0 flex-1" nameClassName="text-xs text-white" usernameClassName="text-[10px] text-zinc-400" />
                        <button type="button" disabled={Boolean(busyRequestId)} onClick={() => void respondToFollowRequest(request.profile.id, true)} className="rounded-lg bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white disabled:opacity-50">قبول</button>
                        <button type="button" disabled={Boolean(busyRequestId)} onClick={() => void respondToFollowRequest(request.profile.id, false)} className="rounded-lg bg-zinc-800 px-2 py-1 text-[10px] font-bold text-zinc-300 disabled:opacity-50">رفض</button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Link href={`/messages/${activeUserId}`} onClick={() => setShowProfileMenu(false)} role="menuitem" className="block rounded-xl px-3 py-2 text-sm hover:bg-white/10">إرسال رسالة إلى {displayName(person)}</Link>
              )}
            </div>
          )}
        </div>
      </div>

      <div ref={usernameWrapperRef} className="sticky-username-wrapper" id="usernameWrapper">
        <div className="username-text" data-username={username}>{username}</div>
      </div>

      <div className="relative h-[135px] w-full bg-neutral-900">
        <img src={COVER_IMAGE} className="h-full w-full object-cover" alt="غلاف الملف الشخصي" />
      </div>

      <div className="relative z-20 flex items-end justify-between px-4 pb-2">
        <div className="relative flex items-end gap-3">
          <button
            type="button"
            disabled={!hasActiveStories}
            aria-label={hasActiveStories ? 'عرض قصص الحساب' : `صورة ${displayName(person)}`}
            onClick={() => {
              if (!hasActiveStories) return;
              onOpenStories(activeUserId);
              setLocation('/feed');
            }}
            className="relative -mt-11 shrink-0 rounded-full disabled:cursor-default"
          >
            <span
              className="flex h-[82px] w-[82px] items-center justify-center rounded-full border-[3px] border-black bg-black ring-2 ring-black"
              style={{
                background: hasActiveStories
                  ? hasUnseenActiveStories
                    ? hasCloseFriendsStory
                      ? 'conic-gradient(from 0deg, #16a34a, #4ade80, #15803d, #16a34a)'
                      : 'conic-gradient(from 0deg, #CE1126, #FFFFFF, #000000, #007A3D, #CE1126)'
                    : 'conic-gradient(from 0deg, #8e8e93, #d1d1d6, #6e6e73, #8e8e93)'
                  : undefined,
              }}
            >
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                <img src={person.avatar_url || FALLBACK_AVATAR} className="h-full w-full rounded-full object-cover" alt="" />
              </span>
            </span>
          </button>
          <div className="flex items-center gap-1 pb-2">
            <h1 className="text-xl font-black text-white">{displayName(person)}</h1>
            <VerifiedBadge />
          </div>
        </div>
      </div>

      <div className="mt-3 px-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => own ? setShowProfileMenu(true) : void toggleFollow()}
              className={`h-9 rounded-full px-5 text-sm font-bold transition ${isFollowing || followRequestSent ? 'bg-zinc-800 text-white' : 'bg-white text-black hover:bg-neutral-200'}`}
            >
              {isFollowing ? 'إلغاء المتابعة' : followRequestSent ? 'إلغاء طلب المتابعة' : person.is_private && !own ? 'طلب متابعة' : 'متابعة'}
            </button>
            <Link href={`/messages/${activeUserId}`} aria-label="إرسال رسالة" className="flex h-9 w-9 items-center justify-center rounded-full border border-[#53575B] text-white transition hover:bg-white/10">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </Link>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div><span className="font-bold text-white">{formattedFollowing}</span> <span className="text-[#71767B]">متابَع</span></div>
            <div><span className="font-bold text-white">{formattedFollowers}</span> <span className="text-[#71767B]">المتابعون</span></div>
          </div>
        </div>

        <p className="text-[15px] leading-relaxed text-[#F7F9F9]">
          {person.bio || PROFILE_BIO}{' '}
          <span className="text-[#1D9BF0]">#اتصال_بلا_حدود</span>
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-[#71767B]">
          <span className="flex items-center gap-1">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            كركوك
          </span>
          <a href="https://esimio.onelink.me/13Ce/IG" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#1D9BF0] hover:underline">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
            esimio.onelink.me/13Ce/IG
          </a>
          <span className="flex items-center gap-1">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            انضم في شباط 2018
          </span>
        </div>
      </div>

      <div className="mb-2 mt-6 px-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#F7F9F9]">أبرز القصص</h2>
        </div>
        <div className="no-scrollbar flex items-center gap-4 overflow-x-auto pb-2">
          {HIGHLIGHTS.map(story => (
            <button key={story.label} type="button" className="flex shrink-0 cursor-pointer flex-col items-center gap-1.5">
              <span className="flex h-[68px] w-[68px] rounded-full bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 p-[2px]">
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 border-black bg-neutral-800">
                  <img src={story.image} className="h-full w-full object-cover" alt="" />
                </span>
              </span>
              <span className="text-[11px] text-[#BBBBBB]">{story.label}</span>
            </button>
          ))}
        </div>
      </div>

      <ProfileTabs />

      <div className="mt-4 flex flex-col gap-4 p-4">
        {loading && Array.from({ length: 4 }, (_, index) => <div key={`loading-${index}`} className="h-32 w-full rounded-xl bg-neutral-900" />)}
        {!loading && error && (
          <div role="alert" className="rounded-xl border border-[#2F3336] bg-neutral-900 p-5 text-center text-sm text-zinc-300">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()} className="mt-3 rounded-full bg-white px-4 py-2 font-semibold text-black">إعادة المحاولة</button>
          </div>
        )}
        {!loading && !error && posts.length === 0 && Array.from({ length: 4 }, (_, index) => <div key={`empty-${index}`} className="h-32 w-full rounded-xl bg-neutral-900" />)}
        {!loading && !error && posts.length > 0 && (
          <div className="posts-list space-y-3">
            {posts.map(post => (
              <FeedPostCard key={post.id} post={post} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />
            ))}
          </div>
        )}
      </div>
      <span className="sr-only">المنشورات: {postCount}</span>
    </section>
  );
}
