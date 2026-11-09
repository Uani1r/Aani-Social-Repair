import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import FeedPostCard from '@/components/FeedPostCard';
import HighlightCoverCropper from '@/components/HighlightCoverCropper';
import UserIdentity from '@/components/UserIdentity';
import { usePosts } from '@/hooks/usePosts';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import ProfileHighlightsManager, { ProfileHighlightViewer, type ProfileHighlight, type ProfileHighlightCollection, type ProfileHighlightCollectionSummary } from '@/components/ProfileHighlightsManager';
import { cleanUsername, displayName, type Profile } from '@/lib/types';
import './ProfilePage.css';

type ProfileImageKind = 'avatar' | 'cover';
type CoverPosition = { x: number; y: number };
type CoverPanGesture = {
  pointerId: number;
  startPoint: CoverPosition;
  startPosition: CoverPosition;
  overflowX: number;
  overflowY: number;
};

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
    <div className="mt-4 flex items-center justify-around border-b border-[#2F3336]" aria-label="تبويبات الملف الشخصي">
      <button type="button" aria-label="المنشورات" aria-current="page" className="relative flex flex-1 flex-col items-center justify-center pb-3 pt-3">
        <svg className="h-[26px] w-[26px] text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
        </svg>
        <span className="absolute bottom-0 h-[3px] w-12 rounded-t-sm bg-[#1D9BF0]" />
      </button>
      <button type="button" aria-label="الفيديو" className="relative flex flex-1 flex-col items-center justify-center pb-3 pt-3">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 8l6 4-6 4V8z" />
        </svg>
      </button>
      <button type="button" aria-label="إعادات النشر" className="relative flex flex-1 flex-col items-center justify-center pb-3 pt-3">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
      <button type="button" aria-label="الوسائط" className="relative flex flex-1 flex-col items-center justify-center pb-3 pt-3">
        <svg className="h-[26px] w-[26px] text-[#71767B]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
        </svg>
      </button>
    </div>
  );
}

