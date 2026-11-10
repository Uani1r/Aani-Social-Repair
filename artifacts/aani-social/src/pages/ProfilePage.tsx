import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Briefcase, Cake, Camera, Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, Flag, MapPin, MessageCircle, Play, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import Avatar from '@/components/Avatar';
import FeedPostCard from '@/components/FeedPostCard';
import ProfileFeedViewer from '@/components/ProfileFeedViewer';
import ProfileReelsPlayer from '@/components/ProfileReelsPlayer';
import { ListSkeleton, ProfileSkeleton, GridSkeleton } from '@/components/Skeletons';
import ProfileStoryArchiveView from '@/components/ProfileStoryArchiveView';
import ProfileSettingsPreferences, { type ProfileSettingsPreferenceScreen } from '@/components/ProfileSettingsPreferences';
import SavedPostsView from '@/components/SavedPostsView';
import HighlightCoverCropper from '@/components/HighlightCoverCropper';
import UserIdentity from '@/components/UserIdentity';
import { usePosts } from '@/hooks/usePosts';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import ProfileHighlightsManager, { ProfileHighlightViewer, type ProfileHighlight, type ProfileHighlightCollection, type ProfileHighlightCollectionSummary } from '@/components/ProfileHighlightsManager';
import { cleanUsername, displayName, getPostCoverUrl, getPostDestination, normalizePostMetadata, type Post, type Profile } from '@/lib/types';
import { fontPreferenceLabel, readLocalFontPreference, resolveFontPreference } from '@/lib/fontPreferences';
import { readLocalBlockedUserIds, readLocalMutedUserIds, writeLocalBlockedUserIds, writeLocalMutedUserIds } from '@/lib/comments/localModeration';
import './ProfilePage.css';
import { firstMediaUrlOfPost, preloadMediaList, thumbnailUrl } from '@/lib/mediaPreload';

type SettingsScreen = 'home' | 'account' | 'password' | 'security' | 'privacy' | 'blocked' | 'muted' | 'subscriptions' | 'billing' | 'archive' | 'saved' | 'support' | 'report' | 'faq' | 'legal' | 'about' | ProfileSettingsPreferenceScreen;
type ProfileReportCategory = 'spam' | 'harassment' | 'hate' | 'fake_account' | 'other';
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

type ProfileContentTab = 'posts' | 'videos' | 'reposts' | 'tagged';