function normalizeWebsiteUrl(value?: string | null): string | null {
  const website = value?.trim();
  if (!website) return null;

  try {
    const parsed = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export default function ProfilePage({
  targetUserId,
  currentUserId,
  profile,
  onProfileUpdate,
  onOpenComments,
}: {
  targetUserId: string;
  currentUserId: string;
  profile: Profile | null;
  onProfileUpdate: (next: Profile) => void;
  onOpenComments: (postId: string) => void;
}) {
  const activeUserId = targetUserId || currentUserId;
  const own = activeUserId === currentUserId;

  const [person, setPerson] = useState<Profile | null>(own ? profile : null);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [postCount, setPostCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [showFollowCheckmark, setShowFollowCheckmark] = useState(false);
  const [followRequestSent, setFollowRequestSent] = useState(false);
  const followCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followActionPendingRef = useRef(false);
  const [followRequests, setFollowRequests] = useState<Array<{ profile: Profile; created_at: string }>>([]);
  const [profileHighlights, setProfileHighlights] = useState<ProfileHighlightCollection[]>([]);
  const [showHighlightsManager, setShowHighlightsManager] = useState(false);
  const [selectedHighlightCollection, setSelectedHighlightCollection] = useState<ProfileHighlightCollection | null>(null);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(person?.avatar_url || null);
  const [coverPreview, setCoverPreview] = useState<string | null>(person?.cover_url || null);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  const [coverPosition, setCoverPosition] = useState<CoverPosition>({ x: person?.cover_position_x ?? 50, y: person?.cover_position_y ?? 50 });
  const [bioDraft, setBioDraft] = useState(person?.bio || '');
  const [bioEditorOpen, setBioEditorOpen] = useState(false);
  const usernameWrapperRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverImageRef = useRef<HTMLImageElement>(null);
  const coverPanGestureRef = useRef<CoverPanGesture | null>(null);
  const temporaryPreviewUrlsRef = useRef(new Set<string>());
  const [, setLocation] = useLocation();

  const fromSearch = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'search';
  const { posts, loading, refresh, error } = usePosts('profile', activeUserId, currentUserId);
  const username = cleanUsername(person?.username);
  const profileLocation = person?.location?.trim() || '';
  const profileWebsiteUrl = normalizeWebsiteUrl(person?.website);
  const followButtonLabel = isFollowing ? 'أتابع' : followRequestSent ? 'إلغاء طلب المتابعة' : person?.is_private ? 'طلب متابعة' : 'متابعة';

  useEffect(() => {
    if (own && profile) setPerson(profile);
  }, [own, profile]);

  useEffect(() => {
    setAvatarPreview(person?.avatar_url || null);
    setCoverPreview(person?.cover_url || null);
  }, [person?.avatar_url, person?.cover_url]);

  useEffect(() => {
    setCoverPosition({ x: person?.cover_position_x ?? 50, y: person?.cover_position_y ?? 50 });
  }, [person?.id, person?.cover_position_x, person?.cover_position_y]);

  useEffect(() => {
    setBioDraft(person?.bio || '');
  }, [person?.id, person?.bio]);

  useEffect(() => {
    setShowFollowCheckmark(false);
    if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
    followCheckTimerRef.current = null;
  }, [activeUserId]);

  useEffect(() => () => {
    temporaryPreviewUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    temporaryPreviewUrlsRef.current.clear();
    if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
  }, []);

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
      const [{ data: prof }, { count: fCount }, { count: fingCount }, { count: pCount }, { data: checkFollow }, { data: checkRequest }, { data: collectionRows, error: collectionsError }, { data: highlightRows, error: highlightsError }, { data: incomingRequests }] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', activeUserId).maybeSingle(),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', activeUserId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', activeUserId),
        supabase.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', activeUserId),
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', currentUserId).eq('following_id', activeUserId).maybeSingle(),
        own ? Promise.resolve({ data: null }) : supabase.from('follow_requests').select('requester_id').eq('requester_id', currentUserId).eq('recipient_id', activeUserId).maybeSingle(),
        supabase.from('profile_highlight_collections').select('id, user_id, title, cover_url, created_at').eq('user_id', activeUserId).order('created_at', { ascending: true }).limit(100),
        supabase.from('profile_highlights').select('id, user_id, collection_id, position, media_url, media_type, caption, source_story_id, is_close_friends, duration_seconds, created_at').eq('user_id', activeUserId).order('position', { ascending: true }).order('created_at', { ascending: true }).limit(500),
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
      if (collectionsError) {
        console.error('[profile highlights] تعذر تحميل المجموعات:', collectionsError);
        toast.error(`تعذر تحميل مجموعات القصص: ${collectionsError.message}`);
      }
      if (highlightsError) {
        console.error('[profile highlights] تعذر تحميل قصص أبرز القصص:', highlightsError);
        toast.error(`تعذر تحميل قصص أبرز القصص: ${highlightsError.message}`);
      }

      if (prof) setPerson(prof as Profile);
      setFollowers(fCount || 0);
      setFollowing(fingCount || 0);
      setPostCount(pCount || 0);
      setIsFollowing(Boolean(checkFollow));
      setFollowRequestSent(Boolean(checkRequest));
      const storiesByCollection = new Map<string, ProfileHighlight[]>();
      ((highlightRows || []) as ProfileHighlight[]).forEach(story => {
        const stories = storiesByCollection.get(story.collection_id) || [];
        stories.push(story);
        storiesByCollection.set(story.collection_id, stories);
      });
      const collectionData = (collectionRows || []) as ProfileHighlightCollectionSummary[];
      setProfileHighlights(collectionData
        .map(collection => ({ ...collection, stories: storiesByCollection.get(collection.id) || [] }))
        .filter(collection => collection.stories.length > 0));
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
    if (!supabaseConfigured || own || !person || followActionPendingRef.current) return;
    followActionPendingRef.current = true;

    try {
      if (isFollowing) {
        const { error } = await supabase.from('follows').delete().eq('follower_id', currentUserId).eq('following_id', activeUserId);
        if (error) {
          toast.error('تعذرت إزالة المتابعة');
          return;
        }
        setFollowers(prev => Math.max(0, prev - 1));
        setIsFollowing(false);
        setShowFollowCheckmark(false);
        if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
        followCheckTimerRef.current = null;
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

      setIsFollowing(true);
      setShowFollowCheckmark(true);
      if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
      followCheckTimerRef.current = setTimeout(() => {
        setShowFollowCheckmark(false);
        followCheckTimerRef.current = null;
      }, 1500);

      const { error } = await supabase.from('follows').insert({ follower_id: currentUserId, following_id: activeUserId });
      if (error && error.code !== '23505') {
        setIsFollowing(false);
        setShowFollowCheckmark(false);
        if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
        followCheckTimerRef.current = null;
        toast.error('تعذرت متابعة هذا الحساب');
        return;
      }
      setFollowers(prev => prev + (error ? 0 : 1));
    } finally {
      followActionPendingRef.current = false;
    }
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

  const setImagePreview = (kind: ProfileImageKind, url: string | null) => {
    const previousUrl = kind === 'avatar' ? avatarPreview : coverPreview;
    if (previousUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(previousUrl);
      temporaryPreviewUrlsRef.current.delete(previousUrl);
    }
    if (url?.startsWith('blob:')) temporaryPreviewUrlsRef.current.add(url);
    if (kind === 'avatar') setAvatarPreview(url);
    else setCoverPreview(url);
  };

  const handleProfileImageSelection = (kind: ProfileImageKind, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !own || !isEditingProfile || profileSaving) return;
    if (!file.type.startsWith('image/')) {
      toast.error('اختر ملف صورة صالحاً.');
      return;
    }

    if (kind === 'avatar') {
      setAvatarCropFile(file);
      return;
    }

    setPendingCoverFile(file);
    setImagePreview('cover', URL.createObjectURL(file));
    setCoverPosition({ x: 50, y: 50 });
  };

  const handleCoverPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isEditingProfile || !coverPreview || (event.target instanceof Element && event.target.closest('button'))) return;
    const image = coverImageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = Math.max(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    coverPanGestureRef.current = {
      pointerId: event.pointerId,
      startPoint: { x: event.clientX, y: event.clientY },
      startPosition: coverPosition,
      overflowX: Math.max(0, image.naturalWidth * scale - bounds.width),
      overflowY: Math.max(0, image.naturalHeight * scale - bounds.height),
    };
  };

  const handleCoverPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = coverPanGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    setCoverPosition({
      x: gesture.overflowX > 0
        ? Math.max(0, Math.min(100, gesture.startPosition.x - ((event.clientX - gesture.startPoint.x) / gesture.overflowX) * 100))
        : gesture.startPosition.x,
      y: gesture.overflowY > 0
        ? Math.max(0, Math.min(100, gesture.startPosition.y - ((event.clientY - gesture.startPoint.y) / gesture.overflowY) * 100))
        : gesture.startPosition.y,
    });
  };

  const handleCoverPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (coverPanGestureRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    coverPanGestureRef.current = null;
  };

  const saveProfileEdits = async () => {
    if (!own || !person || !isEditingProfile || profileSaving) return;
    if (!supabaseConfigured) {
      toast.error('اتصال قاعدة البيانات غير متاح.');
      return;
    }

    setProfileSaving(true);
    const uploadedPaths: string[] = [];
    const patch: Partial<Profile> = {
      bio: bioDraft,
      cover_position_x: coverPosition.x,
      cover_position_y: coverPosition.y,
    };

    try {
      const uploadPendingImage = async (kind: ProfileImageKind, file: File) => {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'profile-image';
        const path = `${currentUserId}/profile/${kind}-${Date.now()}-${safeName}`;
        await uploadMedia({ file, path });
        uploadedPaths.push(path);
        const publicUrl = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
        if (kind === 'avatar') patch.avatar_url = publicUrl;
        else patch.cover_url = publicUrl;
      };

      if (pendingAvatarFile) await uploadPendingImage('avatar', pendingAvatarFile);
      if (pendingCoverFile) await uploadPendingImage('cover', pendingCoverFile);

      let savedPatch = patch;
      let { error } = await supabase.from('profiles').update(savedPatch).eq('id', activeUserId);
      let coverPositionSaved = true;
      if (error && (error.code === 'PGRST204' || error.code === '42703') && /cover_position_[xy]/i.test(error.message)) {
        const fallbackPatch = { ...patch };
        delete fallbackPatch.cover_position_x;
        delete fallbackPatch.cover_position_y;
        const retry = await supabase.from('profiles').update(fallbackPatch).eq('id', activeUserId);
        error = retry.error;
        if (!error) {
          savedPatch = fallbackPatch;
          coverPositionSaved = false;
        }
      }
      if (error) throw error;

      const updatedProfile = { ...person, ...savedPatch };
      setPerson(updatedProfile);
      onProfileUpdate(updatedProfile);
      setImagePreview('avatar', updatedProfile.avatar_url || null);
      setImagePreview('cover', updatedProfile.cover_url || null);
      setPendingAvatarFile(null);
      setPendingCoverFile(null);
      setAvatarCropFile(null);
      setBioEditorOpen(false);
      setIsEditingProfile(false);
      setShowProfileMenu(false);
      uploadedPaths.length = 0;
      if (coverPositionSaved) {
        toast.success('تم حفظ تعديلات الملف الشخصي.');
      } else {
        toast.info('تم حفظ بقية التعديلات، لكن موضع الغلاف لم يُحفظ لعدم توفر أعمدته في قاعدة البيانات.');
      }
    } catch (error) {
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage.from(storageBucket).remove(uploadedPaths);
        if (cleanupError) console.warn('[profile] تعذر حذف الصور غير المحفوظة:', cleanupError);
      }
      console.error('[profile] تعذر حفظ تعديلات الملف الشخصي:', error);
      toast.error('تعذر حفظ تعديلات الملف الشخصي. حاول مرة أخرى.');
    } finally {
      setProfileSaving(false);
    }
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
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" aria-label="اختيار صورة الغلاف" disabled={!isEditingProfile || profileSaving} onChange={event => handleProfileImageSelection('cover', event)} />
      <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" aria-label="اختيار الصورة الشخصية" disabled={!isEditingProfile || profileSaving} onChange={event => handleProfileImageSelection('avatar', event)} />

      <div className="profile-header-container">
        <div className="notch-safe-area" />
        <div className="relative z-30 flex items-center justify-end bg-black/40 px-4 py-2 backdrop-blur-md">
          <button
            type="button"
            aria-label={isEditingProfile ? 'حفظ تعديلات الملف الشخصي' : 'المزيد من خيارات الملف الشخصي'}
            aria-expanded={!isEditingProfile && showProfileMenu}
            onClick={() => isEditingProfile ? void saveProfileEdits() : setShowProfileMenu(open => !open)}
            disabled={profileSaving}
            className={`flex h-9 items-center justify-center rounded-full transition disabled:opacity-60 ${isEditingProfile ? 'min-w-12 bg-white px-4 py-1.5 text-sm font-bold text-black shadow-sm hover:bg-neutral-200' : 'w-9 bg-black/50 text-white hover:bg-black/70'}`}
          >
            {isEditingProfile ? profileSaving ? 'جارٍ الحفظ...' : 'تم' : (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="5" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="12" cy="19" r="1.75" />
              </svg>
            )}
          </button>
          {!isEditingProfile && showProfileMenu && (
            <div role="menu" className="absolute left-4 top-full z-[60] max-h-[70dvh] w-[min(340px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-[#2F3336] bg-[#111] p-3 text-white shadow-xl">
              {own ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBioDraft(person.bio || '');
                      setBioEditorOpen(false);
                      setCoverPosition({ x: person.cover_position_x ?? 50, y: person.cover_position_y ?? 50 });
                      setIsEditingProfile(true);
                      setShowProfileMenu(false);
                    }}
                    className="w-full border-b border-[#2F3336] py-3 text-right text-sm font-bold hover:text-[#1D9BF0]"
                  >تعديل الملف الشخصي</button>
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
        {username && <div className="username-text absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none" data-username={username}>{username}</div>}
      </div>

      <div
        className={`relative h-[135px] w-full overflow-hidden bg-[#18181b] ${isEditingProfile && coverPreview ? 'cursor-grab touch-none active:cursor-grabbing' : ''}`}
        onPointerDown={handleCoverPointerDown}
        onPointerMove={handleCoverPointerMove}
        onPointerUp={handleCoverPointerEnd}
        onPointerCancel={handleCoverPointerEnd}
        style={{ touchAction: isEditingProfile ? 'none' : 'auto' }}
      >
        {coverPreview && (
          <img
            ref={coverImageRef}
            src={coverPreview}
            className="h-full w-full select-none object-cover"
            style={{ objectPosition: `${coverPosition.x}% ${coverPosition.y}%` }}
            alt=""
            draggable={false}
          />
        )}
        {isEditingProfile && (
          <>
            <button
              type="button"
              disabled={profileSaving}
              aria-label={coverPreview ? 'اختيار صورة غلاف جديدة' : 'إضافة صورة غلاف'}
              onClick={() => coverInputRef.current?.click()}
              className="absolute left-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 p-2 text-white backdrop-blur-md transition hover:bg-black/60 disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
            {coverPreview && <span className="pointer-events-none absolute bottom-2 right-3 rounded-full bg-black/40 px-3 py-1 text-xs text-white/90 backdrop-blur-sm">اسحب لضبط موضع الغلاف</span>}
          </>
        )}
      </div>

      <div className="relative z-20 flex items-end justify-between px-4 pb-2">
        <div className="relative flex items-end gap-3">
          <div className="relative -mt-11 h-[82px] w-[82px] shrink-0 rounded-full">
            <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-black bg-neutral-800 p-[3px] ring-2 ring-black">
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                {avatarPreview ? (
                  <img src={avatarPreview} className="h-full w-full rounded-full object-cover" alt="" />
                ) : (
                  <svg className="h-8 w-8 text-neutral-400" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                )}
              </span>
            </span>
            {isEditingProfile && (
              <button
                type="button"
                disabled={profileSaving}
                aria-label={avatarPreview ? 'تغيير الصورة الشخصية' : 'إضافة صورة شخصية'}
                onClick={() => avatarInputRef.current?.click()}
                className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm disabled:cursor-default disabled:opacity-50"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0118.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 pb-2">
            <h1 className="text-xl font-black text-white">{displayName(person)}</h1>
            <VerifiedBadge />
          </div>
        </div>
      </div>

      <div className="mt-3 px-4">
        <div className="mb-4 flex items-center justify-between">
          {!own && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void toggleFollow()}
                aria-label={isFollowing ? 'إلغاء المتابعة' : followRequestSent ? 'إلغاء طلب المتابعة' : person.is_private ? 'طلب متابعة' : 'متابعة'}
                className={`relative inline-flex h-9 min-w-[85px] shrink-0 items-center whitespace-nowrap rounded-full px-4 text-[13px] font-semibold transition ${followRequestSent ? 'bg-zinc-800 text-white' : 'bg-white text-black hover:bg-neutral-200'}`}
              >
                <span className="invisible inline-flex items-center gap-1.5" aria-hidden="true">
                  <span>{followButtonLabel}</span>
                  {isFollowing && <span className="h-3.5 w-3.5 shrink-0" />}
                </span>
                <span className="absolute inset-0 flex items-center justify-center text-center">{followButtonLabel}</span>
                {isFollowing && (
                  <span className="absolute left-2 top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center" aria-hidden="true">
                    <svg className={`profile-follow-check${showFollowCheckmark ? ' is-visible' : ''}`} viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M3 10.5 7.4 15 17 5.5" fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} />
                    </svg>
                  </span>
                )}
              </button>
              <Link href={`/messages/${activeUserId}`} aria-label="إرسال رسالة" className="flex h-9 w-9 items-center justify-center rounded-full border border-[#53575B] text-white transition hover:bg-white/10">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </Link>
            </div>
          )}
          <div className="flex items-center gap-3 text-sm">
            <div><span className="font-bold text-white">{formattedFollowing}</span> <span className="text-[#71767B]">متابَع</span></div>
            <div><span className="font-bold text-white">{formattedFollowers}</span> <span className="text-[#71767B]">المتابعون</span></div>
          </div>
        </div>

        <div id="bioSection" className="mb-3 mt-2">
          {bioEditorOpen && isEditingProfile ? (
            <div className="flex flex-col gap-2">
              <textarea
                rows={2}
                value={bioDraft}
                onChange={event => setBioDraft(event.currentTarget.value)}
                autoFocus
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 p-2 text-sm text-white focus:border-[#1D9BF0] focus:outline-none"
                placeholder="اكتب سيرتك الذاتية هنا..."
                aria-label="السيرة الذاتية"
              />
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => { setBioDraft(person.bio || ''); setBioEditorOpen(false); }} className="px-3 py-1 text-xs text-neutral-400">إلغاء</button>
                <span className="text-[10px] text-white/45">اضغط «تم» لحفظ التعديلات</span>
              </div>
            </div>
          ) : (
            <>
              {isEditingProfile && (
                <button
                  type="button"
                  onClick={() => setBioEditorOpen(true)}
                  className="mb-2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/90 backdrop-blur-sm transition hover:bg-white/15"
                >تعديل السيرة</button>
              )}
              {person.bio?.trim() && <p id="bioText" className="whitespace-pre-line text-[15px] leading-relaxed text-[#F7F9F9]">{person.bio}</p>}
            </>
          )}
        </div>

        {(profileLocation || profileWebsiteUrl) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-[#71767B]">
            {profileLocation && (
              <span className="flex items-center gap-1">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                {profileLocation}
              </span>
            )}
            {profileWebsiteUrl && (
              <a href={profileWebsiteUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#1D9BF0] hover:underline">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                {person.website?.trim()}
              </a>
            )}
          </div>
        )}
      </div>

      {(own || profileHighlights.length > 0) && (
        <div className="mb-2 mt-6 px-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#F7F9F9]">أبرز القصص</h2>
          </div>
          <div className="no-scrollbar flex items-center gap-4 overflow-x-auto pb-2">
            {own && (
              <button id="openModalBtn" type="button" onClick={() => setShowHighlightsManager(true)} className="flex shrink-0 cursor-pointer flex-col items-center gap-1.5" aria-label="إضافة إلى أبرز القصص">
                <span className="flex h-[68px] w-[68px] items-center justify-center rounded-full border border-dashed border-[#71767B] bg-[#111] text-[#1D9BF0] transition hover:border-[#1D9BF0] hover:bg-[#1D9BF0]/10">
                  <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                </span>
                <span className="max-w-[72px] truncate text-[11px] text-[#BBBBBB]">إضافة</span>
              </button>
            )}
            {profileHighlights.map(collection => {
              const cover = collection.stories[0];
              return (
                <button key={collection.id} type="button" onClick={() => setSelectedHighlightCollection(collection)} className="flex shrink-0 cursor-pointer flex-col items-center gap-1.5" aria-label={`عرض مجموعة ${collection.title}`}>
                  <span className="flex h-[68px] w-[68px] rounded-full border border-[#4B4B50] p-[3px]">
                    <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                      {collection.cover_url ? (
                        <img src={collection.cover_url} className="h-full w-full object-cover" alt="" />
                      ) : cover?.media_url && cover.media_type === 'video' ? (
                        <video src={cover.media_url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                      ) : cover?.media_url ? (
                        <img src={cover.media_url} className="h-full w-full object-cover" alt="" />
                      ) : (
                        <span className="line-clamp-3 px-1 text-center text-[9px] text-white">{cover?.caption || collection.title}</span>
                      )}
                    </span>
                  </span>
                  <span className="max-w-[88px] truncate text-[11px] text-[#BBBBBB]">{collection.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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
      <ProfileHighlightsManager
        open={showHighlightsManager}
        onClose={() => setShowHighlightsManager(false)}
        userId={currentUserId}
        ownerName={person ? displayName(person) : 'محمد'}
        ownerAvatarUrl={person?.avatar_url || null}
        collections={profileHighlights}
        existingSourceStoryIds={new Set(profileHighlights.flatMap(collection => collection.stories.flatMap(story => story.source_story_id ? [story.source_story_id] : [])))}
        onHighlightAdded={(collection, highlight) => setProfileHighlights(current => {
          const existing = current.some(item => item.id === collection.id);
          if (existing) {
            return current.map(item => item.id === collection.id
              ? { ...item, ...collection, stories: [...item.stories, highlight].sort((a, b) => a.position - b.position) }
              : item);
          }
          return [...current, { ...collection, stories: [highlight] }].sort((a, b) => a.created_at.localeCompare(b.created_at));
        })}
      />
      {avatarCropFile && (
        <HighlightCoverCropper
          file={avatarCropFile}
          title="اقتصاص الصورة الشخصية"
          outputSuffix="-avatar"
          onCancel={() => setAvatarCropFile(null)}
          onSave={file => {
            setPendingAvatarFile(file);
            setImagePreview('avatar', URL.createObjectURL(file));
            setAvatarCropFile(null);
          }}
        />
      )}
      {selectedHighlightCollection && (
        <ProfileHighlightViewer
          collection={selectedHighlightCollection}
          collections={profileHighlights}
          onClose={() => setSelectedHighlightCollection(null)}
          onCollectionUpdated={(collectionId, updates) => {
            setProfileHighlights(current => current.map(item => item.id === collectionId ? { ...item, ...updates } : item));
            setSelectedHighlightCollection(current => current?.id === collectionId ? { ...current, ...updates } : current);
          }}
          onCollectionDeleted={collectionId => {
            setProfileHighlights(current => current.filter(item => item.id !== collectionId));
            setSelectedHighlightCollection(current => current?.id === collectionId ? null : current);
          }}
          onHighlightDeleted={(collectionId, highlightId) => {
            const removeHighlight = (collection: ProfileHighlightCollection) => collection.id === collectionId
              ? { ...collection, stories: collection.stories.filter(item => item.id !== highlightId) }
              : collection;
            setProfileHighlights(current => current.map(removeHighlight).filter(item => item.stories.length > 0));
            setSelectedHighlightCollection(current => current?.id === collectionId ? removeHighlight(current) : current);
          }}
          currentUserId={currentUserId}
          ownerName={person ? displayName(person) : 'محمد'}
          ownerAvatarUrl={person?.avatar_url || null}
        />
      )}
    </section>
  );
}