function ProfileTabs({ activeTab, onChange }: {
  activeTab: ProfileContentTab;
  onChange: (tab: ProfileContentTab) => void;
}) {
  const tabs = [
    {
      id: 'posts' as const,
      label: 'المنشورات',
      icon: (active: boolean) => (
        <svg className={`h-[26px] w-[26px] ${active ? 'text-white' : 'text-[#71767B]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1" strokeWidth="1.5" />
        </svg>
      ),
    },
    {
      id: 'videos' as const,
      label: 'الفيديو',
      icon: (active: boolean) => (
        <svg className={`h-[26px] w-[26px] ${active ? 'text-white' : 'text-[#71767B]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 8l6 4-6 4V8z" />
        </svg>
      ),
    },
    {
      id: 'reposts' as const,
      label: 'إعادات النشر',
      icon: (active: boolean) => (
        <svg className={`h-[26px] w-[26px] ${active ? 'text-white' : 'text-[#71767B]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
    },
    {
      id: 'tagged' as const,
      label: 'المنشورات المشار فيها',
      icon: (active: boolean) => (
        <svg className={`h-[26px] w-[26px] ${active ? 'text-white' : 'text-[#71767B]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          <rect x="2" y="2" width="20" height="20" rx="5" strokeWidth="1.5" />
        </svg>
      ),
    },
  ];

  return (
    <div className="mt-4 flex items-center justify-around border-b border-[#2F3336]" aria-label="تبويبات الملف الشخصي">
      {tabs.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          aria-current={activeTab === id ? 'page' : undefined}
          onClick={() => onChange(id)}
          className="relative flex flex-1 flex-col items-center justify-center pb-3 pt-3"
        >
          {icon(activeTab === id)}
          {activeTab === id && <span className="absolute bottom-0 h-[3px] w-12 rounded-t-sm bg-[#1D9BF0]" />}
        </button>
      ))}
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

function formatProfileBirthDate(value?: string | null): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

type ProfileReorderKind = 'highlights' | 'posts';

type ProfileReorderGesture = {
  kind: ProfileReorderKind;
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  timer: number | null;
  active: boolean;
};

function moveProfileItem(ids: string[], fromId: string, toId: string): string[] {
  const fromIndex = ids.indexOf(fromId);
  const toIndex = ids.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return ids;
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function orderOwnedPostsInProfileSlots(posts: Post[], ownerId: string, orderedIds: string[]): Post[] {
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const ownedPosts = posts
    .filter(post => post.user_id === ownerId && !post.reposter_id)
    .sort((first, second) => (order.get(first.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(second.id) ?? Number.MAX_SAFE_INTEGER));
  let ownedIndex = 0;
  return posts.map(post => (
    post.user_id === ownerId && !post.reposter_id
      ? ownedPosts[ownedIndex++] || post
      : post
  ));
}

function isProfileReel(post: Post): boolean {
  return post.type === 'reel' || getPostDestination(post) === 'reels';
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
  const [isFollowing, setIsFollowing] = useState(false);
  const [showFollowCheckmark, setShowFollowCheckmark] = useState(false);
  const [followRequestSent, setFollowRequestSent] = useState(false);
  const followCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followActionPendingRef = useRef(false);
  const [profileHighlights, setProfileHighlights] = useState<ProfileHighlightCollection[]>([]);
  const [showProfileReorder, setShowProfileReorder] = useState(false);
  const [profilePostOrder, setProfilePostOrder] = useState<string[]>([]);
  const [profileReorderSaving, setProfileReorderSaving] = useState(false);
  const [draggingReorderKey, setDraggingReorderKey] = useState<string | null>(null);
  const [dragOverReorderKey, setDragOverReorderKey] = useState<string | null>(null);
  const profileReorderGestureRef = useRef<ProfileReorderGesture | null>(null);
  const [showHighlightsManager, setShowHighlightsManager] = useState(false);
  const [feedViewerPostId, setFeedViewerPostId] = useState<string | null>(null);
  const [feedViewerSource, setFeedViewerSource] = useState<'grid' | 'reposts' | 'tagged'>('grid');
  const [reelsPlayerPostId, setReelsPlayerPostId] = useState<string | null>(null);
  const [profileContentTab, setProfileContentTab] = useState<ProfileContentTab>('posts');
  const [reelsPlayerSource, setReelsPlayerSource] = useState<'grid' | 'videos' | 'reposts' | 'tagged'>('grid');
  const [selectedHighlightCollection, setSelectedHighlightCollection] = useState<ProfileHighlightCollection | null>(null);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [storyHiddenFromTarget, setStoryHiddenFromTarget] = useState(false);
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [showProfileReportDialog, setShowProfileReportDialog] = useState(false);
  const [profileReportCategory, setProfileReportCategory] = useState<ProfileReportCategory>('other');
  const [profileReportDetails, setProfileReportDetails] = useState('');
  const [profileReportSubmitting, setProfileReportSubmitting] = useState(false);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);
  const [settingsOverlayEntered, setSettingsOverlayEntered] = useState(false);
  const [navStack, setNavStack] = useState<string[]>(['main']);
  const settingsScreen = (navStack[navStack.length - 1] === 'main' ? 'home' : navStack[navStack.length - 1]) as SettingsScreen;
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [showDeactivateAccountConfirmation, setShowDeactivateAccountConfirmation] = useState(false);
  const [showDeleteAccountConfirmation, setShowDeleteAccountConfirmation] = useState(false);
  const [deleteAccountConfirmation, setDeleteAccountConfirmation] = useState('');
  const [supportReport, setSupportReport] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPhone, setAuthPhone] = useState('');
  const [authProvider, setAuthProvider] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [accountSettingsBusy, setAccountSettingsBusy] = useState(false);
  const [blockedProfiles, setBlockedProfiles] = useState<Profile[]>([]);
  const [mutedProfiles, setMutedProfiles] = useState<Profile[]>([]);
  const [storyHiddenUserIds, setStoryHiddenUserIds] = useState<Set<string>>(new Set());
  const [managedProfilesLoading, setManagedProfilesLoading] = useState(false);
  const [managedProfileBusyId, setManagedProfileBusyId] = useState<string | null>(null);
  const [currentSessionExpiry, setCurrentSessionExpiry] = useState<number | null>(null);
  const [currentSessionLoading, setCurrentSessionLoading] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(person?.avatar_url || null);
  const [coverPreview, setCoverPreview] = useState<string | null>(person?.cover_url || null);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  const [coverPosition, setCoverPosition] = useState<CoverPosition>({ x: person?.cover_position_x ?? 50, y: person?.cover_position_y ?? 50 });
  const [nameDraft, setNameDraft] = useState(person?.full_name || person?.display_name || '');
  const [usernameDraft, setUsernameDraft] = useState(person?.username || '');
  const [bioDraft, setBioDraft] = useState(person?.bio || '');
  const [cityDraft, setCityDraft] = useState(person?.city || person?.location || '');
  const [jobDraft, setJobDraft] = useState(person?.job || '');
  const [birthDateDraft, setBirthDateDraft] = useState(person?.birth_date || '');
  const [websiteDraft, setWebsiteDraft] = useState(person?.website || '');
  const [showCityDraft, setShowCityDraft] = useState(person?.show_city ?? Boolean(person?.city || person?.location));
  const [showJobDraft, setShowJobDraft] = useState(Boolean(person?.show_job));
  const [showBirthDateDraft, setShowBirthDateDraft] = useState(Boolean(person?.show_birth_date));
  const usernameWrapperRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverImageRef = useRef<HTMLImageElement>(null);
  const coverPanGestureRef = useRef<CoverPanGesture | null>(null);
  const temporaryPreviewUrlsRef = useRef(new Set<string>());
  const [, setLocation] = useLocation();

  const fromSearch = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'search';
  const pageDirection = typeof document !== 'undefined' && document.documentElement.dir === 'ltr' ? 'ltr' : 'rtl';
  const { posts, loading, refresh, error } = usePosts('profile', activeUserId, currentUserId);
  const safeProfilePosts = Array.isArray(posts) ? posts : [];
  const ownProfilePosts = safeProfilePosts.filter(post => post.user_id === activeUserId && !post.reposter_id);
  const orderedEditablePosts = orderOwnedPostsInProfileSlots(ownProfilePosts, activeUserId, Array.isArray(profilePostOrder) ? profilePostOrder : []);
  const displayProfilePosts = orderOwnedPostsInProfileSlots(safeProfilePosts, activeUserId, Array.isArray(profilePostOrder) ? profilePostOrder : []);
  // تبويب الفيديوهات: كل ما نشره المستخدم كريل أو فيديو في التغذية
  // (type = 'reel' أياً كانت الوجهة)، بترتيب زمني من الأحدث للأقدم.
  const profileVideoPosts = displayProfilePosts
    .filter(post => post.type === 'reel')
    .sort((first, second) => Date.parse(second.created_at || '') - Date.parse(first.created_at || ''));
  // تبويب إعادات النشر: ما أعاد صاحب الملف نشره فقط، بترتيب زمني
  // من الأحدث للأقدم (استعلام usePosts يجلبها مع reposter_id).
  const profileReposts = displayProfilePosts
    .filter(post => post.reposter_id === activeUserId)
    .sort((first, second) => Date.parse(second.created_at || '') - Date.parse(first.created_at || ''));

  // تبويب المنشورات المشار فيها: تُعرَّف حالتها قبل أي تأثير يستخدمها
  // (taggedPosts) لتفادي ReferenceError: Cannot access before initialization.
  const [taggedPosts, setTaggedPosts] = useState<Post[]>(() => []);
  const [taggedLoading, setTaggedLoading] = useState(false);
  const [taggedError, setTaggedError] = useState<string | null>(null);
  const taggedFetchedUserRef = useRef<string | null>(null);

  // تحميل مسبق (Preload/Prebuffer) لأول 9 وسائط في القائمة المعروضة
  // حتى يفتح النقر على البطاقة من ذاكرة المتصفح بلا انتظار شبكة.
  const preloadSignatureRef = useRef('');
  useEffect(() => {
    const visibleList = profileContentTab === 'videos'
      ? profileVideoPosts
      : profileContentTab === 'reposts'
        ? profileReposts
        : profileContentTab === 'tagged'
          ? (Array.isArray(taggedPosts) ? taggedPosts : [])
          : displayProfilePosts;
    const signature = `${profileContentTab}:${visibleList.length}:${visibleList.slice(0, 12).map(post => post.id).join(',')}`;
    if (preloadSignatureRef.current === signature) return;
    preloadSignatureRef.current = signature;
    preloadMediaList(visibleList.slice(0, 9).map(firstMediaUrlOfPost));
  }, [profileContentTab, profileVideoPosts, profileReposts, displayProfilePosts, taggedPosts]);

  // تبويب المنشورات المشار فيها: جلب كسول عند أول فتح للتبويب فقط،
  // والإشارات تُقرأ من post_metadata (kind: mention + profileId)
  // في متن/وصف المنشور الأصلي — إشارات التعليقات مستبعدة كلياً.
  useEffect(() => {
    if (profileContentTab !== 'tagged' || !supabaseConfigured) return;
    if (taggedFetchedUserRef.current === activeUserId) return;
    taggedFetchedUserRef.current = activeUserId;
    let active = true;
    void (async () => {
      setTaggedLoading(true);
      setTaggedError(null);
      try {
        if (!activeUserId) throw new Error('معرف المستخدم غير متوفر');
        // فلتر JSONB آمن: containment لكائن واحد (وليس مصفوفة).
        // عامل cs ضد عمود jsonb مصفوفة يطابق أي عنصر فيه هو
        // مجموعة شاملة من الكائن (أي وسم mention بنفس profileId)،
        // ومصدر الخطأ 22P02 السابق كان إرسال مصفوفة كائنات `[...]`
        // وهو صياغة JSON غير مقبولة لـ PostgREST.
        const mentionContainment = JSON.stringify({ kind: 'mention', profileId: activeUserId });
        const { data, error } = await supabase
          .from('posts')
          .select('id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, hide_likes, hide_comments, comment_privacy')
          .filter('post_metadata', 'cs', mentionContainment)
          .neq('user_id', activeUserId)
          .order('created_at', { ascending: false })
          .limit(60);
        if (error) throw error;

        const rows = (data || []) as unknown[];
        const authorIds = [...new Set(rows
          .map(row => (row as Record<string, unknown>).user_id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id)))];
        const profMap = new Map<string, Profile>();
        if (authorIds.length > 0) {
          const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url')
            .in('id', authorIds);
          (profileRows || []).forEach(profileRow => {
            const row = profileRow as Record<string, unknown>;
            if (typeof row.id === 'string') profMap.set(row.id, row as unknown as Profile);
          });
        }

        if (!active) return;
        setTaggedPosts(rows.map(row => {
          const record = row as Record<string, unknown>;
          const authorId = typeof record.user_id === 'string' ? record.user_id : '';
          return {
            ...(record as unknown as Post),
            post_metadata: normalizePostMetadata(record.post_metadata),
            author: profMap.get(authorId) || { id: authorId, username: '', full_name: '', avatar_url: null, bio: '' },
          } as Post;
        }));
      } catch {
        // معالجة آمنة: إرجاع مصفوفة فارغة دائماً حتى لا تنكسر
        // الواجهة أو تظهر شاشة التعطل عند أي فشل استعلام.
        if (active) {
          setTaggedPosts([]);
          setTaggedError('تعذر تحميل المنشورات المشار فيها. أعد المحاولة.');
          taggedFetchedUserRef.current = null;
        }
      } finally {
        if (active) setTaggedLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [profileContentTab, activeUserId]);
  const username = cleanUsername(person?.username);
  const profileCity = person?.city?.trim() || person?.location?.trim() || '';
  const profileJob = person?.job?.trim() || '';
  const profileBirthDate = person?.birth_date?.trim() || '';
  const profileWebsiteUrl = normalizeWebsiteUrl(person?.website);
  const showPublicCity = person?.show_city ?? Boolean(profileCity);
  const showPublicJob = Boolean(person?.show_job && profileJob);
  const formattedBirthDate = formatProfileBirthDate(profileBirthDate);
  const showPublicBirthDate = Boolean(person?.show_birth_date && formattedBirthDate);
  const currentFontLabel = fontPreferenceLabel(resolveFontPreference(person?.font_preference, readLocalFontPreference()));
  const authProviderLabel = authProvider === 'google' ? 'Google' : authProvider === 'apple' ? 'Apple' : authProvider === 'phone' ? 'الهاتف' : 'البريد الإلكتروني';
  const followButtonLabel = isFollowing ? 'أتابع' : followRequestSent ? 'إلغاء طلب المتابعة' : person?.is_private ? 'طلب متابعة' : 'متابعة';

  useEffect(() => {
    if (own && profile) setPerson(profile);
  }, [own, profile]);

  useEffect(() => {
    let active = true;
    setStoryHiddenFromTarget(false);
    if (own || !currentUserId || !activeUserId || !supabaseConfigured) return () => { active = false; };

    void (async () => {
      const [newHide, legacyHide] = await Promise.all([
        supabase.from('story_hides').select('hidden_user_id').eq('hider_id', currentUserId).eq('hidden_user_id', activeUserId).maybeSingle(),
        supabase.from('story_hidden_users').select('hidden_user_id').eq('story_owner_id', currentUserId).eq('hidden_user_id', activeUserId).maybeSingle(),
      ]);
      if (!active) return;
      if (newHide.error && newHide.error.code !== 'PGRST205' && newHide.error.code !== '42P01') {
        console.warn('[profile] تعذر تحميل إعداد إخفاء الستوري:', newHide.error);
      }
      if (legacyHide.error) console.warn('[profile] تعذر تحميل إعداد إخفاء الستوري القديم:', legacyHide.error);
      setStoryHiddenFromTarget(Boolean(newHide.data || legacyHide.data));
    })();

    return () => { active = false; };
  }, [activeUserId, currentUserId, own]);

  useEffect(() => {
    setProfilePostOrder(posts
      .filter(post => post.user_id === activeUserId && !post.reposter_id)
      .map(post => post.id));
  }, [activeUserId, posts]);

  useEffect(() => {
    setAvatarPreview(person?.avatar_url || null);
    setCoverPreview(person?.cover_url || null);
  }, [person?.avatar_url, person?.cover_url]);

  useEffect(() => {
    setCoverPosition({ x: person?.cover_position_x ?? 50, y: person?.cover_position_y ?? 50 });
  }, [person?.id, person?.cover_position_x, person?.cover_position_y]);

  useEffect(() => {
    if (isEditingProfile) return;
    setNameDraft(person?.full_name || person?.display_name || '');
    setUsernameDraft(person?.username || '');
    setBioDraft(person?.bio || '');
    setCityDraft(person?.city || person?.location || '');
    setJobDraft(person?.job || '');
    setBirthDateDraft(person?.birth_date || '');
    setWebsiteDraft(person?.website || '');
    setShowCityDraft(person?.show_city ?? Boolean(person?.city || person?.location));
    setShowJobDraft(Boolean(person?.show_job));
    setShowBirthDateDraft(Boolean(person?.show_birth_date));
  }, [isEditingProfile, person?.id, person?.full_name, person?.display_name, person?.username, person?.bio, person?.city, person?.location, person?.job, person?.birth_date, person?.website, person?.show_city, person?.show_job, person?.show_birth_date]);

  useEffect(() => {
    if (!showSettingsOverlay) return;
    const frame = window.requestAnimationFrame(() => setSettingsOverlayEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [showSettingsOverlay]);

  useEffect(() => {
    if (!showSettingsOverlay) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showLogoutConfirmation) {
        event.preventDefault();
        setShowLogoutConfirmation(false);
        return;
      }
      if (showPhoneModal) {
        event.preventDefault();
        setShowPhoneModal(false);
        return;
      }
      if (showDeactivateAccountConfirmation) {
        event.preventDefault();
        setShowDeactivateAccountConfirmation(false);
        return;
      }
      if (showDeleteAccountConfirmation) {
        event.preventDefault();
        setShowDeleteAccountConfirmation(false);
        return;
      }
      if (navStack.length > 1) {
        setNavStack(previous => previous.length > 1 ? previous.slice(0, -1) : previous);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [showSettingsOverlay, showLogoutConfirmation, showPhoneModal, showDeactivateAccountConfirmation, showDeleteAccountConfirmation, navStack.length]);

  useEffect(() => {
    if (!showSettingsOverlay || !['account', 'password', 'security'].includes(settingsScreen)) return;
    let active = true;
    const loadAuthSettings = async () => {
      if (settingsScreen === 'security') {
        setCurrentSessionLoading(true);
        try {
          const { data, error } = await supabase.auth.getSession();
          if (active) setCurrentSessionExpiry(error ? null : data.session?.expires_at ?? null);
        } catch {
          if (active) setCurrentSessionExpiry(null);
        } finally {
          if (active) setCurrentSessionLoading(false);
        }
        return;
      }
      const { data, error } = await supabase.auth.getUser();
      if (!active) return;
      if (error) {
        toast.error('تعذر تحميل بيانات الحساب.');
        return;
      }
      const user = data.user;
      const providers = Array.isArray(user?.app_metadata?.providers)
        ? user.app_metadata.providers.filter((provider): provider is string => typeof provider === 'string')
        : [];
      const identities = user?.identities || [];
      const primaryProvider = user?.app_metadata?.provider;
      const linkedProvider = identities.find(identity => identity.provider === 'google' || identity.provider === 'apple')?.provider;
      setAuthEmail(user?.email || '');
      setAuthPhone(user?.phone || '');
      setAuthProvider(typeof primaryProvider === 'string' ? primaryProvider : linkedProvider || providers[0] || 'email');
      setHasPassword(providers.includes('email') || identities.some(identity => identity.provider === 'email'));
      if (settingsScreen === 'account') setPhoneDraft(user?.phone || '');
    };
    void loadAuthSettings();
    return () => { active = false; };
  }, [showSettingsOverlay, settingsScreen]);

  useEffect(() => {
    if (!showSettingsOverlay || (settingsScreen !== 'blocked' && settingsScreen !== 'muted')) return;
    let active = true;
    const loadManagedProfiles = async () => {
      setManagedProfilesLoading(true);
      const isBlockedScreen = settingsScreen === 'blocked';
      const ids = isBlockedScreen ? readLocalBlockedUserIds(currentUserId) : readLocalMutedUserIds(currentUserId);
      const hiddenStoryIds = new Set<string>();
      if (isBlockedScreen && supabaseConfigured) {
        const { data, error } = await supabase.from('user_blocks').select('blocked_user_id').eq('blocker_id', currentUserId);
        if (error) {
          console.error('[profile settings] تعذر تحميل قائمة الحظر:', error);
          if (!ids.size) toast.error('تعذر تحميل الحسابات المحظورة.');
        } else {
          (data || []).forEach(row => ids.add(row.blocked_user_id));
        }
      } else if (!isBlockedScreen && supabaseConfigured) {
        const [storyHides, legacyStoryHides] = await Promise.all([
          supabase.from('story_hides').select('hidden_user_id').eq('hider_id', currentUserId),
          supabase.from('story_hidden_users').select('hidden_user_id').eq('story_owner_id', currentUserId),
        ]);
        if (!storyHides.error) (storyHides.data || []).forEach(row => hiddenStoryIds.add(row.hidden_user_id));
        else if (storyHides.error.code !== 'PGRST205' && storyHides.error.code !== '42P01') console.warn('[profile settings] تعذر تحميل الحسابات المخفية عن القصص:', storyHides.error);
        if (!legacyStoryHides.error) (legacyStoryHides.data || []).forEach(row => hiddenStoryIds.add(row.hidden_user_id));
        else console.warn('[profile settings] تعذر تحميل الحسابات المخفية القديمة:', legacyStoryHides.error);
        hiddenStoryIds.forEach(id => ids.add(id));
      }
      if (!active) return;
      setStoryHiddenUserIds(hiddenStoryIds);
      if (!ids.size) {
        if (isBlockedScreen) setBlockedProfiles([]);
        else setMutedProfiles([]);
        setManagedProfilesLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, bio, is_private')
        .in('id', [...ids]);
      if (!active) return;
      if (error) {
        console.error('[profile settings] تعذر تحميل الحسابات:', error);
        toast.error('تعذر تحميل بيانات الحسابات.');
      } else {
        const nextProfiles = (data || []) as Profile[];
        if (isBlockedScreen) setBlockedProfiles(nextProfiles);
        else setMutedProfiles(nextProfiles);
      }
      setManagedProfilesLoading(false);
    };
    void loadManagedProfiles();
    return () => { active = false; };
  }, [showSettingsOverlay, settingsScreen, currentUserId]);

  useEffect(() => {
    setShowFollowCheckmark(false);
    if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
    followCheckTimerRef.current = null;
  }, [activeUserId]);

  useEffect(() => () => {
    temporaryPreviewUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    temporaryPreviewUrlsRef.current.clear();
    if (followCheckTimerRef.current) clearTimeout(followCheckTimerRef.current);
    const reorderGesture = profileReorderGestureRef.current;
    if (reorderGesture?.timer !== null && reorderGesture?.timer !== undefined) window.clearTimeout(reorderGesture.timer);
    profileReorderGestureRef.current = null;
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
      const loadHighlightCollections = async () => {
        const orderedResult = await supabase.from('profile_highlight_collections')
          .select('id, user_id, title, cover_url, created_at, display_order')
          .eq('user_id', activeUserId)
          .order('display_order', { ascending: true })
          .order('created_at', { ascending: true })
          .limit(100);
        if (!orderedResult.error || !/display_order/i.test(orderedResult.error.message)) return orderedResult;
        return supabase.from('profile_highlight_collections')
          .select('id, user_id, title, cover_url, created_at')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: true })
          .limit(100);
      };

      const [{ data: prof }, { count: fCount }, { count: fingCount }, { data: checkFollow }, { data: checkRequest }, { data: collectionRows, error: collectionsError }, { data: highlightRows, error: highlightsError }] = await Promise.all([
        supabase.from('profiles').select('id,username,full_name,display_name,avatar_url,cover_url,cover_position_x,cover_position_y,location,city,job,birth_date,show_city,show_job,show_birth_date,website,bio,is_private,is_deactivated,notification_settings,appearance_preference,language_preference,hd_uploads,data_saver,font_preference,created_at,updated_at').eq('id', activeUserId).maybeSingle(),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', activeUserId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', activeUserId),
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', currentUserId).eq('following_id', activeUserId).maybeSingle(),
        own ? Promise.resolve({ data: null }) : supabase.from('follow_requests').select('requester_id').eq('requester_id', currentUserId).eq('recipient_id', activeUserId).maybeSingle(),
        loadHighlightCollections(),
        supabase.from('profile_highlights').select('id, user_id, collection_id, position, media_url, media_type, caption, source_story_id, is_close_friends, duration_seconds, created_at').eq('user_id', activeUserId).order('position', { ascending: true }).order('created_at', { ascending: true }).limit(500),
      ]);

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

  const toggleStoryVisibilityForProfile = async () => {
    if (!supabaseConfigured || own || !currentUserId || profileActionBusy) return;
    setProfileActionBusy(true);
    try {
      const { error } = await supabase.rpc(
        storyHiddenFromTarget ? 'aani_unhide_story_from_user' : 'aani_hide_story_from_user',
        { p_hidden_user_id: activeUserId },
      );
      if (error) throw error;
      setStoryHiddenFromTarget(!storyHiddenFromTarget);
      setShowProfileMenu(false);
      toast.success(storyHiddenFromTarget ? 'سيتمكن هذا الحساب من رؤية قصصك مجدداً.' : 'لن يتمكن هذا الحساب من رؤية قصصك.');
    } catch (error) {
      console.error('[profile] تعذر تحديث إخفاء الستوري:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر تحديث إعداد إخفاء الستوري. شغّل سكريبت إعدادات الملف الشخصي في Supabase ثم أعد المحاولة.');
    } finally {
      setProfileActionBusy(false);
    }
  };

  const blockProfile = async () => {
    if (!supabaseConfigured || own || !currentUserId || profileActionBusy) return;
    if (!window.confirm(`هل تريد حظر ${displayName(person)}؟ سيؤدي ذلك إلى إلغاء المتابعة ومنع التواصل.`)) return;
    setProfileActionBusy(true);
    try {
      const { error } = await supabase.rpc('aani_block_user', { p_blocked_user_id: activeUserId });
      if (error) throw error;
      const ids = readLocalBlockedUserIds(currentUserId);
      ids.add(activeUserId);
      writeLocalBlockedUserIds(currentUserId, ids);
      setShowProfileMenu(false);
      toast.success('تم حظر الحساب وإلغاء المتابعة.');
      setLocation('/');
    } catch (error) {
      console.error('[profile] تعذر حظر الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حظر الحساب. تأكد من تطبيق تحديث الحظر في Supabase.');
    } finally {
      setProfileActionBusy(false);
    }
  };

  const openProfileReportDialog = () => {
    setShowProfileMenu(false);
    setProfileReportCategory('other');
    setProfileReportDetails('');
    setShowProfileReportDialog(true);
  };

  const submitProfileReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured || own || !currentUserId || profileReportSubmitting) return;
    setProfileReportSubmitting(true);
    try {
      const { error } = await supabase.from('user_reports').insert({
        reporter_id: currentUserId,
        reported_user_id: activeUserId,
        category: profileReportCategory,
        details: profileReportDetails.trim(),
      });
      if (error?.code === '23505') throw new Error('سبق أن أبلغت عن هذا الحساب.');
      if (error) throw error;
      setShowProfileReportDialog(false);
      toast.success('تم إرسال البلاغ لمراجعته.');
    } catch (error) {
      console.error('[profile] تعذر إرسال بلاغ الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال البلاغ. تأكد من تطبيق جداول البلاغات في Supabase.');
    } finally {
      setProfileReportSubmitting(false);
    }
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

  const closeSettingsOverlay = () => {
    setShowSettingsOverlay(false);
    setSettingsOverlayEntered(false);
    setShowLogoutConfirmation(false);
    setShowPhoneModal(false);
    setShowDeactivateAccountConfirmation(false);
    setShowDeleteAccountConfirmation(false);
    setDeleteAccountConfirmation('');
    setNavStack(['main']);
  };

  const openSettingsOverlay = () => {
    setShowProfileMenu(false);
    setShowLogoutConfirmation(false);
    setShowPhoneModal(false);
    setShowDeactivateAccountConfirmation(false);
    setShowDeleteAccountConfirmation(false);
    setNavStack(['main']);
    setSettingsOverlayEntered(false);
    setShowSettingsOverlay(true);
  };

  const navigateToSettingsScreen = (screen: SettingsScreen) => {
    if (screen === 'home') {
      setNavStack(['main']);
      return;
    }
    setNavStack(previous => [...previous, screen]);
  };

  const goBackInSettings = () => {
    if (showLogoutConfirmation) {
      setShowLogoutConfirmation(false);
      return;
    }
    if (showPhoneModal) {
      setShowPhoneModal(false);
      return;
    }
    if (showDeactivateAccountConfirmation) {
      setShowDeactivateAccountConfirmation(false);
      return;
    }
    if (showDeleteAccountConfirmation) {
      setShowDeleteAccountConfirmation(false);
      setDeleteAccountConfirmation('');
      return;
    }
    if (navStack.length === 1) {
      closeSettingsOverlay();
      return;
    }
    setNavStack(previous => (previous.length > 1 ? previous.slice(0, -1) : previous));
  };

  const startProfileEditing = () => {
    if (!person) return;
    setNameDraft(person.full_name || person.display_name || '');
    setUsernameDraft(person.username || '');
    setBioDraft(person.bio || '');
    setCityDraft(person.city || person.location || '');
    setJobDraft(person.job || '');
    setBirthDateDraft(person.birth_date || '');
    setWebsiteDraft(person.website || '');
    setShowCityDraft(person.show_city ?? Boolean(person.city || person.location));
    setShowJobDraft(Boolean(person.show_job));
    setShowBirthDateDraft(Boolean(person.show_birth_date));
    setCoverPosition({ x: person.cover_position_x ?? 50, y: person.cover_position_y ?? 50 });
    setImagePreview('avatar', person.avatar_url || null);
    setImagePreview('cover', person.cover_url || null);
    setPendingAvatarFile(null);
    setPendingCoverFile(null);
    setAvatarCropFile(null);
    setShowProfileReorder(false);
    setIsEditingProfile(true);
    closeSettingsOverlay();
  };

  const cancelProfileEditing = () => {
    if (!person) return;
    setNameDraft(person.full_name || person.display_name || '');
    setUsernameDraft(person.username || '');
    setBioDraft(person.bio || '');
    setCityDraft(person.city || person.location || '');
    setJobDraft(person.job || '');
    setBirthDateDraft(person.birth_date || '');
    setWebsiteDraft(person.website || '');
    setShowCityDraft(person.show_city ?? Boolean(person.city || person.location));
    setShowJobDraft(Boolean(person.show_job));
    setShowBirthDateDraft(Boolean(person.show_birth_date));
    setCoverPosition({ x: person.cover_position_x ?? 50, y: person.cover_position_y ?? 50 });
    setImagePreview('avatar', person.avatar_url || null);
    setImagePreview('cover', person.cover_url || null);
    setPendingAvatarFile(null);
    setPendingCoverFile(null);
    setAvatarCropFile(null);
    coverPanGestureRef.current = null;
    setShowProfileReorder(false);
    setIsEditingProfile(false);
  };

  const savePhoneChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPhone = phoneDraft.trim().replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(nextPhone)) {
      toast.error('أدخل رقم الهاتف بالصيغة الدولية، مثل ‎+9665XXXXXXXX.');
      return;
    }
    if (nextPhone === authPhone || accountSettingsBusy) return;
    setAccountSettingsBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('update-account-phone', { body: { phone: nextPhone } });
      if (error) throw error;
      if (data?.phone !== nextPhone) throw new Error('لم يتم إرجاع رقم الهاتف المحدّث من الخادم.');
      setAuthPhone(nextPhone);
      setPhoneDraft(nextPhone);
      setShowPhoneModal(false);
      toast.success('تم تحديث رقم الهاتف مباشرة.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر تحديث رقم الهاتف.');
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  const savePasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passwordDraft.length < 6 || accountSettingsBusy) return;
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: passwordDraft });
      if (error) throw error;
      setPasswordDraft('');
      setHasPassword(true);
      toast.success('تم تحديث كلمة المرور.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر تحديث كلمة المرور.');
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  const deactivateAccountTemporarily = async () => {
    if (!currentUserId || accountSettingsBusy) return;
    setAccountSettingsBusy(true);
    try {
      const { data, error } = await supabase.from('profiles')
        .update({ is_deactivated: true })
        .eq('id', currentUserId)
        .select('id')
        .maybeSingle();
      if (error) {
        if ((error.code === 'PGRST204' || error.code === '42703') && /is_deactivated/i.test(error.message)) {
          throw new Error('طبّق ترحيل تعطيل الحساب في Supabase ثم حاول مجدداً.');
        }
        throw error;
      }
      if (!data?.id) throw new Error('تعذر العثور على ملف الحساب لتحديث حالته.');

      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setShowDeactivateAccountConfirmation(false);
      setShowSettingsOverlay(false);
      toast.success('تم تعطيل الحساب مؤقتاً. سجّل الدخول مجدداً لإعادة تفعيله.');
      setLocation('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر تعطيل الحساب مؤقتاً.');
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  const deleteAccountPermanently = async () => {
    if (deleteAccountConfirmation.trim() !== 'حذف' || accountSettingsBusy) return;
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.functions.invoke('delete-account');
      if (error) throw error;
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setShowDeleteAccountConfirmation(false);
      setShowSettingsOverlay(false);
      toast.success('تم حذف الحساب وبياناته نهائياً.');
      setLocation('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر حذف الحساب.');
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  const unblockProfile = async (blockedUserId: string) => {
    if (managedProfileBusyId) return;
    setManagedProfileBusyId(blockedUserId);
    try {
      const { error } = await supabase.rpc('aani_unblock_user', { p_blocked_user_id: blockedUserId });
      if (error) throw error;
      const ids = readLocalBlockedUserIds(currentUserId);
      ids.delete(blockedUserId);
      writeLocalBlockedUserIds(currentUserId, ids);
      setBlockedProfiles(current => current.filter(item => item.id !== blockedUserId));
      toast.success('تم إلغاء حظر الحساب.');
    } catch (error) {
      console.error('[profile settings] تعذر إلغاء الحظر:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إلغاء الحظر. طبّق تحديث إعدادات الخصوصية في Supabase ثم حاول مجدداً.');
    } finally {
      setManagedProfileBusyId(null);
    }
  };

  const unmuteProfile = async (mutedUserId: string) => {
    if (managedProfileBusyId) return;
    setManagedProfileBusyId(mutedUserId);
    try {
      if (storyHiddenUserIds.has(mutedUserId)) {
        const { error } = await supabase.rpc('aani_unhide_story_from_user', { p_hidden_user_id: mutedUserId });
        if (error) throw error;
        setStoryHiddenUserIds(current => {
          const next = new Set(current);
          next.delete(mutedUserId);
          return next;
        });
      }
      const ids = readLocalMutedUserIds(currentUserId);
      ids.delete(mutedUserId);
      writeLocalMutedUserIds(currentUserId, ids);
      setMutedProfiles(current => current.filter(item => item.id !== mutedUserId));
      toast.success(storyHiddenUserIds.has(mutedUserId) ? 'تم إلغاء إخفاء القصص عن الحساب.' : 'تم إلغاء كتم المحادثة.');
    } catch (error) {
      console.error('[profile settings] تعذر إلغاء كتم/إخفاء الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إلغاء إخفاء القصص. حاول مرة أخرى.');
    } finally {
      setManagedProfileBusyId(null);
    }
  };

  const endCurrentSession = async () => {
    if (accountSettingsBusy) return;
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setShowLogoutConfirmation(false);
      closeSettingsOverlay();
      setLocation('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر تسجيل الخروج من هذا الجهاز.');
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  const openSupportEmailDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = supportReport.trim();
    if (!description) {
      toast.error('اكتب وصفاً للمشكلة أولاً.');
      return;
    }
    const subject = encodeURIComponent('بلاغ عن مشكلة في تطبيق آني');
    const body = encodeURIComponent(`مرحباً، أود الإبلاغ عن المشكلة التالية في تطبيق آني:\n\n${description}`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
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

    const name = nameDraft.trim();
    const normalizedUsername = cleanUsername(usernameDraft).toLowerCase();
    if (!name || name.length > 120) {
      toast.error('أدخل اسماً لا يتجاوز 120 حرفاً.');
      return;
    }
    if (!/^[a-z0-9_.]{3,32}$/.test(normalizedUsername)) {
      toast.error('اسم المستخدم يجب أن يتكون من 3 إلى 32 حرفاً إنجليزياً أو رقماً أو نقطة أو شرطة سفلية.');
      return;
    }
    if (birthDateDraft && !formatProfileBirthDate(birthDateDraft)) {
      toast.error('أدخل تاريخ ميلاد صالحاً.');
      return;
    }

    setProfileSaving(true);
    const uploadedPaths: string[] = [];
    const normalizedCity = cityDraft.trim() || null;
    const patch: Partial<Profile> = {
      full_name: name,
      display_name: name,
      username: normalizedUsername,
      bio: bioDraft,
      city: normalizedCity,
      location: normalizedCity,
      job: jobDraft.trim() || null,
      birth_date: birthDateDraft || null,
      website: websiteDraft.trim() || null,
      show_city: showCityDraft,
      show_job: showJobDraft,
      show_birth_date: showBirthDateDraft,
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
      setShowProfileReorder(false);
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
      const saveError = error as { code?: string; message?: string };
      if (saveError.code === '23505') {
        toast.error('اسم المستخدم مستخدم بالفعل.');
      } else if ((saveError.code === 'PGRST204' || saveError.code === '42703') && /city|job|birth_date|show_city|show_job|show_birth_date/i.test(saveError.message || '')) {
        toast.error('تعذر حفظ بيانات الملف الجديدة. طبّق ترحيل بيانات الملف الشخصي في Supabase ثم حاول مجدداً.');
      } else {
        toast.error('تعذر حفظ تعديلات الملف الشخصي. حاول مرة أخرى.');
      }
    } finally {
      setProfileSaving(false);
    }
  };

  const saveProfileContentOrder = async (kind: ProfileReorderKind, nextIds: string[], previousIds: string[]) => {
    const restorePreviousOrder = () => {
      if (kind === 'highlights') {
        const previousCollections = new Map(profileHighlights.map(collection => [collection.id, collection]));
        setProfileHighlights(previousIds.flatMap(id => previousCollections.has(id) ? [previousCollections.get(id)!] : []));
      } else {
        setProfilePostOrder(previousIds);
      }
    };

    if (!supabaseConfigured) {
      restorePreviousOrder();
      toast.error('اتصال قاعدة البيانات غير متاح.');
      return;
    }

    setProfileReorderSaving(true);
    try {
      const { error } = await supabase.rpc('aani_reorder_profile_content', { p_kind: kind, p_ids: nextIds });
      if (error) {
        restorePreviousOrder();
        console.error('[profile] تعذر حفظ ترتيب المحتوى:', error);
        toast.error(error.code === 'PGRST202' || error.code === '42883'
          ? 'طبّق ترحيل إعادة ترتيب محتوى الملف الشخصي في Supabase أولاً.'
          : 'تعذر حفظ الترتيب الجديد. حاول مرة أخرى.');
      } else {
        toast.success('تم حفظ الترتيب الجديد.');
      }
    } catch (error) {
      restorePreviousOrder();
      console.error('[profile] تعذر حفظ ترتيب المحتوى:', error);
      toast.error('تعذر حفظ الترتيب الجديد. تحقق من الاتصال ثم حاول مرة أخرى.');
    } finally {
      setProfileReorderSaving(false);
    }
  };

  const beginProfileReorder = (event: ReactPointerEvent<HTMLElement>, kind: ProfileReorderKind, id: string) => {
    if (!own || !showProfileReorder || profileReorderSaving) return;
    const previousGesture = profileReorderGestureRef.current;
    if (previousGesture?.timer !== null && previousGesture?.timer !== undefined) window.clearTimeout(previousGesture.timer);
    const gesture: ProfileReorderGesture = {
      kind,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      active: false,
    };
    profileReorderGestureRef.current = gesture;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.timer = window.setTimeout(() => {
      if (profileReorderGestureRef.current !== gesture) return;
      gesture.active = true;
      setDraggingReorderKey(`${kind}:${id}`);
    }, 450);
  };

  const moveProfileReorderPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = profileReorderGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 10) {
        if (gesture.timer !== null) window.clearTimeout(gesture.timer);
        profileReorderGestureRef.current = null;
      }
      return;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-profile-reorder-kind][data-profile-reorder-id]');
    const targetKind = target?.dataset.profileReorderKind;
    const targetId = target?.dataset.profileReorderId;
    setDragOverReorderKey(targetKind === gesture.kind && targetId ? `${gesture.kind}:${targetId}` : null);
  };

  const endProfileReorderPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = profileReorderGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.timer !== null) window.clearTimeout(gesture.timer);
    profileReorderGestureRef.current = null;
    setDraggingReorderKey(null);
    setDragOverReorderKey(null);
    if (!gesture.active) return;

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-profile-reorder-kind][data-profile-reorder-id]');
    const targetKind = target?.dataset.profileReorderKind;
    const targetId = target?.dataset.profileReorderId;
    if (targetKind !== gesture.kind || !targetId) return;

    if (gesture.kind === 'highlights') {
      const previousIds = profileHighlights.map(collection => collection.id);
      const nextIds = moveProfileItem(previousIds, gesture.id, targetId);
      if (nextIds === previousIds) return;
      const collectionById = new Map(profileHighlights.map(collection => [collection.id, collection]));
      setProfileHighlights(nextIds.flatMap(id => collectionById.has(id) ? [collectionById.get(id)!] : []));
      void saveProfileContentOrder('highlights', nextIds, previousIds);
      return;
    }

    const previousIds = orderedEditablePosts.map(post => post.id);
    const nextIds = moveProfileItem(previousIds, gesture.id, targetId);
    if (nextIds === previousIds) return;
    setProfilePostOrder(nextIds);
    void saveProfileContentOrder('posts', nextIds, previousIds);
  };

  const cancelProfileReorderPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = profileReorderGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.timer !== null) window.clearTimeout(gesture.timer);
    profileReorderGestureRef.current = null;
    setDraggingReorderKey(null);
    setDragOverReorderKey(null);
  };

  if (!person) {
    return (
      <section className="profile-screen mx-auto w-full max-w-[600px]" dir={pageDirection}>
        {fromSearch && (
          <div className="flex justify-start px-2 pt-2">
            <button type="button" aria-label="العودة إلى البحث" onClick={() => setLocation('/search')} className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-zinc-800">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 18l-6-6 6-6" /></svg>
            </button>
          </div>
        )}
        <ProfileSkeleton />
      </section>
    );
  }

  const formattedPostCount = posts.length.toLocaleString('en-US');
  const formattedFollowers = followers.toLocaleString('en-US');
  const formattedFollowing = following.toLocaleString('en-US');

  return (
    <section className="profile-screen relative mx-auto min-h-[150vh] w-full max-w-[600px] select-none content-fade-in" dir={pageDirection}>
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" aria-label="اختيار صورة الغلاف" disabled={!isEditingProfile || profileSaving} onChange={event => handleProfileImageSelection('cover', event)} />
      <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" aria-label="اختيار الصورة الشخصية" disabled={!isEditingProfile || profileSaving} onChange={event => handleProfileImageSelection('avatar', event)} />

      {isEditingProfile && typeof document !== 'undefined' && createPortal(
        <div className="profile-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="profile-edit-title" dir={pageDirection}>
          <form
            className="profile-edit-form"
            onSubmit={event => {
              event.preventDefault();
              void saveProfileEdits();
            }}
          >
            <header className="profile-edit-header">
              <button type="button" className="profile-edit-cancel" onClick={cancelProfileEditing} disabled={profileSaving}>إلغاء</button>
              <h2 id="profile-edit-title">تعديل الملف الشخصي</h2>
              <button type="submit" className="profile-edit-save" disabled={profileSaving}>{profileSaving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </header>
            <div className="profile-edit-scroll">
              <div
                className="profile-edit-cover"
                onPointerDown={handleCoverPointerDown}
                onPointerMove={handleCoverPointerMove}
                onPointerUp={handleCoverPointerEnd}
                onPointerCancel={handleCoverPointerEnd}
              >
                {coverPreview ? (
                  <img ref={coverImageRef} src={coverPreview} alt="معاينة صورة الغلاف" draggable={false} style={{ objectPosition: `${coverPosition.x}% ${coverPosition.y}%` }} />
                ) : (
                  <div className="profile-edit-cover-placeholder" aria-hidden="true"><Camera size={30} /></div>
                )}
                <button type="button" className="profile-edit-media-button" aria-label={coverPreview ? 'تغيير صورة الغلاف' : 'إضافة صورة غلاف'} onClick={() => coverInputRef.current?.click()} disabled={profileSaving}>
                  <Camera size={22} />
                </button>
              </div>
              <div className="profile-edit-avatar">
                {avatarPreview ? <img src={avatarPreview} alt="معاينة الصورة الشخصية" /> : <span className="grid h-full w-full place-items-center text-3xl font-bold text-white/70">{displayName(person).slice(0, 1)}</span>}
                <button type="button" className="profile-edit-media-button" aria-label={avatarPreview ? 'تغيير الصورة الشخصية' : 'إضافة صورة شخصية'} onClick={() => avatarInputRef.current?.click()} disabled={profileSaving}>
                  <Camera size={21} />
                </button>
              </div>
              <div className="profile-edit-fields">
                <div className="profile-edit-field">
                  <label htmlFor="profile-edit-name">الاسم الظاهر</label>
                  <input id="profile-edit-name" value={nameDraft} onChange={event => setNameDraft(event.target.value)} maxLength={120} autoComplete="name" required dir="auto" placeholder="أدخل اسمك" />
                </div>
                <div className="profile-edit-field">
                  <label htmlFor="profile-edit-username">اسم المستخدم</label>
                  <div className="profile-edit-username-input">
                    <span aria-hidden="true">@</span>
                    <input id="profile-edit-username" value={usernameDraft} onChange={event => setUsernameDraft(event.target.value)} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-describedby="profile-edit-username-hint" />
                  </div>
                  <span id="profile-edit-username-hint" className="text-xs text-white/45">3 إلى 32 حرفاً إنجليزياً أو رقماً أو نقطة أو شرطة سفلية</span>
                </div>
                <div className="profile-edit-field">
                  <label htmlFor="profile-edit-bio">السيرة الذاتية</label>
                  <textarea id="profile-edit-bio" value={bioDraft} onChange={event => setBioDraft(event.target.value)} rows={5} dir="auto" placeholder="اكتب نبذة عنك..." />
                </div>
                <div className="profile-edit-metadata-row">
                  <label htmlFor="profile-edit-job">الوظيفة</label>
                  <input id="profile-edit-job" value={jobDraft} onChange={event => setJobDraft(event.target.value)} maxLength={120} dir="auto" placeholder="أضف وظيفتك" />
                  <button type="button" role="switch" aria-checked={showJobDraft} aria-label="إظهار الوظيفة في الملف الشخصي العام" onClick={() => setShowJobDraft(value => !value)} className={`profile-edit-visibility-toggle${showJobDraft ? ' is-enabled' : ''}`}>
                    {showJobDraft && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
                <div className="profile-edit-metadata-row">
                  <label htmlFor="profile-edit-city">الموقع الجغرافي</label>
                  <input id="profile-edit-city" value={cityDraft} onChange={event => setCityDraft(event.target.value)} maxLength={100} dir="auto" placeholder="أضف مدينتك" />
                  <button type="button" role="switch" aria-checked={showCityDraft} aria-label="إظهار المدينة في الملف الشخصي العام" onClick={() => setShowCityDraft(value => !value)} className={`profile-edit-visibility-toggle${showCityDraft ? ' is-enabled' : ''}`}>
                    {showCityDraft && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
                <div className="profile-edit-metadata-row">
                  <label htmlFor="profile-edit-birth-date">تاريخ الميلاد</label>
                  <input id="profile-edit-birth-date" type="date" value={birthDateDraft} onChange={event => setBirthDateDraft(event.target.value)} max={new Date().toISOString().slice(0, 10)} />
                  <button type="button" role="switch" aria-checked={showBirthDateDraft} aria-label="إظهار تاريخ الميلاد في الملف الشخصي العام" onClick={() => setShowBirthDateDraft(value => !value)} className={`profile-edit-visibility-toggle${showBirthDateDraft ? ' is-enabled' : ''}`}>
                    {showBirthDateDraft && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
                <div className="profile-edit-field">
                  <label htmlFor="profile-edit-website">الموقع الإلكتروني</label>
                  <input id="profile-edit-website" type="url" value={websiteDraft} onChange={event => setWebsiteDraft(event.target.value)} maxLength={200} dir="ltr" placeholder="https://example.com" />
                </div>
              </div>
              <div className="profile-reorder-launch">
                <button
                  type="button"
                  className="profile-reorder-toggle"
                  aria-expanded={showProfileReorder}
                  onClick={() => setShowProfileReorder(open => !open)}
                  disabled={profileReorderSaving}
                >
                  {showProfileReorder ? 'إخفاء الترتيب' : 'تعديل المنشورات'}
                </button>
              </div>
              {showProfileReorder && (
                <section className="profile-reorder-panel" aria-label="إعادة ترتيب القصص والمنشورات">
                  <p className="profile-reorder-hint">اضغط مطولاً على عنصر ثم اسحبه إلى موضعه الجديد.</p>
                  <h3>أبرز القصص</h3>
                  <div className="profile-reorder-list" role="list">
                    {profileHighlights.length ? profileHighlights.map(collection => {
                      const cover = collection.stories[0];
                      const key = `highlights:${collection.id}`;
                      return (
                        <button
                          key={collection.id}
                          type="button"
                          className={`profile-reorder-item${draggingReorderKey === key ? ' is-dragging' : ''}${dragOverReorderKey === key ? ' is-drop-target' : ''}`}
                          data-profile-reorder-kind="highlights"
                          data-profile-reorder-id={collection.id}
                          onPointerDown={event => beginProfileReorder(event, 'highlights', collection.id)}
                          onPointerMove={moveProfileReorderPointer}
                          onPointerUp={endProfileReorderPointer}
                          onPointerCancel={cancelProfileReorderPointer}
                          disabled={profileReorderSaving}
                          aria-label={`اضغط مطولاً لإعادة ترتيب أبرز القصص: ${collection.title}`}
                        >
                          <span className="profile-reorder-drag-mark" aria-hidden="true">⠿</span>
                          <span className="profile-reorder-thumb">
                            {collection.cover_url ? <img src={collection.cover_url} alt="" /> : cover?.media_url && cover.media_type === 'video' ? <video src={cover.media_url} muted playsInline preload="metadata" /> : cover?.media_url ? <img src={cover.media_url} alt="" /> : <span>{cover?.caption || collection.title}</span>}
                          </span>
                          <span className="profile-reorder-copy"><strong>{collection.title}</strong><small>{collection.stories.length} قصص</small></span>
                        </button>
                      );
                    }) : <p className="profile-reorder-empty">لا توجد قصص مميزة لترتيبها.</p>}
                  </div>
                  <h3>المنشورات</h3>
                  <div className="profile-reorder-list" role="list">
                    {orderedEditablePosts.length ? orderedEditablePosts.map(post => {
                      const key = `posts:${post.id}`;
                      return (
                        <button
                          key={post.id}
                          type="button"
                          className={`profile-reorder-item${draggingReorderKey === key ? ' is-dragging' : ''}${dragOverReorderKey === key ? ' is-drop-target' : ''}`}
                          data-profile-reorder-kind="posts"
                          data-profile-reorder-id={post.id}
                          onPointerDown={event => beginProfileReorder(event, 'posts', post.id)}
                          onPointerMove={moveProfileReorderPointer}
                          onPointerUp={endProfileReorderPointer}
                          onPointerCancel={cancelProfileReorderPointer}
                          disabled={profileReorderSaving}
                          aria-label={`اضغط مطولاً لإعادة ترتيب المنشور: ${post.content || 'منشور وسائط'}`}
                        >
                          <span className="profile-reorder-drag-mark" aria-hidden="true">⠿</span>
                          <span className="profile-reorder-thumb">
                            {post.media_url ? post.type === 'reel' ? <video src={post.media_url} muted playsInline preload="metadata" /> : <img src={post.media_url} alt="" /> : <span>{post.content.slice(0, 32) || 'منشور'}</span>}
                          </span>
                          <span className="profile-reorder-copy"><strong>{post.content || 'منشور وسائط'}</strong><small>{new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(new Date(post.created_at))}</small></span>
                        </button>
                      );
                    }) : <p className="profile-reorder-empty">لا توجد منشورات قابلة لإعادة الترتيب.</p>}
                  </div>
                  {profileReorderSaving && <p className="profile-reorder-saving" role="status">جارٍ حفظ الترتيب…</p>}
                </section>
              )}
            </div>
          </form>
        </div>,
        document.body,
      )}

      <div className="profile-header-container">
        <div className="notch-safe-area" />
        <div className="relative z-30 flex items-center justify-end bg-black/40 px-4 py-2 backdrop-blur-md">
          <button
            type="button"
            aria-label={isEditingProfile ? 'حفظ تعديلات الملف الشخصي' : 'المزيد من خيارات الملف الشخصي'}
            aria-expanded={!isEditingProfile && (own ? showSettingsOverlay : showProfileMenu)}
            onClick={() => isEditingProfile ? void saveProfileEdits() : own ? openSettingsOverlay() : setShowProfileMenu(open => !open)}
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
          {!isEditingProfile && showProfileMenu && !own && (
            <div role="menu" aria-label="خيارات الملف الشخصي" className="absolute left-4 top-full z-[60] max-h-[70dvh] w-[min(340px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-[#2F3336] bg-[#111] p-3 text-white shadow-xl">
              <Link href={`/messages/${activeUserId}`} onClick={() => setShowProfileMenu(false)} role="menuitem" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm hover:bg-white/10">
                <MessageCircle size={17} aria-hidden="true" />
                <span>إرسال رسالة</span>
              </Link>
              <button type="button" role="menuitem" onClick={() => void toggleStoryVisibilityForProfile()} disabled={profileActionBusy} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm hover:bg-white/10 disabled:opacity-50">
                {storyHiddenFromTarget ? <Eye size={17} aria-hidden="true" /> : <EyeOff size={17} aria-hidden="true" />}
                <span>{storyHiddenFromTarget ? 'إلغاء إخفاء الستوري' : 'إخفاء الستوري عن هذا الشخص'}</span>
              </button>
              <div role="separator" className="my-2 border-t border-[#2F3336]" />
              <button type="button" role="menuitem" onClick={() => void blockProfile()} disabled={profileActionBusy} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                <Ban size={17} aria-hidden="true" />
                <span>حظر</span>
              </button>
              <button type="button" role="menuitem" onClick={openProfileReportDialog} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm hover:bg-white/10">
                <Flag size={17} aria-hidden="true" />
                <span>الإبلاغ</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={showProfileReportDialog} onOpenChange={open => { if (!profileReportSubmitting) setShowProfileReportDialog(open); }}>
        <DialogContent dir={pageDirection} className="border-[#2F3336] bg-[#111] text-white sm:max-w-md">
          <DialogHeader className="text-right">
            <DialogTitle>الإبلاغ عن {displayName(person)}</DialogTitle>
            <DialogDescription className="text-right text-zinc-400">اختر سبب البلاغ. سيُرسل إلى فريق المراجعة.</DialogDescription>
          </DialogHeader>
          <form onSubmit={event => void submitProfileReport(event)} className="space-y-4">
            <label htmlFor="profile-report-category" className="block space-y-2 text-sm">
              <span>سبب الإبلاغ</span>
              <select id="profile-report-category" value={profileReportCategory} onChange={event => setProfileReportCategory(event.target.value as ProfileReportCategory)} className="w-full rounded-lg border border-[#2F3336] bg-[#191919] px-3 py-2.5 text-white">
                <option value="other">محتوى غير لائق أو سبب آخر</option>
                <option value="fake_account">انتحال شخصية</option>
                <option value="spam">سبام أو محتوى مزعج</option>
                <option value="harassment">مضايقة أو تنمّر</option>
                <option value="hate">خطاب كراهية</option>
              </select>
            </label>
            <label htmlFor="profile-report-details" className="block space-y-2 text-sm">
              <span>تفاصيل إضافية (اختياري)</span>
              <textarea id="profile-report-details" value={profileReportDetails} onChange={event => setProfileReportDetails(event.target.value)} maxLength={1000} rows={4} dir="auto" placeholder="أضف تفاصيل تساعدنا في مراجعة البلاغ" className="w-full resize-y rounded-lg border border-[#2F3336] bg-[#191919] px-3 py-2.5 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-[#1D9BF0]" />
            </label>
            <DialogFooter className="gap-2 sm:gap-2">
              <button type="button" onClick={() => setShowProfileReportDialog(false)} disabled={profileReportSubmitting} className="rounded-full border border-[#53575B] px-4 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-50">إلغاء</button>
              <button type="submit" disabled={profileReportSubmitting} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50">{profileReportSubmitting ? 'جارٍ الإرسال…' : 'إرسال البلاغ'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {showSettingsOverlay && typeof document !== 'undefined' && createPortal(
        <div
          className={`profile-settings-overlay${settingsOverlayEntered ? ' is-visible' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-settings-title"
          dir={pageDirection}
        >
          <section className="profile-settings-panel" onClick={event => event.stopPropagation()}>
            <header className="profile-settings-header">
              <button type="button" aria-label={navStack.length > 1 ? 'العودة إلى الشاشة السابقة' : 'العودة إلى الصفحة السابقة'} className="profile-settings-back" onClick={goBackInSettings}>
                <ChevronRight size={20} />
              </button>
              <h2 id="profile-settings-title">
                {({
                  home: 'الإعدادات',
                  account: 'إعدادات الحساب',
                  password: 'كلمة المرور',
                  security: 'الأمان والأجهزة',
                  privacy: 'خصوصية الحساب',
                  blocked: 'الحسابات المحظورة',
                  muted: 'الحسابات المكتومة',
                  subscriptions: 'إدارة الاشتراكات',
                  billing: 'سجل الفواتير والدفع',
                  archive: 'الأرشيف',
                  saved: 'العناصر المحفوظة',
                  support: 'مركز المساعدة',
                  report: 'الإبلاغ عن مشكلة',
                  faq: 'الأسئلة الشائعة',
                  legal: 'سياسة الخصوصية وشروط الخدمة',
                  about: 'عن التطبيق',
                  notifications: 'الإشعارات',
                  appearance: 'المظهر',
                  language: 'اللغة',
                  'media-quality': 'جودة الوسائط',
                  'font-style': 'نوع الخط',
                } as Record<SettingsScreen, string>)[settingsScreen]}
              </h2>
              <button type="button" aria-label="إغلاق الإعدادات" className="profile-settings-close" onClick={closeSettingsOverlay}>
                <X size={24} strokeWidth={2.5} />
              </button>
            </header>

            <div key={settingsScreen} className="profile-settings-list">
              {settingsScreen === 'home' ? (
                <>
                  <p className="profile-settings-section-title">الحساب والخصوصية</p>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={startProfileEditing}>
                    <span>تعديل الملف الشخصي</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('account')}>
                    <span>إعدادات الحساب</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('privacy')}>
                    <span>خصوصية الحساب</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-subscriptions-heading -mx-5 px-5 pt-4 pb-1 text-xs font-semibold text-neutral-500">الاشتراكات</p>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-subscription-link" onClick={() => navigateToSettingsScreen('subscriptions')}>
                    <span className="flex items-center gap-2">
                      <span>إدارة الاشتراكات</span>
                      <span className="profile-settings-subscription-badge">مجاني</span>
                    </span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-subscription-link" onClick={() => navigateToSettingsScreen('billing')}>
                    <span>سجل الفواتير والدفع</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-subscriptions-heading -mx-5 px-5 pt-4 pb-1 text-xs font-semibold text-neutral-500">المحتوى والنشاط</p>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('archive')}>
                    <span>الأرشيف</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('saved')}>
                    <span>العناصر المحفوظة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-subscriptions-heading -mx-5 text-xs text-neutral-500 font-semibold px-5 pt-4 pb-1">التفضيلات والوسائط</p>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('notifications')}>
                    <span>الإشعارات</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('appearance')}>
                    <span>المظهر</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('language')}>
                    <span>اللغة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('media-quality')}>
                    <span>جودة الوسائط</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('font-style')}>
                    <span className="profile-settings-copy"><span className="profile-settings-label">نوع الخط</span><span className="profile-settings-description">{currentFontLabel}</span></span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-subscriptions-heading -mx-5 text-xs text-neutral-500 font-semibold px-5 pt-4 pb-1">الدعم والمعلومات</p>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row" onClick={() => navigateToSettingsScreen('support')}>
                    <span>مركز المساعدة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row" onClick={() => navigateToSettingsScreen('legal')}>
                    <span>سياسة الخصوصية وشروط الخدمة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row" onClick={() => navigateToSettingsScreen('about')}>
                    <span>عن التطبيق</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row profile-settings-logout-row" onClick={() => setShowLogoutConfirmation(true)}>
                    <span>تسجيل الخروج</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                </>
              ) : settingsScreen === 'support' ? (
                <div className="profile-settings-support-screen">
                  <p className="profile-settings-note">نحن هنا لمساعدتك. اختر الإبلاغ عن مشكلة أو تصفح الإجابات السريعة.</p>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row" onClick={() => { setSupportReport(''); navigateToSettingsScreen('report'); }}>
                    <span className="profile-settings-copy"><span className="profile-settings-label">الإبلاغ عن مشكلة</span><span className="profile-settings-description">أخبرنا بما حدث لنساعدك في حل المشكلة.</span></span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link profile-settings-support-row" onClick={() => navigateToSettingsScreen('faq')}>
                    <span className="profile-settings-copy"><span className="profile-settings-label">الأسئلة الشائعة</span><span className="profile-settings-description">إجابات حول الحساب والخصوصية واستخدام التطبيق.</span></span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                </div>
              ) : settingsScreen === 'report' ? (
                <div className="profile-settings-support-screen">
                  <p className="profile-settings-note">صف المشكلة والخطوات التي أدت إليها، وسنجهز رسالة يمكنك إرسالها إلى فريق الدعم.</p>
                  <form onSubmit={openSupportEmailDraft} className="profile-settings-field">
                    <label htmlFor="support-report-description">وصف المشكلة</label>
                    <textarea id="support-report-description" required value={supportReport} onChange={event => setSupportReport(event.target.value)} rows={6} maxLength={2000} placeholder="اكتب تفاصيل المشكلة هنا..." />
                    <button className="profile-settings-action" type="submit" disabled={!supportReport.trim()}>فتح البريد لإرسال البلاغ</button>
                  </form>
                  <p className="profile-settings-note">يفتح هذا الإجراء تطبيق البريد برسالة جاهزة. أضف عنوان فريق الدعم الرسمي قبل الإرسال.</p>
                </div>
              ) : settingsScreen === 'faq' ? (
                <div className="profile-settings-support-screen space-y-3">
                  <details className="profile-settings-support-card" open>
                    <summary>كيف أغيّر إعدادات الإشعارات والمظهر؟</summary>
                    <p>ارجع إلى الإعدادات ثم افتح قسم «التفضيلات والوسائط» لاختيار الإشعارات أو المظهر أو اللغة.</p>
                  </details>
                  <details className="profile-settings-support-card">
                    <summary>كيف أجعل حسابي خاصاً؟</summary>
                    <p>من «خصوصية الحساب» فعّل خيار الحساب الخاص. ستحتاج طلبات المتابعة الجديدة إلى موافقتك.</p>
                  </details>
                  <details className="profile-settings-support-card">
                    <summary>كيف أبلّغ عن مشكلة؟</summary>
                    <p>من مركز المساعدة اختر «الإبلاغ عن مشكلة»، واكتب وصفاً مختصراً ثم افتح رسالة البريد الجاهزة.</p>
                  </details>
                  <details className="profile-settings-support-card">
                    <summary>هل يمكنني حذف حسابي من الإعدادات؟</summary>
                    <p>يمكنك حذف حسابك وبياناته نهائياً من «إعدادات الحساب» بعد تأكيد رغبتك في الحذف.</p>
                  </details>
                </div>
              ) : settingsScreen === 'legal' ? (
                <div className="profile-settings-support-screen space-y-5">
                  <section className="profile-settings-support-card">
                    <h3>سياسة الخصوصية</h3>
                    <p>يستخدم التطبيق بيانات الحساب والملف الشخصي والمحتوى الذي تنشئه لتقديم ميزات آني الاجتماعية، مثل المنشورات والرسائل والإشعارات. تُحفظ بيانات التطبيق المرتبطة بالحساب في خدماته السحابية، بينما قد تبقى بعض تفضيلات الاستخدام على جهازك.</p>
                    <p>لا تشارك كلمة مرورك مع الآخرين، وتجنّب نشر معلومات شخصية لا ترغب في إتاحتها. استخدم أدوات الخصوصية والإبلاغ داخل التطبيق عند الحاجة.</p>
                  </section>
                  <section className="profile-settings-support-card">
                    <h3>شروط الخدمة</h3>
                    <p>باستخدام آني، توافق على احترام حقوق الآخرين وعدم نشر محتوى غير قانوني أو مضلل أو مسيء، وعدم محاولة تعطيل الخدمة أو الوصول غير المصرح به إلى الحسابات والبيانات.</p>
                    <p>أنت مسؤول عن المحتوى الذي تنشره وعن حماية بيانات الدخول إلى حسابك. قد تتغير الميزات أو تتوقف مؤقتاً لأعمال الصيانة أو لأسباب أمنية.</p>
                  </section>
                  <p className="profile-settings-note">هذه معلومات عامة داخل التطبيق وليست استشارة قانونية. راجع الشروط المحدثة عند نشرها رسمياً.</p>
                </div>
              ) : settingsScreen === 'about' ? (
                <div className="profile-settings-support-screen flex flex-col items-center justify-center text-center">
                  <div className="flex h-24 w-24 items-center justify-center rounded-[26px] bg-[#ff3c00] text-3xl font-black text-white shadow-lg" role="img" aria-label="شعار آني">آني</div>
                  <h3 className="mt-5 text-lg font-bold text-white">آني Aani</h3>
                  <p className="mt-2 text-sm text-neutral-400">تواصل اجتماعي يجمعك بمن يهمك.</p>
                  <p className="mt-6 rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-neutral-300">الإصدار v1.0.0</p>
                </div>
              ) : settingsScreen === 'account' ? (
                <>
                  <p className="profile-settings-section-title">بيانات الدخول</p>
                  <div className="profile-settings-row profile-settings-email-row" aria-readonly="true">
                    <span className="profile-settings-copy">
                      <span className="profile-settings-label">البريد الإلكتروني</span>
                      <span className="profile-settings-email-value" dir="ltr">
                        <span className="profile-settings-description">{authEmail || 'جارٍ التحميل'}</span>
                        <span className="profile-settings-provider-badge">{authProviderLabel}</span>
                      </span>
                    </span>
                  </div>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => { setPhoneDraft(authPhone); setShowPhoneModal(true); }}>
                    <span className="profile-settings-copy"><span className="profile-settings-label">رقم الهاتف</span><span className="profile-settings-description" dir="ltr">{authPhone || 'غير مضاف'}</span></span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('password')}>
                    <span>{hasPassword ? 'تغيير كلمة المرور' : 'تعيين كلمة مرور احتياطية'}</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-section-title">الأمان</p>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('security')}>
                    <span>الأمان والأجهزة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <p className="profile-settings-section-title">إدارة الحساب</p>
                  <button type="button" className="profile-settings-danger" onClick={() => setShowDeactivateAccountConfirmation(true)} disabled={!own || accountSettingsBusy}>تعطيل الحساب</button>
                  <button type="button" className="profile-settings-danger" onClick={() => { setDeleteAccountConfirmation(''); setShowDeleteAccountConfirmation(true); }}>حذف الحساب نهائياً</button>
                </>
              ) : settingsScreen === 'password' ? (
                <form onSubmit={savePasswordChange}>
                  <p className="profile-settings-note">اختر كلمة مرور لا تقل عن 6 أحرف. سيتم حفظها مباشرة دون إرسال رسالة بريد إلكتروني.</p>
                  <div className="profile-settings-field">
                    <label htmlFor="settings-password">{hasPassword ? 'كلمة المرور الجديدة' : 'كلمة المرور الاحتياطية الجديدة'}</label>
                    <input id="settings-password" type="password" autoComplete="new-password" minLength={6} required value={passwordDraft} onChange={event => setPasswordDraft(event.target.value)} />
                    <button className="profile-settings-action" type="submit" disabled={accountSettingsBusy || passwordDraft.length < 6}>{accountSettingsBusy ? 'جارٍ الحفظ...' : hasPassword ? 'تحديث كلمة المرور' : 'تعيين كلمة المرور'}</button>
                  </div>
                </form>
              ) : settingsScreen === 'security' ? (
                <>
                  <p className="profile-settings-section-title">الجلسة الحالية</p>
                  <div className="profile-settings-row profile-settings-privacy">
                    <div className="profile-settings-copy">
                      <span className="profile-settings-label">هذا الجهاز</span>
                      <span className="profile-settings-description">{currentSessionLoading ? 'جارٍ تحميل الجلسة...' : currentSessionExpiry ? `الجلسة صالحة حتى ${new Date(currentSessionExpiry * 1000).toLocaleString('ar')}` : 'تعذر قراءة بيانات الجلسة الحالية.'}</span>
                    </div>
                  </div>
                  <p className="profile-settings-note">يعرض التطبيق الجلسة الحالية فقط؛ واجهة Supabase المستخدمة لا تتيح تعداد جلسات الأجهزة الأخرى.</p>
                  <button type="button" className="profile-settings-action" disabled={accountSettingsBusy} onClick={() => void endCurrentSession()}>{accountSettingsBusy ? 'جارٍ تسجيل الخروج...' : 'تسجيل الخروج من هذا الجهاز'}</button>
                  <p className="profile-settings-section-title">المصادقة الثنائية</p>
                  <p className="profile-settings-note">إدارة العامل الثاني غير مفعّلة هنا. يتطلب تشغيلها تحديث تدفق تسجيل الدخول للتحقق من مستوى المصادقة قبل فتح الحساب.</p>
                </>
              ) : settingsScreen === 'privacy' ? (
                <>
                  <div className="profile-settings-row profile-settings-privacy">
                    <div className="profile-settings-copy">
                      <span className="profile-settings-label">خصوصية الحساب</span>
                      <span className="profile-settings-description">{person.is_private ? 'خاص — يتطلب متابعة مقبولة لعرض المحتوى' : 'عام — يمكن للجميع رؤية المحتوى العام'}</span>
                    </div>
                    <button type="button" role="switch" aria-checked={Boolean(person.is_private)} aria-label="خصوصية الحساب" onClick={() => void toggleAccountPrivacy()} disabled={privacySaving} className={`profile-settings-switch${person.is_private ? ' is-private' : ''}`}>
                      <span />
                    </button>
                  </div>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('blocked')}>
                    <span>الحسابات المحظورة</span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={() => navigateToSettingsScreen('muted')}>
                    <span className="profile-settings-copy"><span className="profile-settings-label">الحسابات المكتومة</span><span className="profile-settings-description">حسابات كتمت محادثاتها أو أُخفيت القصص عنها.</span></span>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                </>
              ) : settingsScreen === 'blocked' || settingsScreen === 'muted' ? (
                <>
                  <p className="profile-settings-note">{settingsScreen === 'blocked' ? 'إلغاء الحظر يعيد إمكانية التواصل وفق إعدادات الحساب.' : 'تظهر هنا الحسابات المكتومة في الرسائل أو المخفية عنها قصصك.'}</p>
                  {managedProfilesLoading ? <ListSkeleton count={3} compact className="px-1" /> : (settingsScreen === 'blocked' ? blockedProfiles : mutedProfiles).length ? (
                    (settingsScreen === 'blocked' ? blockedProfiles : mutedProfiles).map(managedProfile => (
                      <div key={managedProfile.id} className="profile-settings-request-card">
                        <Avatar profile={managedProfile} />
                        <UserIdentity name={displayName(managedProfile)} username={managedProfile.username} className="min-w-0 flex-1" nameClassName="text-sm text-white" usernameClassName="text-xs text-zinc-400" />
                        <button type="button" className="profile-settings-action bg-white text-black" disabled={Boolean(managedProfileBusyId)} onClick={() => settingsScreen === 'blocked' ? void unblockProfile(managedProfile.id) : void unmuteProfile(managedProfile.id)}>{settingsScreen === 'blocked' ? managedProfileBusyId === managedProfile.id ? 'جارٍ...' : 'إلغاء الحظر' : managedProfileBusyId === managedProfile.id ? 'جارٍ...' : 'إلغاء الكتم'}</button>
                      </div>
                    ))
                  ) : (
                    <p className="profile-settings-empty">{settingsScreen === 'blocked' ? 'لا توجد حسابات محظورة.' : 'لا توجد حسابات مكتومة أو مخفية.'}</p>
                  )}
                </>
              ) : settingsScreen === 'subscriptions' ? (
                <div className="profile-settings-subscription-screen">
                  <section className="profile-settings-subscription-card">
                    <div className="profile-settings-subscription-card-heading">
                      <span>الخطة الحالية</span>
                      <span className="profile-settings-subscription-badge">مجاني</span>
                    </div>
                    <p className="profile-settings-subscription-plan">الخطة المجانية</p>
                    <p className="profile-settings-note">لا يوجد اشتراك مدفوع نشط على هذا الحساب.</p>
                  </section>
                  <section>
                    <p className="profile-settings-section-title">الباقات والعروض المتاحة</p>
                    <div className="profile-settings-subscription-empty">
                      <p className="profile-settings-subscription-plan">لا توجد باقات مدفوعة متاحة حالياً</p>
                      <p className="profile-settings-note">ستظهر الباقات والعروض هنا عند تفعيل خدمة الاشتراكات.</p>
                    </div>
                  </section>
                  <div className="profile-settings-subscription-actions">
                    <button type="button" className="profile-settings-action" disabled aria-disabled="true">ترقية الاشتراك</button>
                    <button type="button" className="profile-settings-action profile-settings-secondary-action" disabled aria-disabled="true">تجديد الاشتراك</button>
                  </div>
                  <p className="profile-settings-note">خيارات الترقية والتجديد غير متاحة قبل ربط مزوّد دفع آمن.</p>
                </div>
              ) : settingsScreen === 'billing' ? (
                <div className="profile-settings-subscription-screen">
                  <div className="profile-settings-subscription-empty">
                    <p className="profile-settings-subscription-plan">لا توجد فواتير أو معاملات مالية سابقة.</p>
                    <p className="profile-settings-note">سيظهر سجل الفواتير والمدفوعات هنا بعد تفعيل خدمة الاشتراكات والدفع.</p>
                  </div>
                </div>
              ) : settingsScreen === 'archive' ? (
                <ProfileStoryArchiveView
                  userId={currentUserId}
                  onHighlightAdded={(collection, highlight) => setProfileHighlights(current => {
                    const existing = current.some(item => item.id === collection.id);
                    if (existing) {
                      return current.map(item => item.id === collection.id
                        ? { ...item, ...collection, stories: [...item.stories, highlight].sort((a, b) => a.position - b.position) }
                        : item);
                    }
                    const nextDisplayOrder = collection.display_order ?? current.reduce((maximum, item, index) => Math.max(maximum, item.display_order ?? index), -1) + 1;
                    return [...current, { ...collection, display_order: nextDisplayOrder, stories: [highlight] }]
                      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.created_at.localeCompare(b.created_at));
                  })}
                />
              ) : settingsScreen === 'saved' ? (
                <SavedPostsView currentUserId={currentUserId} onOpenComments={onOpenComments} />
              ) : settingsScreen === 'notifications' || settingsScreen === 'appearance' || settingsScreen === 'language' || settingsScreen === 'media-quality' || settingsScreen === 'font-style' ? (
                <ProfileSettingsPreferences
                  key={currentUserId}
                  currentUserId={currentUserId}
                  profile={person}
                  onProfileUpdate={nextProfile => {
                    setPerson(nextProfile);
                    onProfileUpdate(nextProfile);
                  }}
                  screen={settingsScreen}
                />
              ) : null}
            </div>
          </section>
          {showLogoutConfirmation && (
            <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onClick={event => { event.stopPropagation(); setShowLogoutConfirmation(false); }}>
              <section role="alertdialog" aria-modal="true" aria-labelledby="logout-confirmation-title" aria-describedby="logout-confirmation-description" className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a0a] p-5 text-white shadow-2xl" onClick={event => event.stopPropagation()}>
                <h3 id="logout-confirmation-title" className="text-base font-bold">تأكيد تسجيل الخروج</h3>
                <p id="logout-confirmation-description" className="mt-2 text-sm leading-6 text-neutral-400">هل تريد تسجيل الخروج من هذا الجهاز؟ ستحتاج إلى تسجيل الدخول مجدداً للعودة إلى حسابك.</p>
                <div className="mt-6 flex gap-3">
                  <button type="button" className="flex-1 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10" onClick={() => setShowLogoutConfirmation(false)}>إلغاء</button>
                  <button type="button" className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60" disabled={accountSettingsBusy} onClick={() => void endCurrentSession()}>{accountSettingsBusy ? 'جارٍ تسجيل الخروج...' : 'تسجيل الخروج'}</button>
                </div>
              </section>
            </div>
          )}
          {showPhoneModal && (
            <div className="profile-settings-dialog-backdrop" onClick={() => { if (!accountSettingsBusy) setShowPhoneModal(false); }}>
              <section role="dialog" aria-modal="true" aria-labelledby="phone-modal-title" className="profile-settings-dialog" onClick={event => event.stopPropagation()}>
                <h3 id="phone-modal-title">تحديث رقم الهاتف</h3>
                <p className="profile-settings-note">أدخل الرقم بالصيغة الدولية. سيتم حفظه مباشرة دون رمز SMS.</p>
                <form onSubmit={savePhoneChange}>
                  <div className="profile-settings-field">
                    <label htmlFor="settings-phone">رقم الهاتف</label>
                    <input id="settings-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+9665XXXXXXXX" maxLength={20} required value={phoneDraft} onChange={event => setPhoneDraft(event.target.value)} />
                  </div>
                  <div className="profile-settings-dialog-actions">
                    <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={() => setShowPhoneModal(false)}>إلغاء</button>
                    <button className="profile-settings-action" type="submit" disabled={accountSettingsBusy || !phoneDraft.trim() || phoneDraft.trim() === authPhone}>{accountSettingsBusy ? 'جارٍ الحفظ...' : 'حفظ الرقم'}</button>
                  </div>
                </form>
              </section>
            </div>
          )}
          {showDeactivateAccountConfirmation && (
            <div className="profile-settings-dialog-backdrop" onClick={() => { if (!accountSettingsBusy) setShowDeactivateAccountConfirmation(false); }}>
              <section role="alertdialog" aria-modal="true" aria-labelledby="deactivate-account-title" aria-describedby="deactivate-account-description" className="profile-settings-dialog" onClick={event => event.stopPropagation()}>
                <h3 id="deactivate-account-title">تعطيل الحساب مؤقتاً</h3>
                <p id="deactivate-account-description" className="profile-settings-note">هل أنت متأكد من تعطيل حسابك مؤقتاً؟ سيتم تسجيل خروجك، ويمكنك إعادة تفعيل الحساب بتسجيل الدخول مجدداً.</p>
                <div className="profile-settings-dialog-actions">
                  <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={() => setShowDeactivateAccountConfirmation(false)}>إلغاء</button>
                  <button type="button" className="profile-settings-action" disabled={accountSettingsBusy} onClick={() => void deactivateAccountTemporarily()}>{accountSettingsBusy ? 'جارٍ التعطيل...' : 'تعطيل مؤقتاً'}</button>
                </div>
              </section>
            </div>
          )}
          {showDeleteAccountConfirmation && (
            <div className="profile-settings-dialog-backdrop" onClick={() => { if (!accountSettingsBusy) setShowDeleteAccountConfirmation(false); }}>
              <section role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-description" className="profile-settings-dialog" onClick={event => event.stopPropagation()}>
                <h3 id="delete-account-title">حذف الحساب نهائياً</h3>
                <p id="delete-account-description" className="profile-settings-note">سيؤدي هذا إلى حذف حسابك وبياناته ومحتواه وملفاته نهائياً. لا يمكن التراجع عن هذا الإجراء.</p>
                <div className="profile-settings-field">
                  <label htmlFor="delete-account-confirmation">اكتب «حذف» للتأكيد</label>
                  <input id="delete-account-confirmation" type="text" autoComplete="off" value={deleteAccountConfirmation} onChange={event => setDeleteAccountConfirmation(event.target.value)} />
                </div>
                <div className="profile-settings-dialog-actions">
                  <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={() => setShowDeleteAccountConfirmation(false)}>إلغاء</button>
                  <button type="button" className="profile-settings-dialog-delete" disabled={accountSettingsBusy || deleteAccountConfirmation.trim() !== 'حذف'} onClick={() => void deleteAccountPermanently()}>{accountSettingsBusy ? 'جارٍ الحذف...' : 'حذف نهائياً'}</button>
                </div>
              </section>
            </div>
          )}
        </div>,
        document.body,
      )}

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
          <div className="relative -mt-11 h-[82px] w-[82px] shrink-0">
            <span className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border-4 border-black">
              {avatarPreview ? (
                <img src={avatarPreview} className="h-full w-full rounded-full object-cover" alt="" />
              ) : (
                <span className="flex h-full w-full items-center justify-center rounded-full bg-neutral-800">
                  <svg className="h-8 w-8 text-neutral-400" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                </span>
              )}
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
          <div dir="rtl" className="flex items-center gap-2 text-xs sm:gap-3 sm:text-sm">
            <div className="whitespace-nowrap"><span className="font-bold text-white">{formattedPostCount}</span> <span className="text-[#71767B]">المنشورات</span></div>
            <div className="whitespace-nowrap"><span className="font-bold text-white">{formattedFollowing}</span> <span className="text-[#71767B]">متابع</span></div>
            <div className="whitespace-nowrap"><span className="font-bold text-white">{formattedFollowers}</span> <span className="text-[#71767B]">المتابعون</span></div>
          </div>
        </div>

        <div id="bioSection" className="mb-3 mt-2">
          {person.bio?.trim() && <p id="bioText" className="whitespace-pre-line text-[15px] leading-relaxed text-[#F7F9F9]">{person.bio}</p>}
        </div>

        {(showPublicCity && profileCity || showPublicJob || showPublicBirthDate || profileWebsiteUrl) && (
          <div className="profile-public-meta" aria-label="معلومات الملف الشخصي">
            {showPublicJob && (
              <span className="profile-public-meta-item"><Briefcase aria-hidden="true" />{profileJob}</span>
            )}
            {showPublicCity && profileCity && (
              <span className="profile-public-meta-item"><MapPin aria-hidden="true" />{profileCity}</span>
            )}
            {showPublicBirthDate && (
              <span className="profile-public-meta-item"><Cake aria-hidden="true" />{formattedBirthDate}</span>
            )}
            {profileWebsiteUrl && (
              <a href={profileWebsiteUrl} target="_blank" rel="noreferrer" className="profile-public-meta-item text-[#1D9BF0] hover:underline">
                <svg className="h-[15px] w-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
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

      <ProfileTabs activeTab={profileContentTab} onChange={setProfileContentTab} />

      {loading && (
        <GridSkeleton count={9} className="mt-4 gap-[2px] rounded-none" />
      )}
      {profileContentTab === 'tagged' && taggedLoading && (
        <GridSkeleton count={9} className="mt-4 gap-[2px] rounded-none" />
      )}
      {!loading && error && (
        <div className="mt-4 px-4">
          <div role="alert" className="rounded-xl border border-[#2F3336] bg-neutral-900 p-5 text-center text-sm text-zinc-300">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()} className="mt-3 rounded-full bg-white px-4 py-2 font-semibold text-black">إعادة المحاولة</button>
          </div>
        </div>
      )}
      {!loading && !error && posts.length === 0 && profileContentTab !== 'tagged' && (
        <div className="mt-4 grid grid-cols-3 gap-[2px] bg-black">
          {Array.from({ length: 9 }, (_, index) => <div key={`empty-${index}`} className="aspect-[4/5] bg-neutral-900" />)}
        </div>
      )}
      {!loading && !error && (posts.length > 0 || profileContentTab === 'tagged') && (() => {
        // شبكة إنستغرام: 3 أعمدة — الصور والفيديوهات والريلز فقط،
        // والمنشورات الكتابية (text) مستبعدة كلياً من الشبكة.
        // تبويب الفيديوهات: نفس الشبكة والحجم بالضبط لكن بقائمة
        // الفيديوهات فقط (ريلز + فيديوهات التغذية) بترتيبها الزمني.
        const mediaPosts = profileContentTab === 'videos'
          ? profileVideoPosts
          : profileContentTab === 'reposts'
            ? profileReposts
            : profileContentTab === 'tagged'
              ? taggedPosts
              : displayProfilePosts.filter(post => post.type !== 'text');
        if (!mediaPosts.length) {
          const emptyMessage = profileContentTab === 'videos'
            ? 'لا توجد فيديوهات منشورة.'
            : profileContentTab === 'reposts'
              ? 'لا توجد إعادات نشر بعد.'
              : profileContentTab === 'tagged'
                ? 'لا توجد منشورات تمت الإشارة إليك فيها بعد'
                : 'لا توجد صور أو فيديوهات منشورة.';
          if (profileContentTab === 'tagged' && taggedError) {
            return <p role="alert" className="mt-6 text-center text-sm text-rose-300">{taggedError}</p>;
          }
          return <p className="mt-6 text-center text-sm text-zinc-400">{emptyMessage}</p>;
        }
        return (
          <div className="mt-4 grid grid-cols-3 gap-[2px] bg-black content-fade-in">
            {mediaPosts.map(post => {
              const isReel = post.type === 'reel' || getPostDestination(post) === 'reels';
              const mediaUrls = post.media_urls?.length ? post.media_urls : post.media_url ? [post.media_url] : [];
              const cover = mediaUrls[0] || '';
              // الغلاف المختار عند النشر: صورة خفيفة تُعرض بدل عنصر الفيديو
              const postCoverUrl = getPostCoverUrl(post);
              const isMultiImage = mediaUrls.length > 1;
              return (
                <button
                  key={post.id}
                  type="button"
                  onClick={() => {
                    if (profileContentTab === 'videos') {
                      // من تبويب الفيديوهات: كل الفيديوهات تفتح مشغل
                      // الريلز الكامل متسلسلاً بين فيديوهات هذا التبويب.
                      setReelsPlayerSource('videos');
                      setReelsPlayerPostId(post.id);
                    } else if (profileContentTab === 'reposts') {
                      // من تبويب الريبوست: ريلز → مشغل الريلز محصوراً
                      // بريلوزات الريبوست، وغيرها → التغذية بين ريبوستاته.
                      if (isProfileReel(post)) {
                        setReelsPlayerSource('reposts');
                        setReelsPlayerPostId(post.id);
                      } else {
                        setFeedViewerSource('reposts');
                        setFeedViewerPostId(post.id);
                      }
                    } else if (profileContentTab === 'tagged') {
                      // من تبويب الإشارات: ريلز → مشغل الريلز بين المشار
                      // فيها، وغيرها (صور/نصوص/فيديو تغذية) → التغذية الكاملة.
                      if (isProfileReel(post)) {
                        setReelsPlayerSource('tagged');
                        setReelsPlayerPostId(post.id);
                      } else {
                        setFeedViewerSource('tagged');
                        setFeedViewerPostId(post.id);
                      }
                    } else if (isProfileReel(post)) {
                      setReelsPlayerSource('grid');
                      setReelsPlayerPostId(post.id);
                    } else {
                      setFeedViewerSource('grid');
                      setFeedViewerPostId(post.id);
                    }
                  }}
                  aria-label={profileContentTab !== 'posts' || isReel ? 'فتح الريل في عارض الملف الشخصي' : 'فتح المنشور في عارض الملف الشخصي'}
                  className="relative block aspect-[4/5] overflow-hidden bg-neutral-900 transition-transform duration-150 active:scale-[0.985]"
                >
                  {isReel ? (
                    postCoverUrl ? (
                      <img
                        src={thumbnailUrl(postCoverUrl)}
                        alt={post.content.slice(0, 80)}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                        onError={event => {
                          // فشل تحويل المصغّرة → الرجوع لرابط الغلاف الأصلي
                          const image = event.currentTarget;
                          if (image.dataset.fallback !== '1') {
                            image.dataset.fallback = '1';
                            image.src = postCoverUrl;
                          }
                        }}
                      />
                    ) : cover ? (
                      <video src={cover} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-neutral-600"><Play size={28} aria-hidden="true" /></span>
                    )
                  ) : cover ? (
                    <img
                      src={thumbnailUrl(cover)}
                      alt={post.content.slice(0, 80)}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                      onError={event => {
                        // فشل تحويل المصغّرة → الرجوع للرابط الأصلي كامل الدقة
                        const image = event.currentTarget;
                        if (image.dataset.fallback !== '1') {
                          image.dataset.fallback = '1';
                          image.src = cover;
                        }
                      }}
                    />
                  ) : post.type === 'text' ? (
                    <span className="flex h-full w-full items-center justify-center overflow-hidden p-2 text-center text-[11px] leading-5 text-neutral-200">
                      {post.content?.slice(0, 90) || 'منشور'}
                    </span>
                  ) : (
                    <span className="grid h-full w-full place-items-center text-neutral-600"><Camera size={24} aria-hidden="true" /></span>
                  )}
                  {isReel && (
                    <span aria-hidden="true" className="absolute right-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="4" width="20" height="16" rx="4" /><path d="M10 9.2v5.6a.8.8 0 0 0 1.22.68l4.4-2.8a.8.8 0 0 0 0-1.36l-4.4-2.8A.8.8 0 0 0 10 9.2Z" fill="black" /></svg>
                    </span>
                  )}
                  {profileContentTab === 'reposts' && (
                    <span aria-hidden="true" className="absolute left-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    </span>
                  )}
                  {post.type === 'text' && (
                    <span aria-hidden="true" className="absolute right-2 top-2 z-[2] rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">نص</span>
                  )}
                  {isMultiImage && (
                    <Copy size={16} aria-hidden="true" fill="white" className="absolute left-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                  )}
                </button>
              );
            })}
          </div>
        );
      })()}
      {feedViewerPostId && (feedViewerSource === 'reposts'
        ? profileReposts.some(post => post.id === feedViewerPostId && !isProfileReel(post))
        : feedViewerSource === 'tagged'
          ? taggedPosts.some(post => post.id === feedViewerPostId && !isProfileReel(post))
          : displayProfilePosts.some(post => post.id === feedViewerPostId && post.type !== 'text' && !isProfileReel(post))) && (
        <ProfileFeedViewer
          posts={feedViewerSource === 'reposts'
            ? profileReposts.filter(post => !isProfileReel(post))
            : feedViewerSource === 'tagged'
              ? taggedPosts.filter(post => !isProfileReel(post))
              : displayProfilePosts.filter(post => post.type !== 'text' && !isProfileReel(post))}
          initialPostId={feedViewerPostId}
          currentUserId={currentUserId}
          onOpenComments={onOpenComments}
          onRefresh={() => void refresh()}
          onClose={() => setFeedViewerPostId(null)}
        />
      )}
      {reelsPlayerPostId && (reelsPlayerSource === 'videos'
        ? profileVideoPosts.some(post => post.id === reelsPlayerPostId)
        : reelsPlayerSource === 'reposts'
          ? profileReposts.some(post => post.id === reelsPlayerPostId && isProfileReel(post))
          : reelsPlayerSource === 'tagged'
            ? taggedPosts.some(post => post.id === reelsPlayerPostId && isProfileReel(post))
            : displayProfilePosts.some(post => post.id === reelsPlayerPostId && isProfileReel(post))) && (
        <ProfileReelsPlayer
          reels={reelsPlayerSource === 'videos'
            ? profileVideoPosts
            : reelsPlayerSource === 'reposts'
              ? profileReposts.filter(isProfileReel)
              : reelsPlayerSource === 'tagged'
                ? taggedPosts.filter(isProfileReel)
                : displayProfilePosts.filter(isProfileReel)}
          profileUserId={activeUserId}
          initialReelId={reelsPlayerPostId}
          currentUserId={currentUserId}
          onOpenComments={onOpenComments}
          onRefresh={() => void refresh()}
          onClose={() => setReelsPlayerPostId(null)}
          trailingAccountControl={own ? undefined : (
            <button
              type="button"
              onClick={() => void toggleFollow()}
              disabled={profileActionBusy}
              className="ms-auto shrink-0 rounded-full border border-white/50 px-3 py-1 text-[11px] font-bold text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              {isFollowing ? 'أتابع' : followRequestSent ? 'طلب مرسل' : 'متابعة'}
            </button>
          )}
        />
      )}
      <ProfileHighlightsManager
        open={showHighlightsManager}
        onClose={() => setShowHighlightsManager(false)}
        userId={currentUserId}
        ownerName={person ? displayName(person) : ''}
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
          const nextDisplayOrder = collection.display_order ?? current.reduce((maximum, item, index) => Math.max(maximum, item.display_order ?? index), -1) + 1;
          return [...current, { ...collection, display_order: nextDisplayOrder, stories: [highlight] }]
            .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.created_at.localeCompare(b.created_at));
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
          ownerName={person ? displayName(person) : ''}
          ownerAvatarUrl={person?.avatar_url || null}
        />
      )}
    </section>
  );
}
