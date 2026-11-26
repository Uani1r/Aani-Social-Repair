import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Briefcase, Cake, Camera, Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, Flag, Lock, MapPin, MessageCircle, Play, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { toast } from 'sonner';
import FollowButton from '@/components/FollowButton';
import PopularityGiftsSheet from '@/components/PopularityGiftsSheet';
import { setFollowState } from '@/lib/followState';
import { fetchPopularity, formatPopularity } from '@/lib/gifts';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import Avatar from '@/components/Avatar';
import FeedPostCard from '@/components/FeedPostCard';
import ProfileFeedViewer from '@/components/ProfileFeedViewer';
import ProfileReelsPlayer from '@/components/ProfileReelsPlayer';
import { ListSkeleton, ProfileSkeleton, GridSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import ProfileStoryArchiveView from '@/components/ProfileStoryArchiveView';
import ProfileSettingsPreferences, { type ProfileSettingsPreferenceScreen } from '@/components/ProfileSettingsPreferences';
import SavedPostsView from '@/components/SavedPostsView';
import HighlightCoverCropper from '@/components/HighlightCoverCropper';
import UserIdentity from '@/components/UserIdentity';
import { ProfileHighlightStoryStrip, ProfileHighlightsRow, ProfileMediaGrid, type ReorderBinding } from '@/components/profile/ProfileContentPreview';
import { usePosts } from '@/hooks/usePosts';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { useSeenStoryIds } from '@/lib/seenStories';
import { uploadMedia } from '@/lib/storyUpload';
import ProfileHighlightsManager, { ProfileHighlightViewer, type ProfileHighlight, type ProfileHighlightCollection, type ProfileHighlightCollectionSummary } from '@/components/ProfileHighlightsManager';
import { cleanUsername, displayName, getPostCoverUrl, getPostDestination, normalizePostMetadata, type Post, type Profile } from '@/lib/types';
import { fetchConditionalProfileFields, fetchMyPreferences, PUBLIC_PROFILE_COLUMNS, type PublicProfileRow } from '@/lib/profileFields';
import {
  accountAuthErrorMessage,
  DEFAULT_PHONE_COUNTRY_CODE,
  formatPhoneForDisplay,
  MIN_PASSWORD_LENGTH,
  normalizePhoneToE164,
  providerBadgeLabel,
  readAccountAuthIdentity,
} from '@/lib/accountAuth';
import { useMediaUrl } from '@/lib/mediaAccess';
import { SignedImage } from '@/components/SignedMedia';
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

// امتدادات الصور المقبولة من iPhone: HEIC/HEIF تصل من الكاميرا/مكتبة الصور،
// وبعض الاختيارات من «الملفات» تصل بنوع MIME فارغ أو application/octet-stream
// مع امتداد صورة صحيح فقط.
const PICKED_IMAGE_EXTENSION = /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;
const HEIC_MIME = /^image\/(heic|heif|heics|heifs)$/i;
const GENERIC_BINARY_MIME = /^(application\/(octet-stream|x-octet-stream)|binary\/octet-stream)$/i;
const JPEG_FILE = /\.jpe?g$/i;
/** مهلة تجهيز الصورة: لا تُترك الواجهة معلقة بلا نهاية. */
const PICKED_IMAGE_TIMEOUT_MS = 8_000;
const PICKED_IMAGE_MAX_SIDE = 1_600;

function hasPickedImageExtension(name: string | undefined): boolean {
  return PICKED_IMAGE_EXTENSION.test(name || '');
}

/**
 * هل الاختيار صورة؟ صورة صريحة (image/*)، أو نوع ثنائي عام/فارغ مع امتداد صورة
 * معروف. امتدادٌ وحده لا يكفي لنوع غير ثنائي، فلا تُمرَّر ملفات غير صور إلى القص.
 */
function isPickedImage(file: File): boolean {
  const type = (file.type || '').toLowerCase().trim();
  if (IMAGE_MIME.test(type)) return true;
  const genericType = !type || GENERIC_BINARY_MIME.test(type);
  return genericType && hasPickedImageExtension(file.name);
}

/** اتجاه EXIF لملف JPEG (1 عند غياب EXIF أو تعذّر قراءته) — قراءة فقط، بلا تعديل. */
async function readJpegExifOrientation(file: File): Promise<number> {
  const type = (file.type || '').toLowerCase();
  if (!JPEG_FILE.test(file.name || '') && !/^image\/jpe?g$/.test(type)) return 1;
  try {
    const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset, false);
      if ((marker & 0xff00) !== 0xff00) return 1;
      const length = view.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > view.byteLength) return 1;
      const isExif = marker === 0xffe1
        && length >= 8
        && view.getUint32(offset + 4, false) === 0x45786966; // "Exif"
      if (isExif) {
        const tiff = offset + 10;
        if (tiff + 8 > view.byteLength) return 1;
        const littleEndian = view.getUint16(tiff, false) === 0x4949;
        const ifdStart = tiff + view.getUint32(tiff + 4, littleEndian);
        if (ifdStart + 2 > view.byteLength) return 1;
        const count = view.getUint16(ifdStart, littleEndian);
        for (let index = 0; index < count; index += 1) {
          const entry = ifdStart + 2 + index * 12;
          if (entry + 12 > view.byteLength) return 1;
          if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
          const value = view.getUint16(entry + 8, littleEndian);
          return value >= 1 && value <= 8 ? value : 1;
        }
        return 1;
      }
      offset += 2 + length;
    }
  } catch {
    // ترويسة غير قابلة للقراءة: لا تصحيح، والصورة تبقى كما هي.
  }
  return 1;
}

type DecodedPickedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
};

/**
 * فك ترميز الصورة مع اتجاه EXIF: createImageBitmap({ imageOrientation: 'from-image' })
 * أولاً (بكسلات مستقيمة)، ومسار <img> احتياطي عندما لا يُدعم الخيار أو الصيغة.
 */
async function decodePickedImage(file: File): Promise<DecodedPickedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const options = { imageOrientation: 'from-image' } as unknown as ImageBitmapOptions;
      const bitmap = await createImageBitmap(file, options);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      }
      bitmap.close();
    } catch {
      // خيار غير مدعوم أو صيغة غير قابلة للفك هنا: يُجرَّب مسار <img>.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('تعذر فتح الصورة على هذا الجهاز. اختر صورة JPEG أو PNG.'));
    };
    element.src = objectUrl;
  });
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => URL.revokeObjectURL(objectUrl),
  };
}

/**
 * يجهّز الصورة قبل القص: HEIC/HEIF والثنائي العام وJPEG ذو اتجاه EXIF غير طبيعي
 * تُحوَّل إلى JPEG مستقيم بلا EXIF، فتتطابق المعاينة مع المصدَّر ولا تتكرر إعادة
 * الترميز لصورة مستقيمة أصلاً (EXIF = 1 تُمرَّر كما هي).
 */
async function normalizePickedImage(file: File): Promise<File> {
  const type = (file.type || '').toLowerCase();
  const orientation = await readJpegExifOrientation(file);
  const needsConversion = HEIC_MIME.test(type)
    || !type
    || GENERIC_BINARY_MIME.test(type)
    || orientation !== 1;
  if (!needsConversion) return file;

  let timedOut = false;
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true;
      reject(new Error('استغرق تجهيز الصورة وقتاً طويلاً. جرّب صورة JPEG أو PNG أصغر.'));
    }, PICKED_IMAGE_TIMEOUT_MS);
  });

  // فك ترميز يصل بعد انتهاء المهلة يُغلق موارده بنفسه بدل تسريبها.
  const decodePromise = decodePickedImage(file);
  void decodePromise
    .then(result => { if (timedOut) result.close?.(); })
    .catch(() => undefined);

  try {
    const decoded = await Promise.race([decodePromise, timeout]);
    try {
      const longest = Math.max(decoded.width, decoded.height) || 1;
      const scale = Math.min(1, PICKED_IMAGE_MAX_SIDE / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة.');
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          value => value ? resolve(value) : reject(new Error('تعذر تجهيز الصورة.')),
          'image/jpeg',
          0.92,
        );
      });
      const baseName = (file.name || 'avatar').replace(/\.[^.]+$/, '') || 'avatar';
      return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
      decoded.close?.();
    }
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function VerifiedBadge() {
  return (
    <svg className="h-5 w-5 shrink-0 text-[#1D9BF0]" viewBox="0 0 24 24" aria-label="حساب موثّق" role="img">
      <path fill="currentColor" d="M12 1.6 15.1 3l3.3-.3 1.1 3.1 2.7 1.8-.9 3.2.9 3.2-2.7 1.8-1.1 3.1-3.3-.3-3.1 1.4-3.1-1.4-3.3.3-1.1-3.1-2.7-1.8.9-3.2-.9-3.2 2.7-1.8 1.1-3.1 3.3.3L12 1.6Z" />
      <path d="m7.3 12.2 3 3 6.5-6.5" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

// ضغط مطوّل على صورة الملف الشخصي: مدة الضغط، وعتبة الحركة (بكسل) التي تُلغيه.
const AVATAR_LONG_PRESS_MS = 480;
const AVATAR_PRESS_MOVE_TOLERANCE = 10;

/**
 * معاينة صورة الملف الشخصي (ضغط مطوّل): طبقة مستقلة على document.body —
 * خلفية داكنة مموّهة من الصورة نفسها، وصورة دائرية كبيرة (1/1 و object-cover)
 * بلا تشويه. لا تفتح الستوري ولا تغيّر المسار: الإغلاق (خارج الصورة أو Escape
 * أو زر X) يعيد المستخدم إلى الملف الشخصي نفسه، والتمرير خلفها مقفل بالـhook
 * المشترك ويُعاد إلى حالته السابقة عند الإغلاق.
 */
function ProfileAvatarLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useModalBodyScrollLock();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // إغلاق واحد فقط: أثناء الاختفاء لا يُعاد تشغيل المؤقت ولا يُستدعى الإغلاق مرتين.
  const requestCloseRef = useRef<() => void>(() => {});
  requestCloseRef.current = () => {
    if (closeTimerRef.current !== null) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onCloseRef.current();
    }, 140);
  };

  // زر الرجوع في الهاتف يغلق المعاينة بدل مغادرة صفحة الملف الشخصي.
  useOverlayBack(true, () => requestCloseRef.current());

  // Escape يغلق المعاينة؛ المستمع يُزال مع المكوّن.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // مغادرة المكوّن تُلغي أي مؤقت إغلاق معلّق.
  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  return (
    <div
      className={`profile-avatar-lightbox${closing ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`صورة ${alt}`}
      onClick={event => { if (event.target === event.currentTarget) requestCloseRef.current(); }}
    >
      <div className="profile-avatar-lightbox-backdrop" aria-hidden="true">
        <img src={src} alt="" draggable={false} />
      </div>
      <figure className="profile-avatar-lightbox-frame">
        <img className="profile-avatar-lightbox-image" src={src} alt={`صورة ${alt}`} draggable={false} />
      </figure>
      <button
        type="button"
        className="profile-avatar-lightbox-close"
        aria-label="إغلاق معاينة الصورة"
        onClick={() => requestCloseRef.current()}
      >
        <X size={22} aria-hidden="true" />
      </button>
    </div>
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

// أنواع إعادة الترتيب: المنشورات، مجموعات أبرز القصص، والقصص داخل مجموعة.
type ProfileReorderKind = 'highlights' | 'posts' | 'stories';

// حجم صفحة ثابت لجلب مجموعات أبرز القصص وقصصها كاملة عبر .range — بلا حد
// نهائي يُسقط صفوفاً ويجعل قائمة المعاينة جزئية.
const PAGE_SIZE = 250;

// حماية من استجابة تتجاهل range: خطأ صريح بدل قائمة جزئية أو حلقة لا تنتهي.
const MAX_PAGES = 400;

// تسمية نوع العنصر في إعلان قارئ الشاشة بعد التحريك.
const PROFILE_REORDER_LABELS: Record<ProfileReorderKind, string> = {
  posts: 'المنشور',
  highlights: 'المجموعة',
  stories: 'القصة',
};

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
  // حالة المشاهدة من نفس مصدر شريط القصص (localStorage + حدثه) بلا حالة موازية.
  const seenStoryIds = useSeenStoryIds(currentUserId);

  const [person, setPerson] = useState<Profile | null>(own ? profile : null);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followRequestSent, setFollowRequestSent] = useState(false);
  // هل الشخص الذي أزور ملفه يتابعني؟ يُستخدم لإظهار زر «رد المتابعة»
  const [followsMe, setFollowsMe] = useState(false);
  const [profileHighlights, setProfileHighlights] = useState<ProfileHighlightCollection[]>([]);
  const [showProfileReorder, setShowProfileReorder] = useState(false);
  const [profilePostOrder, setProfilePostOrder] = useState<string[]>([]);
  const [profileReorderSaving, setProfileReorderSaving] = useState(false);
  // نص يُعلن لقارئ الشاشة موضع العنصر بعد التحريك أو السحب (aria-live).
  const [profileReorderAnnouncement, setProfileReorderAnnouncement] = useState('');
  // هل حُمّلت كل صفحات أبرز القصص وقصصها بلا فشل؟ لا حفظ بترتيب جزئي قبل ذلك.
  const [profileHighlightsComplete, setProfileHighlightsComplete] = useState(false);
  // المجموعة المفتوحة داخل شاشة الترتيب لعرض قصصها الداخلية وترتيبها.
  const [reorderStoriesCollectionId, setReorderStoriesCollectionId] = useState<string | null>(null);
  const reorderStoriesCollection = reorderStoriesCollectionId
    ? profileHighlights.find(collection => collection.id === reorderStoriesCollectionId) ?? null
    : null;
  const [draggingReorderKey, setDraggingReorderKey] = useState<string | null>(null);
  const [dragOverReorderKey, setDragOverReorderKey] = useState<string | null>(null);
  const profileReorderGestureRef = useRef<ProfileReorderGesture | null>(null);
  // نقرة المتصفح التي تأتي بعد كل سحب فعلي: تُستهلك كي لا تفتح العنصر.
  const profileReorderDragConsumedClickRef = useRef(false);
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
  // إجمالي الشعبية يُجلب عبر استعلام خفيف من دالة RPC آمنة في الخادم (مجموع نقاط الهدايا المستلمة).
  const [popularity, setPopularity] = useState<number | null>(null);
  const [showPopularitySheet, setShowPopularitySheet] = useState(false);
  // قصص صاحب هذا الملف النشطة: تُستخدم لحلقة الصورة في الرأس فقط.
  const [profileStoryIds, setProfileStoryIds] = useState<string[]>([]);
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
  // تأكيد Supabase لرقم الهاتف فقط (phone_confirmed_at) — لا يُعرض الرقم
  // مؤكداً قبل نجاح التحقق.
  const [authPhoneVerified, setAuthPhoneVerified] = useState(false);
  // تغيير الهاتف على مرحلتين: طلب رمز SMS ثم تأكيده. لا تُرسَل قيم OTP إلى
  // أي جدول ولا تُطبع في السجلات.
  const [phoneChangeStep, setPhoneChangeStep] = useState<'request' | 'verify'>('request');
  const [phoneChangeTarget, setPhoneChangeTarget] = useState('');
  const [phoneOtpCode, setPhoneOtpCode] = useState('');
  // كلمة المرور الحالية والجديدة وتأكيدها — تُمرَّر إلى Supabase مباشرة فقط.
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState('');
  const [passwordConfirmDraft, setPasswordConfirmDraft] = useState('');
  // أُرسل رابط تحقق إلى البريد لتعيين كلمة مرور لحساب Google/Apple.
  const [passwordReauthSent, setPasswordReauthSent] = useState(false);
  // يمنع طلبات تغيير الهاتف المتزامنة (Supabase يحذّر من طلبات phone_change
  // متزامنة قد تربط رقماً غير مقصود).
  const phoneChangeInFlightRef = useRef(false);
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
  // صورة الملف والغلاف قد تكونان في bucket خاص: تُحوَّلان إلى رابط موقّع،
  // ويبقى الرابط الأصلي معروضاً حتى يصل الموقّع. معاينات التحرير (blob:) تمرّ كما هي.
  const resolvedAvatarPreview = useMediaUrl(avatarPreview);
  const resolvedCoverPreview = useMediaUrl(coverPreview);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  // تجهيز صورة (فك HEIC/تحويل) جارٍ: يمنع الحفظ وإغلاق شاشة التعديل حتى ينتهي.
  const [avatarProcessing, setAvatarProcessing] = useState(false);
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
  // رقم آخر اختيار صورة: نتيجة أي اختيار أقدم تُهمل ولا تفتح قصاصة ولا تستبدل المعاينة.
  const avatarPickRequestRef = useRef(0);
  // قفل حفظ متزامن: مرجع لا حالة، فلا يمرّ نقران في الدورة نفسها.
  const saveInFlightRef = useRef(false);
  // معاينة صورة الملف الشخصي (ضغط مطوّل): رابط الصورة المعروض، أو null.
  const [avatarLightboxSrc, setAvatarLightboxSrc] = useState<string | null>(null);
  // ضغط مطوّل: مؤقت واحد، نقطة بداية اللمس، وعلم منع النقرة التالية (فلا يُفتح الستوري).
  const avatarLongPressTimerRef = useRef<number | null>(null);
  const avatarPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const avatarLongPressHandledRef = useRef(false);

  // إغلاق شاشة التعديل يُبطل أي تجهيز صورة جارٍ، فلا تُفتح قصاصة بعد الإغلاق.
  useEffect(() => {
    if (isEditingProfile) return;
    avatarPickRequestRef.current += 1;
    setAvatarProcessing(false);
    setAvatarCropFile(null);
  }, [isEditingProfile]);

  // فتح شاشة التعديل يلغي أي ضغط مطوّل جارٍ ويغلق المعاينة، فلا تتعارض مع زر الكاميرا.
  useEffect(() => {
    if (!isEditingProfile) return;
    if (avatarLongPressTimerRef.current !== null) {
      window.clearTimeout(avatarLongPressTimerRef.current);
      avatarLongPressTimerRef.current = null;
    }
    avatarPressOriginRef.current = null;
    setAvatarLightboxSrc(null);
  }, [isEditingProfile]);

  // مغادرة الصفحة تُلغي مؤقت الضغط المطوّل، فلا يبقى مؤقت معلّق.
  useEffect(() => () => {
    if (avatarLongPressTimerRef.current !== null) {
      window.clearTimeout(avatarLongPressTimerRef.current);
      avatarLongPressTimerRef.current = null;
    }
  }, []);
  const [, setLocation] = useLocation();

  const fromSearch = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'search';
  const pageDirection = typeof document !== 'undefined' && document.documentElement.dir === 'ltr' ? 'ltr' : 'rtl';
  const { posts, loading, refresh, error, repostsError } = usePosts('profile', activeUserId, currentUserId);
  const safeProfilePosts = Array.isArray(posts) ? posts : [];
  const ownProfilePosts = safeProfilePosts.filter(post => post.user_id === activeUserId && !post.reposter_id);
  const orderedEditablePosts = orderOwnedPostsInProfileSlots(ownProfilePosts, activeUserId, Array.isArray(profilePostOrder) ? profilePostOrder : []);
  const displayProfilePosts = orderOwnedPostsInProfileSlots(safeProfilePosts, activeUserId, Array.isArray(profilePostOrder) ? profilePostOrder : []);
  // معاينة شبكة التعديل: نفس قائمة شبكة Profile الفعلية (بلا المنشورات النصية).
  // إعادات نشر الآخرين تظهر في مواقعها بلا سحب، والمنشورات المملوكة وحدها تُسحب.
  const reorderPreviewPosts = displayProfilePosts.filter(post => post.type !== 'text');
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

  // حساب خاص لا يتابعه المشاهد (أو زائر بلا حساب): تُعرض المعلومات العامة فقط،
  // ويُمنع عرض المنشورات والريلز والريبوست والإشارات والقصص وأبرز القصص
  // وقائمتي المتابعة. المنع الفعلي في قاعدة البيانات عبر RLS و aani_can_read_post،
  // وهذا العلم يمنع عرض واجهات فارغة أو أقسام لا معنى لها.
  const isPrivateLocked = Boolean(person?.is_private) && !own && !isFollowing;

  // تبويب المنشورات المشار فيها: تُعرَّف حالتها قبل أي تأثير يستخدمها
  // (taggedPosts) لتفادي ReferenceError: Cannot access before initialization.
  const [taggedPosts, setTaggedPosts] = useState<Post[]>(() => []);
  const [taggedLoading, setTaggedLoading] = useState(false);
  const [taggedError, setTaggedError] = useState<string | null>(null);

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

  // تبويب المنشورات المشار فيها: يُعاد الجلب في كل فتح للتبويب حتى
  // تظهر فوراً المنشورات المنشورة حديثاً التي فيها إشارة لصاحب الملف،
  // والإشارات تُقرأ من post_metadata (kind: mention + profileId)
  // في متن/وصف المنشور الأصلي — إشارات التعليقات مستبعدة كلياً.
  useEffect(() => {
    if (profileContentTab !== 'tagged' || !supabaseConfigured || isPrivateLocked) return;
    let active = true;
    void (async () => {
      setTaggedLoading(true);
      setTaggedError(null);
      try {
        if (!activeUserId) throw new Error('معرف المستخدم غير متوفر');
        const ownerUsername = cleanUsername(person?.username);
        // فلتر JSONB آمن: containment لكائن واحد (وليس مصفوفة).
        // عامل cs ضد عمود jsonb مصفوفة يطابق أي عنصر فيه هو
        // مجموعة شاملة من الكائن (وسم mention بنفس profileId)،
        // ومصدر الخطأ 22P02 السابق كان إرسال مصفوفة كائنات `[...]`
        // وهو صياغة JSON غير مقبولة لـ PostgREST.
        const mentionContainment = JSON.stringify({ kind: 'mention', profileId: activeUserId });
        const baseColumns = 'id, user_id, content, post_metadata, media_url, media_urls, type, destination, visibility, created_at, likes_count, comments_count, reposts_count, shares_count, hide_likes, hide_comments, comment_privacy, tagged_user_ids';

        const escapeLike = (value: string) => value.replace(/[%\\]/g, match => `\\${match}`);
        // بحث الوصف عن @username فقط عند توفر اسم المستخدم
        const captionQuery = ownerUsername
          ? supabase
              .from('posts')
              .select(baseColumns)
              .ilike('content', `%@${escapeLike(ownerUsername)}%`)
              .neq('user_id', activeUserId)
              .order('created_at', { ascending: false })
              .limit(60)
          : Promise.resolve(null);

        // ثلاثة مسارات متوازية: العمود الصريح tagged_user_ids، وسم الإشارة في post_metadata، و@username في الوصف
        const [taggedColumnResult, mentionResult, captionResult] = await Promise.all([
          supabase
            .from('posts')
            .select(baseColumns)
            .contains('tagged_user_ids', [activeUserId])
            .neq('user_id', activeUserId)
            .order('created_at', { ascending: false })
            .limit(60),
          supabase
            .from('posts')
            .select(baseColumns)
            .filter('post_metadata', 'cs', mentionContainment)
            .neq('user_id', activeUserId)
            .order('created_at', { ascending: false })
            .limit(60),
          captionQuery,
        ]);

        const collectRows = (result: unknown): Record<string, unknown>[] => {
          if (!result || typeof result !== 'object') return [];
          const record = result as { data?: unknown; error?: unknown };
          if (record.error) return [];
          return Array.isArray(record.data) ? (record.data as Record<string, unknown>[]) : [];
        };
        // اعرض خطأً فقط إذا فشلت كل المسارات (مسار فاشل واحد لا يعطل التبويب)
        const failedCount = [taggedColumnResult, mentionResult, captionResult]
          .filter(result => Boolean(result) && typeof result === 'object' && (result as { error?: unknown }).error)
          .length;
        if (failedCount === 3) throw new Error('تعذر جلب المنشورات المشار فيها');

        const merged = new Map<string, Record<string, unknown>>();
        const addRows = (queryRows: Record<string, unknown>[]) => {
          queryRows.forEach(row => {
            if (typeof row.id === 'string') merged.set(row.id, row);
          });
        };
        addRows(collectRows(taggedColumnResult));
        addRows(collectRows(mentionResult));

        // نتائج الوصف: تأكد من وجود @username كإشارة كاملة (وليس مطابقة جزئية مثل @qwe داخل @qwer)
        const mentionRegex = ownerUsername
          ? new RegExp(`@${ownerUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.\\u0600-\\u06FF])`, 'i')
          : null;
        if (mentionRegex) {
          collectRows(captionResult).forEach(row => {
            const rowId = typeof row.id === 'string' ? row.id : '';
            if (!rowId || merged.has(rowId)) return;
            const content = typeof row.content === 'string' ? row.content : '';
            if (mentionRegex.test(content)) merged.set(rowId, row);
          });
        }

        const rows = Array.from(merged.values()) as unknown[];
        const authorIds = [...new Set(rows
          .map(row => (row as Record<string, unknown>).user_id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id)))];
        const profMap = new Map<string, Profile>();
        if (authorIds.length > 0) {
          const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
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
        }
      } finally {
        if (active) setTaggedLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [profileContentTab, activeUserId, person?.username, isPrivateLocked]);
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
  // شارة المزوّد تظهر لـGoogle/Apple/الهاتف فقط: لا شارة «البريد الإلكتروني»
  // مكررة بجانب عنوان حقل البريد.
  const authProviderBadgeLabel = providerBadgeLabel(authProvider);

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
    let active = true;
    if (!supabaseConfigured || !activeUserId) {
      setProfileStoryIds([]);
      return () => { active = false; };
    }

    void Promise.resolve(
      supabase
        .from('stories')
        .select('id, expires_at')
        .eq('user_id', activeUserId)
        .gt('expires_at', new Date().toISOString()),
    )
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.warn('[profile stories] تعذر تحميل قصص الملف الشخصي:', error);
          setProfileStoryIds([]);
          return;
        }
        setProfileStoryIds(((data || []) as Array<{ id?: string }>)
          .flatMap(row => (typeof row.id === 'string' ? [row.id] : [])));
      })
      .catch(error => {
        if (!active) return;
        console.warn('[profile stories] تعذر تحميل قصص الملف الشخصي:', error);
        setProfileStoryIds([]);
      });

    return () => { active = false; };
  }, [activeUserId]);

  // استعلام خفيف لإجمالي شعبية صاحب الملف الشخصي (مجموع نقاط الشعبية من الهدايا المستلمة في قاعدة البيانات).
  useEffect(() => {
    let active = true;
    if (!supabaseConfigured || !activeUserId) {
      setPopularity(null);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const value = await fetchPopularity(activeUserId);
        if (active) setPopularity(value);
      } catch {
        if (active) setPopularity(null);
      }
    })();
    return () => { active = false; };
  }, [activeUserId]);

  const profileStoryState = profileStoryIds.length === 0
    ? null
    : profileStoryIds.every(storyId => seenStoryIds.has(storyId))
      ? 'is-seen'
      : 'is-unseen';

  const openProfileStories = () => {
    if (!profileStoryIds.length || isEditingProfile) return;
    window.dispatchEvent(new CustomEvent('aani:open-profile-stories', {
      detail: { ownerId: activeUserId },
    }));
  };

  const clearAvatarLongPressTimer = () => {
    if (avatarLongPressTimerRef.current !== null) {
      window.clearTimeout(avatarLongPressTimerRef.current);
      avatarLongPressTimerRef.current = null;
    }
    avatarPressOriginRef.current = null;
  };

  // بدء الضغط: مؤقت ≈480ms يُفتح به معاينة الصورة فقط؛ يُلغى بالحركة أو الرفع
  // أو إلغاء اللمس أو فتح شاشة التعديل. منع تكرار الأحداث: مؤقت واحد فقط.
  const handleAvatarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isEditingProfile) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!resolvedAvatarPreview) return;
    clearAvatarLongPressTimer();
    avatarLongPressHandledRef.current = false;
    avatarPressOriginRef.current = { x: event.clientX, y: event.clientY };
    avatarLongPressTimerRef.current = window.setTimeout(() => {
      avatarLongPressTimerRef.current = null;
      avatarLongPressHandledRef.current = true;
      setAvatarLightboxSrc(resolvedAvatarPreview);
    }, AVATAR_LONG_PRESS_MS);
  };

  const handleAvatarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = avatarPressOriginRef.current;
    if (!origin || avatarLongPressTimerRef.current === null) return;
    const movedFar = Math.abs(event.clientX - origin.x) > AVATAR_PRESS_MOVE_TOLERANCE
      || Math.abs(event.clientY - origin.y) > AVATAR_PRESS_MOVE_TOLERANCE;
    if (movedFar) clearAvatarLongPressTimer();
  };

  // رفع الإصبع أو إلغاء اللمس يُلغي المؤقت دائماً؛ منع النقرة التالية يتم في onClick.
  const handleAvatarPointerEnd = () => {
    clearAvatarLongPressTimer();
  };

  const handleAvatarClick = () => {
    // ضغط مطوّل نُفِّذ: رفع الإصبع لا يفتح الستوري.
    if (avatarLongPressHandledRef.current) {
      avatarLongPressHandledRef.current = false;
      return;
    }
    openProfileStories();
  };

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
      const identity = readAccountAuthIdentity(user);
      setAuthEmail(identity.email);
      setAuthPhone(identity.phone);
      setAuthPhoneVerified(identity.phoneConfirmed);
      setAuthProvider(identity.primaryProvider);
      setHasPassword(identity.hasPassword);
      if (settingsScreen === 'account' && phoneChangeStep === 'request') setPhoneDraft(identity.phone || '');
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
        .select('id, username, full_name, display_name, avatar_url, gender, bio, is_private')
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

  useEffect(() => () => {
    temporaryPreviewUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    temporaryPreviewUrlsRef.current.clear();
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
      type PageResult<T> = { data: T[] | null; error: { message: string } | null };

      // جلب كامل بالصفحات: لا تُعرض صفحة واحدة على أنها القائمة كلها.
      // ترتيب ثابت (display_order/position ثم created_at ثم id) حتى لا يتكرر
      // صف أو يُسقط بين صفحتين عند تساوي قيم الترتيب.
      // صفحة واحدة من مجموعات أبرز القصص. سلسلة select حرفية في كل فرع: نوع
      // select في supabase-js يُحلَّل وقت الترجمة ولا يقبل اتحاد سلسلتين،
      // والصفوف تُضيّق بالعمود المحدد صراحةً في الاستعلام نفسه.
      const fetchCollectionPage = async (offset: number, includeDisplayOrder: boolean) => {
        const from = offset;
        const to = offset + PAGE_SIZE - 1;
        if (includeDisplayOrder) {
          const { data, error } = await supabase.from('profile_highlight_collections')
            .select('id, user_id, title, cover_url, created_at, display_order')
            .eq('user_id', activeUserId)
            .order('display_order', { ascending: true })
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to);
          return { data: (data ?? null) as unknown as ProfileHighlightCollectionSummary[] | null, error };
        }
        const { data, error } = await supabase.from('profile_highlight_collections')
          .select('id, user_id, title, cover_url, created_at')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to);
        return { data: (data ?? null) as unknown as ProfileHighlightCollectionSummary[] | null, error };
      };

      const loadHighlightCollections = async (): Promise<PageResult<ProfileHighlightCollectionSummary>> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const includeDisplayOrder = attempt === 0;
          const rows: ProfileHighlightCollectionSummary[] = [];
          let offset = 0;
          while (true) {
            const { data, error } = await fetchCollectionPage(offset, includeDisplayOrder);
            if (error) {
              // العمود display_order غير موجود (42703/PGRST204): نفس الاحتياط
              // السابق، بلا ترتيب صريح عليه، من أول صفحة.
              if (includeDisplayOrder && /display_order/i.test(error.message || '')) break;
              return { data: null, error };
            }
            const page = data || [];
            rows.push(...page);
            if (page.length < PAGE_SIZE) return { data: rows, error: null };
            if (offset >= PAGE_SIZE * MAX_PAGES) {
              return { data: null, error: { message: 'عدد المجموعات أكبر من الحد الذي يمكن تحميله.' } };
            }
            offset += PAGE_SIZE;
          }
        }
        return { data: null, error: { message: 'تعذر تحميل مجموعات أبرز القصص كاملة.' } };
      };

      const loadHighlightStories = async (): Promise<PageResult<ProfileHighlight>> => {
        const rows: ProfileHighlight[] = [];
        let offset = 0;
        while (true) {
          const { data, error } = await supabase.from('profile_highlights')
            .select('id, user_id, collection_id, position, media_url, media_type, caption, source_story_id, is_close_friends, duration_seconds, created_at')
            .eq('user_id', activeUserId)
            .order('position', { ascending: true })
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
          if (error) return { data: null, error };
          const page = (data || []) as ProfileHighlight[];
          rows.push(...page);
          if (page.length < PAGE_SIZE) return { data: rows, error: null };
          if (offset >= PAGE_SIZE * MAX_PAGES) {
            return { data: null, error: { message: 'عدد قصص أبرز القصص أكبر من الحد الذي يمكن تحميله.' } };
          }
          offset += PAGE_SIZE;
        }
      };

      const [{ data: prof }, { count: fCount }, { count: fingCount }, { data: checkFollow }, { data: checkFollowsMe }, { data: checkRequest }, { data: collectionRows, error: collectionsError }, { data: highlightRows, error: highlightsError }] = await Promise.all([
        supabase.from('profiles').select(PUBLIC_PROFILE_COLUMNS).eq('id', activeUserId).returns<PublicProfileRow>().maybeSingle(),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', activeUserId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', activeUserId),
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', currentUserId).eq('following_id', activeUserId).maybeSingle(),
        // هل الشخص يتابعني؟ (follower_id = صاحب الملف، following_id = أنا) — لزر «رد المتابعة»
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', activeUserId).eq('following_id', currentUserId).maybeSingle(),
        own ? Promise.resolve({ data: null }) : supabase.from('follow_requests').select('requester_id').eq('requester_id', currentUserId).eq('recipient_id', activeUserId).maybeSingle(),
        loadHighlightCollections(),
        loadHighlightStories(),
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

      if (prof) {
        // أعمدة التفضيلات الشخصية لم تعد ممنوحة للقراءة عبر REST، فتُقرأ
        // لصاحب الملف نفسه عبر aani_my_preferences (ترحيل 20270206000000).
        const preferences = own ? await fetchMyPreferences() : null;
        // city/location/birth_date مشروطة بأعلام الظهور: تُقرأ عبر الدالة
        // المصرّح بها التي تُعيدها فارغة إن اختار صاحب الحساب إخفاءها.
        const conditionalFields = await fetchConditionalProfileFields(activeUserId);
        if (!active) return;
        setPerson({
          ...(prof as Profile),
          ...(conditionalFields || {}),
          ...(preferences || {}),
        } as Profile);
      }
      setFollowers(fCount || 0);
      setFollowing(fingCount || 0);
      setIsFollowing(Boolean(checkFollow));
      setFollowsMe(Boolean(checkFollowsMe));
      setFollowRequestSent(Boolean(checkRequest));
      // زرع حالة المتابعة في المخزن الموحد ليتزامن الزر عبر كل الشاشات
      if (!own) {
        setFollowState(activeUserId, {
          following: Boolean(checkFollow),
          requestSent: Boolean(checkRequest),
        });
      }
      // لا قائمة جزئية: إن فشلت أي صفحة تبقى الحالة السابقة كما هي، ويُمنع
      // حفظ ترتيب مبني على قائمة ناقصة (profileHighlightsComplete = false).
      if (collectionsError || highlightsError) {
        setProfileHighlightsComplete(false);
        return;
      }

      const storiesByCollection = new Map<string, ProfileHighlight[]>();
      ((highlightRows || []) as ProfileHighlight[]).forEach(story => {
        const stories = storiesByCollection.get(story.collection_id) || [];
        stories.push(story);
        storiesByCollection.set(story.collection_id, stories);
      });
      const collectionData = (collectionRows || []) as ProfileHighlightCollectionSummary[];
      // المجموعات الفارغة تبقى مخفية كما هي قاعدة العرض الحالية، حتى مع
      // الجلب الكامل بالصفحات.
      setProfileHighlights(collectionData
        .map(collection => ({ ...collection, stories: storiesByCollection.get(collection.id) || [] }))
        .filter(collection => collection.stories.length > 0));
      setProfileHighlightsComplete(true);
    };
    void loadProfileData();
    return () => { active = false; };
  }, [activeUserId, currentUserId, own]);

  // زر المتابعة الموحد FollowButton يدير عمليات المتابعة والطلب
  // والمزامنة عبر مخزن الحالة المشترك (src/lib/followState.ts)

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
    // الإلغاء متاح دائماً — حتى أثناء تجهيز الصورة: يزيد رقم الطلب فيُبطل أي
    // نتيجة متأخرة، ويُنزل حالة التجهيز، فلا تُفتح قصاصة بعد إغلاق الشاشة.
    avatarPickRequestRef.current += 1;
    setAvatarProcessing(false);
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

  // بعد أي تغيير ناجح يُقرأ المستخدم من Supabase مجدداً: الرقم أو التأكيد لا
  // يُعرضان إلا بما يعيده Supabase نفسه.
  const refreshAccountAuthIdentity = async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    const identity = readAccountAuthIdentity(data.user);
    setAuthEmail(identity.email);
    setAuthPhone(identity.phone);
    setAuthPhoneVerified(identity.phoneConfirmed);
    setAuthProvider(identity.primaryProvider);
    setHasPassword(identity.hasPassword);
    return identity;
  };

  const openPhoneChangeDialog = () => {
    if (accountSettingsBusy) return;
    setPhoneDraft(phoneChangeStep === 'verify' ? phoneChangeTarget : authPhone);
    setPhoneOtpCode('');
    setShowPhoneModal(true);
  };

  const closePhoneChangeDialog = () => {
    if (accountSettingsBusy) return;
    setShowPhoneModal(false);
    setPhoneOtpCode('');
    if (phoneChangeStep === 'request') setPhoneDraft(authPhone);
  };

  /**
   * طلب تغيير الهاتف: Supabase Auth يرسل رمز SMS إلى الرقم الجديد عبر
   * updateUser({ phone }) — بلا phone_confirm وبلا خدمة إدارية. الرقم لا
   * يُعتمد ولا يُعرض مؤكداً قبل verifyOtp.
   *
   * تحذير Supabase: طلبات phone_change القديمة/المتزامنة قد تربط رقماً غير
   * مقصود. لذلك:
   * - طلب واحد فقط في المرة (phoneChangeInFlightRef + accountSettingsBusy).
   * - إعادة الإرسال للرقم المعلّق نفسه فقط، ولا يُستبدل برقم آخر قبل إلغاء
   *   الطلب صراحةً.
   * - التحقق يستخدم الرقم المعلّق نفسه الذي أُرسل إليه الرمز.
   */
  const requestPhoneChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phoneChangeInFlightRef.current || accountSettingsBusy) return;
    const nextPhone = normalizePhoneToE164(phoneDraft);
    if (!nextPhone) {
      toast.error(`أدخل رقم هاتف صالحاً — الرمز الافتراضي ${DEFAULT_PHONE_COUNTRY_CODE} أو صيغة دولية تبدأ بـ +.`);
      return;
    }
    if (nextPhone === authPhone) {
      toast.error('هذا هو رقم الهاتف الحالي على الحساب.');
      return;
    }
    if (phoneChangeStep === 'verify' && nextPhone !== phoneChangeTarget) {
      toast.error('يوجد طلب تحقق معلّق لرقم آخر. ألغِ الطلب أولاً ثم اطلب الرقم الجديد.');
      return;
    }

    phoneChangeInFlightRef.current = true;
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ phone: nextPhone });
      if (error) throw error;
      setPhoneChangeTarget(nextPhone);
      setPhoneChangeStep('verify');
      setPhoneOtpCode('');
      toast.success('أرسلنا رمز تحقق SMS إلى الرقم الجديد. أدخل الرمز لتأكيده.');
    } catch (error) {
      toast.error(accountAuthErrorMessage(error, 'تعذر إرسال رمز التحقق. حاول مرة أخرى.'));
    } finally {
      phoneChangeInFlightRef.current = false;
      setAccountSettingsBusy(false);
    }
  };

  /** إعادة إرسال الرمز للرقم المعلّق نفسه فقط — لا رقم آخر. */
  const resendPhoneChangeCode = async () => {
    if (phoneChangeInFlightRef.current || accountSettingsBusy || !phoneChangeTarget) return;
    phoneChangeInFlightRef.current = true;
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ phone: phoneChangeTarget });
      if (error) throw error;
      toast.success('أعدنا إرسال رمز التحقق إلى الرقم نفسه.');
    } catch (error) {
      toast.error(accountAuthErrorMessage(error, 'تعذر إعادة إرسال الرمز. حاول بعد قليل.'));
    } finally {
      phoneChangeInFlightRef.current = false;
      setAccountSettingsBusy(false);
    }
  };

  const confirmPhoneChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phoneChangeInFlightRef.current || accountSettingsBusy) return;
    const token = phoneOtpCode.replace(/\D/g, '');
    if (!phoneChangeTarget || token.length < 6) {
      toast.error('أدخل رمز التحقق المكوّن من ستة أرقام.');
      return;
    }

    phoneChangeInFlightRef.current = true;
    setAccountSettingsBusy(true);
    try {
      const { data, error } = await supabase.auth.verifyOtp({ phone: phoneChangeTarget, token, type: 'phone_change' });
      if (error) throw error;
      const identity = await refreshAccountAuthIdentity();
      // لا يُعرض الرقم مؤكداً إلا إذا أعاد Supabase الرقم الجديد نفسه مؤكداً.
      if (!data.user || !identity || identity.phone !== phoneChangeTarget || !identity.phoneConfirmed) {
        throw new Error('لم يؤكد Supabase الرقم الجديد بعد. أعد المحاولة أو اطلب رمزاً جديداً.');
      }
      setPhoneChangeStep('request');
      setPhoneChangeTarget('');
      setPhoneOtpCode('');
      setPhoneDraft(identity.phone);
      setShowPhoneModal(false);
      toast.success('تم تأكيد رقم الهاتف الجديد. جلستك على هذا الجهاز ما زالت قائمة.');
    } catch (error) {
      const message = accountAuthErrorMessage(error, 'تعذر تأكيد الرمز. أعد المحاولة أو اطلب رمزاً جديداً.');
      // انتهاء الصلاحية أو الرمز الخاطئ: يُمسح الرمز ويُطلب رمز جديد للرقم نفسه.
      if (/انتهت صلاحية|غير صحيح/.test(message)) setPhoneOtpCode('');
      toast.error(message);
    } finally {
      phoneChangeInFlightRef.current = false;
      setAccountSettingsBusy(false);
    }
  };

  const cancelPhoneChangeRequest = () => {
    if (phoneChangeInFlightRef.current || accountSettingsBusy) return;
    setPhoneChangeStep('request');
    setPhoneChangeTarget('');
    setPhoneOtpCode('');
    setPhoneDraft(authPhone);
    toast.success('أُلغي طلب التحقق هنا. الرقم الحالي لم يتغيّر.');
  };

  /** إعادة تحقق آمنة لحساب Google/Apple: رابط إلى بريد الحساب نفسه. */
  const sendPasswordResetLink = async () => {
    if (accountSettingsBusy) return;
    if (!authEmail) {
      toast.error('لا يوجد بريد مؤكد لهذا الحساب لإرسال رابط التحقق.');
      return;
    }
    setAccountSettingsBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(authEmail, {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      setPasswordReauthSent(true);
      toast.success('أرسلنا رابط تحقق إلى بريد الحساب. افتح الرابط لتعيين كلمة المرور.');
    } catch (error) {
      toast.error(accountAuthErrorMessage(error, 'تعذر إرسال رابط التحقق. حاول مرة أخرى.'));
    } finally {
      setAccountSettingsBusy(false);
    }
  };

  /**
   * تغيير كلمة المرور:
   * - حساب يملك كلمة مرور: تُتحقق كلمة المرور الحالية عند Supabase عبر
   *   signInWithPassword (لا تُقارن محلياً ولا تُخزَّن) ثم updateUser.
   *   لا signOut: الجلسة تبقى قائمة بعد التغيير.
   * - حساب Google/Apple بلا كلمة مرور: رابط تحقق إلى البريد (أعلاه) ثم
   *   نافذة التعيين — إعادة تحقق آمنة بلا ربط هوية جديد.
   */
  const savePasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accountSettingsBusy || !hasPassword) return;
    if (passwordDraft.length < MIN_PASSWORD_LENGTH) {
      toast.error(`اختر كلمة مرور من ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`);
      return;
    }
    if (passwordDraft !== passwordConfirmDraft) {
      toast.error('كلمتا المرور الجديدتان غير متطابقتين.');
      return;
    }
    if (!currentPasswordDraft) {
      toast.error('أدخل كلمة المرور الحالية للتحقق.');
      return;
    }
    const credentials = authEmail
      ? { email: authEmail, password: currentPasswordDraft }
      : authPhone
        ? { phone: authPhone, password: currentPasswordDraft }
        : null;
    if (!credentials) {
      toast.error('تعذر تحديد طريقة التحقق من الحساب.');
      return;
    }

    setAccountSettingsBusy(true);
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword(credentials);
      if (verifyError) throw verifyError;
      const { error: updateError } = await supabase.auth.updateUser({ password: passwordDraft });
      if (updateError) throw updateError;
      setCurrentPasswordDraft('');
      setPasswordDraft('');
      setPasswordConfirmDraft('');
      await refreshAccountAuthIdentity();
      toast.success('تم تحديث كلمة المرور. جلستك ما زالت قائمة.');
    } catch (error) {
      toast.error(accountAuthErrorMessage(error, 'تعذر تحديث كلمة المرور. تحقق من كلمة المرور الحالية.'));
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

  // إلغاء القص يعيد المعاينة السابقة: ملف الأفاتار المعتمد إن وُجد، وإلا الصورة المحفوظة.
  // لا يُعاد استخدام blob قديم لأنه أُبطل عند تبديل المعاينة.
  const restoreAvatarPreviewAfterCancel = () => {
    setAvatarCropFile(null);
    setImagePreview('avatar', pendingAvatarFile ? URL.createObjectURL(pendingAvatarFile) : (person?.avatar_url || null));
  };

  const handleProfileImageSelection = async (kind: ProfileImageKind, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !own || !isEditingProfile || profileSaving) return;
    if (!isPickedImage(file)) {
      toast.error('اختر صورة بصيغة JPEG أو PNG أو HEIC.');
      return;
    }

    if (kind === 'cover') {
      setPendingCoverFile(file);
      setImagePreview('cover', URL.createObjectURL(file));
      setCoverPosition({ x: 50, y: 50 });
      return;
    }

    // معاينة فورية داخل دائرة الصورة، والقصاصة الدائرية تُفتح فوقها مباشرة.
    // رقم هذا الاختيار: اختيار أحدث يلغيه فلا يُفتح له قصاصة ولا يستبدل المعاينة.
    const pickId = avatarPickRequestRef.current + 1;
    avatarPickRequestRef.current = pickId;
    setImagePreview('avatar', URL.createObjectURL(file));
    setAvatarProcessing(true);
    try {
      // HEIC/HEIF تُحوَّل إلى JPEG قبل القص حتى يعمل تصدير canvas على iPhone.
      const prepared = await normalizePickedImage(file);
      if (avatarPickRequestRef.current !== pickId) return;
      setAvatarCropFile(prepared);
    } catch (error) {
      if (avatarPickRequestRef.current !== pickId) return;
      restoreAvatarPreviewAfterCancel();
      toast.error(error instanceof Error ? error.message : 'تعذر تجهيز الصورة. جرّب صورة أخرى.');
    } finally {
      if (avatarPickRequestRef.current === pickId) setAvatarProcessing(false);
    }
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
    // مرجع القفل يُفحص قبل أي await وقبل أي عمل غير متزامن.
    if (saveInFlightRef.current) return;
    if (!own || !person || !isEditingProfile || profileSaving) return;
    // لا حفظ قبل اعتماد القصاصة: الصورة المختارة لا تُرفع إلا بعد «تم» في القص.
    if (avatarProcessing) {
      toast.error('انتظر انتهاء تجهيز الصورة قبل الحفظ.');
      return;
    }
    if (avatarCropFile) {
      toast.error('اعتمد قصاصة الصورة الشخصية أو ألغِها قبل الحفظ.');
      return;
    }
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

    // القفل المرجعي يُضبط قبل أول await؛ النقر الثاني في الدورة نفسها يراه ويخرج.
    saveInFlightRef.current = true;
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
      const uploadPendingImage = async (kind: ProfileImageKind, file: File): Promise<string> => {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'profile-image';
        const path = `${currentUserId}/profile/${kind}-${Date.now()}-${safeName}`;
        // ضغط من جهة العميل: الأفاتار 320×320 < 80KB (إعداد avatar في mediaCompressor)،
        // والغلاف بعرض أقصى 1200px < 200KB.
        // uploadMedia يعيد رابط ImageKit الحقيقي للملف المرفوع — يُحفظ كما هو، ولا
        // يُشتق بديل عبر getPublicUrl: سجل الروابط في supabase.ts ذاكرة جلسة
        // واحدة، وقد يعيد رابط Supabase غير موجود لملف رُفع إلى ImageKit.
        const uploadedUrl = await uploadMedia({ file, path, preset: kind === 'avatar' ? 'avatar' : 'cover' });
        // لا يُحفظ إلا رابط https حقيقي عاد من خدمة الرفع.
        if (typeof uploadedUrl !== 'string' || !uploadedUrl.startsWith('https://')) {
          throw new Error(`لم يُرجِع رفع ${kind === 'avatar' ? 'الصورة الشخصية' : 'الغلاف'} رابطاً صالحاً للملف.`);
        }
        uploadedPaths.push(path);
        if (kind === 'avatar') patch.avatar_url = uploadedUrl;
        else patch.cover_url = uploadedUrl;
        return uploadedUrl;
      };

      // رفع الصور وتجميع روابط ImageKit
      let avatarUrl: string | undefined;
      let coverUrl: string | undefined;
      try {
        if (pendingAvatarFile) {
          avatarUrl = await uploadPendingImage('avatar', pendingAvatarFile);
        }
        if (pendingCoverFile) {
          coverUrl = await uploadPendingImage('cover', pendingCoverFile);
        }
      } catch (uploadError) {
        console.error('[profile] فشل رفع الصورة:', uploadError);
        const msg = uploadError instanceof Error ? uploadError.message : 'خطأ غير معروف';
        if (/تجهيز توقيع|imagekit-auth|تسجيل الدخول/i.test(msg)) {
          toast.error('تعذر الاتصال بخدمة الرفع. تأكد من تسجيل الدخول وحاول مرة أخرى.');
        } else if (/فشل رفع|upload|imagekit/i.test(msg)) {
          toast.error('فشل رفع الصورة إلى خدمة التخزين. تحقق من اتصالك وحاول مرة أخرى.');
        } else if (/حجم|كبيرة|large/i.test(msg)) {
          toast.error('حجم الصورة يتجاوز الحد المسموح. اختر صورة أصغر.');
        } else if (/رابط صالح/i.test(msg)) {
          toast.error('فشل الرفع: لم يُستلم رابط صحيح من خدمة التخزين.');
        } else {
          toast.error(`فشل رفع الصورة: ${msg}`);
        }
        throw uploadError;
      }

      // تطبيق الروابط على كائن التحديث
      if (avatarUrl) patch.avatar_url = avatarUrl;
      if (coverUrl) patch.cover_url = coverUrl;

      // حفظ في قاعدة البيانات مع إرجاع الصف للتحقق
      let savedPatch = patch;
      let { data: updatedRow, error } = await supabase
        .from('profiles')
        .update(savedPatch)
        .eq('id', currentUserId)
        .select('id, avatar_url, cover_url')
        .maybeSingle();

      let coverPositionSaved = true;
      if (error && (error.code === 'PGRST204' || error.code === '42703') && /cover_position_[xy]/i.test(error.message)) {
        const fallbackPatch = { ...patch };
        delete fallbackPatch.cover_position_x;
        delete fallbackPatch.cover_position_y;
        const retry = await supabase
          .from('profiles')
          .update(fallbackPatch)
          .eq('id', currentUserId)
          .select('id, avatar_url, cover_url')
          .maybeSingle();
        updatedRow = retry.data;
        error = retry.error;
        if (!error) {
          savedPatch = fallbackPatch;
          coverPositionSaved = false;
        }
      }
      if (error) throw error;

      // التحقق من رجوع الصف والرابط الصحيح
      if (!updatedRow || updatedRow.id !== currentUserId) {
        throw new Error('لم يتم تحديث ملفك الشخصي في قاعدة البيانات.');
      }
      if (avatarUrl && updatedRow.avatar_url !== avatarUrl) {
        throw new Error('لم يتم تأكيد حفظ رابط الصورة الشخصية.');
      }
      if (coverUrl && updatedRow.cover_url !== coverUrl) {
        throw new Error('لم يتم تأكيد حفظ رابط الغلاف.');
      }

      // تحديث الحالة المحلية من الصف المحفوظ فعلياً
      const updatedProfile = { ...person, ...savedPatch, avatar_url: updatedRow.avatar_url ?? person.avatar_url, cover_url: updatedRow.cover_url ?? person.cover_url };
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
      // فشل الرفع/التحديث: تُعرض الصورة المحفوظة فعلاً في person، وتبقى الملفات
      // المعلقة لإعادة المحاولة، فلا تظهر الصورة المقترحة كأنها محفوظة.
      setImagePreview('avatar', person.avatar_url || null);
      setImagePreview('cover', person.cover_url || null);
      // لا حذف عبر supabase.storage: الملفات مرفوعة إلى ImageKit لا إلى bucket،
      // ولا معرّف تخزين لها هنا. كل رفع مسجَّل في Upload Ledger، وكنس اليتامى
      // على الخادم يحذف ما لا مرجع له بعد فترة السماح.
      console.error('[profile] تعذر حفظ تعديلات الملف الشخصي:', error);
      const saveError = error as { code?: string; message?: string };
      // تجنب رسالة خطأ مكررة إن كان الفشل في الرفع (تم إظهاره أعلاه)
      const isUploadError = saveError.message && /تجهيز توقيع|imagekit-auth|تسجيل الدخول|فشل رفع|upload|imagekit|حجم.*كبيرة|large|رابط صالح/i.test(saveError.message);
      if (!isUploadError) {
        if (saveError.code === '23505') {
          toast.error('اسم المستخدم مستخدم بالفعل.');
        } else if ((saveError.code === 'PGRST204' || saveError.code === '42703') && /city|job|birth_date|show_city|show_job|show_birth_date/i.test(saveError.message || '')) {
          toast.error('تعذر حفظ بيانات الملف الجديدة. طبّق ترحيل بيانات الملف الشخصي في Supabase ثم حاول مجدداً.');
        } else if (/لم يتم (تحديث|تأكيد حفظ)/.test(saveError.message || '')) {
          toast.error(saveError.message);
        } else {
          toast.error('تعذر حفظ تعديلات الملف الشخصي. حاول مرة أخرى.');
        }
      }
      // لا نغلق نافذة التحرير ولا نمسح الصورة المختارة عند الفشل
    } finally {
      saveInFlightRef.current = false;
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

  // ترتيب قصص مجموعة محلياً: نفس قائمة position القادمة من Profile (لا فرز آخر).
  const applyHighlightStoryOrder = (collectionId: string, orderedIds: string[]) => {
    setProfileHighlights(current => current.map(collection => {
      if (collection.id !== collectionId) return collection;
      const storyById = new Map(collection.stories.map(story => [story.id, story]));
      return {
        ...collection,
        stories: orderedIds.flatMap(id => storyById.has(id) ? [storyById.get(id)!] : []),
      };
    }));
  };

  // حفظ ترتيب القصص داخل مجموعة عبر RPC مستقلة (transaction واحدة في القاعدة)
  // مع إعادة الترتيب السابق عند الفشل — مستقل عن حفظ بيانات الملف الشخصي.
  const saveProfileHighlightStoryOrder = async (collectionId: string, nextIds: string[], previousIds: string[]) => {
    const restorePreviousOrder = () => applyHighlightStoryOrder(collectionId, previousIds);
    if (!supabaseConfigured) {
      restorePreviousOrder();
      toast.error('اتصال قاعدة البيانات غير متاح.');
      return;
    }

    setProfileReorderSaving(true);
    try {
      const { error } = await supabase.rpc('aani_reorder_profile_highlight_stories', {
        p_collection_id: collectionId,
        p_ids: nextIds,
      });
      if (error) {
        restorePreviousOrder();
        console.error('[profile] تعذر حفظ ترتيب قصص المجموعة:', error);
        toast.error(error.code === 'PGRST202' || error.code === '42883'
          ? 'طبّق ترحيل إعادة ترتيب قصص أبرز القصص في Supabase أولاً.'
          : 'تعذر حفظ ترتيب القصص. حاول مرة أخرى.');
      } else {
        toast.success('تم حفظ ترتيب القصص.');
      }
    } catch (error) {
      restorePreviousOrder();
      console.error('[profile] تعذر حفظ ترتيب قصص المجموعة:', error);
      toast.error('تعذر حفظ ترتيب القصص. تحقق من الاتصال ثم حاول مرة أخرى.');
    } finally {
      setProfileReorderSaving(false);
    }
  };

  // إعلان موضع العنصر بعد التحريك أو السحب لقارئ الشاشة (aria-live).
  const announceReorderPosition = (kind: ProfileReorderKind, nextIds: string[], id: string) => {
    const index = nextIds.indexOf(id);
    if (index < 0) return;
    setProfileReorderAnnouncement(`نُقل ${PROFILE_REORDER_LABELS[kind]} إلى الموضع ${index + 1} من ${nextIds.length}.`);
  };

  const beginProfileReorder = (event: ReactPointerEvent<HTMLElement>, kind: ProfileReorderKind, id: string) => {
    if (!own || !showProfileReorder || profileReorderSaving) return;
    // بلا قائمة كاملة لا سحب: كل قصص المجموعة يجب أن تكون محمّلة قبل ترتيبها.
    if ((kind === 'highlights' || kind === 'stories') && !profileHighlightsComplete) return;
    profileReorderDragConsumedClickRef.current = false;
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
    // سحب فعلي: النقرة التالية تُستهلك بدل فتح العنصر.
    profileReorderDragConsumedClickRef.current = true;

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
      announceReorderPosition('highlights', nextIds, gesture.id);
      void saveProfileContentOrder('highlights', nextIds, previousIds);
      return;
    }

    if (gesture.kind === 'stories') {
      const collection = reorderStoriesCollectionId
        ? profileHighlights.find(item => item.id === reorderStoriesCollectionId) ?? null
        : null;
      if (!collection) return;
      const previousIds = collection.stories.map(story => story.id);
      const nextIds = moveProfileItem(previousIds, gesture.id, targetId);
      if (nextIds === previousIds) return;
      applyHighlightStoryOrder(collection.id, nextIds);
      announceReorderPosition('stories', nextIds, gesture.id);
      void saveProfileHighlightStoryOrder(collection.id, nextIds, previousIds);
      return;
    }

    // إعادات نشر الآخرين تظهر في مواقعها بلا سحب: لا يُرسل إلا معرفات
    // المنشورات المملوكة، والقائمة المرسلة تبقى كاملة لعقد RPC الحالية.
    const previousIds = orderedEditablePosts.map(post => post.id);
    if (!previousIds.includes(gesture.id) || !previousIds.includes(targetId)) return;
    const nextIds = moveProfileItem(previousIds, gesture.id, targetId);
    if (nextIds === previousIds) return;
    setProfilePostOrder(nextIds);
    announceReorderPosition('posts', nextIds, gesture.id);
    void saveProfileContentOrder('posts', nextIds, previousIds);
  };

  const cancelProfileReorderPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = profileReorderGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.timer !== null) window.clearTimeout(gesture.timer);
    // لمس طويل انتهى بـpointercancel: لا تُفتح الصورة بعد الإلغاء.
    if (gesture.active) profileReorderDragConsumedClickRef.current = true;
    profileReorderGestureRef.current = null;
    setDraggingReorderKey(null);
    setDragOverReorderKey(null);
  };

  // النقرة التي يرسلها المتصفح بعد كل سحب فعلي تُستهلك هنا: الفتح يبقى للنقر
  // القصير وحده، فلا تفتح الصورة أو المجموعة بعد إفلاتها.
  const consumeProfileReorderClick = () => {
    if (!profileReorderDragConsumedClickRef.current) return false;
    profileReorderDragConsumedClickRef.current = false;
    return true;
  };

  // Safari يحدّد التمرير عند بداية اللمسة، وتغيير touch-action بعد اكتمال
  // الضغط المطوّل لا يمنع تمريراً بدأ بالفعل. لذلك مستمع touchmove غير سلبي
  // على المستند يُلغي التمرير فقط بينما السحب فعّال، ويترك اللمس العادي قبل
  // 450ms يمرّر الصفحة والصف والشبكة كما هو. وtouchcancel يُلغي السحب وينظّف
  // المؤقت والحالة مثل pointercancel.
  useEffect(() => {
    if (!showProfileReorder) return;
    const stopPageScrollDuringDrag = (event: TouchEvent) => {
      if (profileReorderGestureRef.current?.active) event.preventDefault();
    };
    const abandonTouchDrag = () => {
      const gesture = profileReorderGestureRef.current;
      if (!gesture) return;
      if (gesture.timer !== null) window.clearTimeout(gesture.timer);
      if (gesture.active) profileReorderDragConsumedClickRef.current = true;
      profileReorderGestureRef.current = null;
      setDraggingReorderKey(null);
      setDragOverReorderKey(null);
    };
    document.addEventListener('touchmove', stopPageScrollDuringDrag, { passive: false });
    document.addEventListener('touchcancel', abandonTouchDrag);
    return () => {
      document.removeEventListener('touchmove', stopPageScrollDuringDrag);
      document.removeEventListener('touchcancel', abandonTouchDrag);
    };
  }, [showProfileReorder]);

  // ربط المعاينة الحية بالسحب: نفس المفروز ونفس المعالجات للأنواع الثلاثة.
  const profileReorderBinding = (kind: ProfileReorderKind): ReorderBinding => ({
    kind,
    draggingKey: draggingReorderKey,
    dropTargetKey: dragOverReorderKey,
    disabled: profileReorderSaving,
    begin: (event, reorderKind, id) => beginProfileReorder(event, reorderKind as ProfileReorderKind, id),
    move: moveProfileReorderPointer,
    end: endProfileReorderPointer,
    cancel: cancelProfileReorderPointer,
    consumeDragClick: consumeProfileReorderClick,
  });

  // فتح منشور الشبكة في عارضه الحالي — نفس سلوك شبكة Profile تماماً.
  const openProfileGridPost = (post: Post) => {
    if (profileContentTab === 'videos') {
      setReelsPlayerSource('videos');
      setReelsPlayerPostId(post.id);
    } else if (profileContentTab === 'reposts') {
      if (isProfileReel(post)) {
        setReelsPlayerSource('reposts');
        setReelsPlayerPostId(post.id);
      } else {
        setFeedViewerSource('reposts');
        setFeedViewerPostId(post.id);
      }
    } else if (profileContentTab === 'tagged') {
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
              <button type="submit" className="profile-edit-save" disabled={profileSaving || avatarProcessing}>{profileSaving ? 'جارٍ الحفظ…' : avatarProcessing ? 'جارٍ تجهيز الصورة…' : 'حفظ'}</button>
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
                <section className="profile-reorder-panel profile-reorder-preview" aria-label="إعادة ترتيب القصص والمنشورات">
                  <p className="profile-reorder-hint">اضغط مطولاً على أي مكان في المنشور أو دائرة القصة، ثم اسحب العنصر إلى موضعه الجديد. يُحفظ الترتيب فوراً ويظهر في ملفك الشخصي.</p>
                  <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{profileReorderAnnouncement}</div>

                  <div className="profile-reorder-section-head">
                    <h3>أبرز القصص</h3>
                    <button type="button" className="profile-reorder-manage" onClick={() => setShowHighlightsManager(true)}>إدارة المجموعات</button>
                  </div>
                  {profileHighlights.length ? (
                    <ProfileHighlightsRow
                      collections={profileHighlights}
                      onSelect={collection => setReorderStoriesCollectionId(collection.id)}
                      reorder={profileReorderBinding('highlights')}
                    />
                  ) : <EmptyState className="py-6" />}

                  {reorderStoriesCollection && (
                    <div className="profile-reorder-stories" aria-label={`قصص ${reorderStoriesCollection.title}`}>
                      <div className="profile-reorder-section-head">
                        <h3>{reorderStoriesCollection.title} — القصص</h3>
                        <button type="button" className="profile-reorder-manage" onClick={() => setReorderStoriesCollectionId(null)}>إغلاق</button>
                      </div>
                      <p className="profile-reorder-hint">اضغط مطولاً على دائرة القصة ثم اسحبها لإعادة ترتيبها داخل المجموعة.</p>
                      <ProfileHighlightStoryStrip
                        collection={reorderStoriesCollection}
                        reorder={profileReorderBinding('stories')}
                      />
                    </div>
                  )}

                  <div className="profile-reorder-section-head">
                    <h3>المنشورات</h3>
                  </div>
                  {reorderPreviewPosts.length ? (
                    <ProfileMediaGrid
                      posts={reorderPreviewPosts}
                      reorder={profileReorderBinding('posts')}
                      canReorder={post => post.user_id === activeUserId && !post.reposter_id}
                      className="profile-reorder-grid"
                    />
                  ) : <EmptyState className="py-6" />}

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
        <div className="relative z-30 flex items-center justify-between bg-black/40 px-4 py-2 backdrop-blur-md">
          {popularity !== null && supabaseConfigured && (
            <button
              type="button"
              aria-label="وسم الشعبية"
              onClick={() => setShowPopularitySheet(true)}
              className="w-fit inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/45 backdrop-blur-md border border-white/15 shadow-sm hover:bg-black/60 transition"
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4 shrink-0 text-white"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M6 2H9V8.2L12 10.1L6 6.2V2Z" fill="#FFFFFF" fillOpacity="0.65" />
                <path d="M18 2H15V8.2L12 10.1L18 6.2V2Z" fill="#FFFFFF" fillOpacity="0.65" />
                <path d="M9.6 2H14.4V8.5L12 10.1L9.6 8.5V2Z" fill="#FFFFFF" />
                <path
                  fillRule="evenodd"
                  d="M12 11.2A5.3 5.3 0 1 0 12 21.8A5.3 5.3 0 1 0 12 11.2ZM12.00 13.30L12.76 15.43L15.02 15.50L13.23 16.88L13.87 19.05L12.00 17.78L10.13 19.05L10.77 16.88L8.98 15.50L11.24 15.43Z"
                  fill="#FFFFFF"
                />
              </svg>
              <span className="text-xs font-semibold text-white tabular-nums">
                {formatPopularity(popularity)}
              </span>
            </button>
          )}
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
                        <span className="profile-settings-description">{authEmail || 'غير مضاف'}</span>
                        {authProviderBadgeLabel && <span className="profile-settings-provider-badge">{authProviderBadgeLabel}</span>}
                      </span>
                      <span className="profile-settings-description">البريد للعرض فقط — لا يمكن تغييره من إعدادات الحساب.</span>
                    </span>
                  </div>
                  <button type="button" className="profile-settings-row profile-settings-link" onClick={openPhoneChangeDialog} disabled={accountSettingsBusy}>
                    <span className="profile-settings-copy">
                      <span className="profile-settings-label">رقم الهاتف</span>
                      <span className="profile-settings-description" dir="ltr">{authPhone ? formatPhoneForDisplay(authPhone) : 'غير مضاف'}</span>
                    </span>
                    {authPhone && authPhoneVerified && <span className="profile-settings-provider-badge">مؤكد</span>}
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
                <form onSubmit={savePasswordChange} className="space-y-4">
                  {hasPassword ? (
                    <>
                      <p className="profile-settings-note">أدخل كلمة المرور الحالية للتحقق منها عند Supabase، ثم كلمة المرور الجديدة مرتين. لا تُخزَّن كلمات المرور في التطبيق، وجلستك تبقى قائمة.</p>
                      <div className="profile-settings-field">
                        <label htmlFor="settings-current-password">كلمة المرور الحالية</label>
                        <input id="settings-current-password" type="password" autoComplete="current-password" required value={currentPasswordDraft} onChange={event => setCurrentPasswordDraft(event.target.value)} />
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="profile-settings-note">هذا الحساب مسجّل عبر {authProvider === 'apple' ? 'Apple' : 'Google'} ولا يملك كلمة مرور محلية. سنرسل رابط تحقق إلى بريد الحساب ({authEmail || 'غير متاح'}) لتعيين كلمة مرور — بلا ربط هوية جديد وبلا حذف أزرار الدخول.</p>
                      <button type="button" className="profile-settings-action" onClick={() => void sendPasswordResetLink()} disabled={accountSettingsBusy || !authEmail}>{accountSettingsBusy ? 'جارٍ الإرسال...' : 'إرسال رابط التحقق'}</button>
                      {passwordReauthSent && <p className="profile-settings-note">افتح الرابط في بريدك، ثم عيّن كلمة المرور من النافذة التي ستظهر بعد التحقق.</p>}
                    </>
                  )}
                  {hasPassword && (
                    <>
                      <div className="profile-settings-field">
                        <label htmlFor="settings-password">كلمة المرور الجديدة</label>
                        <input id="settings-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required value={passwordDraft} onChange={event => setPasswordDraft(event.target.value)} />
                      </div>
                      <div className="profile-settings-field">
                        <label htmlFor="settings-password-confirm">تأكيد كلمة المرور الجديدة</label>
                        <input id="settings-password-confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required value={passwordConfirmDraft} onChange={event => setPasswordConfirmDraft(event.target.value)} />
                      </div>
                      <button
                        className="profile-settings-action"
                        type="submit"
                        disabled={accountSettingsBusy || !currentPasswordDraft || passwordDraft.length < MIN_PASSWORD_LENGTH || passwordDraft !== passwordConfirmDraft}
                      >
                        {accountSettingsBusy ? 'جارٍ الحفظ...' : 'تحديث كلمة المرور'}
                      </button>
                      {authEmail && (
                        <button type="button" className="profile-settings-secondary-action" onClick={() => void sendPasswordResetLink()} disabled={accountSettingsBusy}>
                          لا تملك كلمة المرور الحالية؟ أرسل رابط تحقق إلى البريد
                        </button>
                      )}
                      {passwordReauthSent && <p className="profile-settings-note">افتح رابط التحقق في بريدك، ثم عيّن كلمة المرور من النافذة التي ستظهر بعد التحقق.</p>}
                    </>
                  )}
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
                    <EmptyState className="py-6" />
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
                      <EmptyState className="py-6" />
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
                    <EmptyState className="py-6" />
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
            <div className="profile-settings-dialog-backdrop" onClick={closePhoneChangeDialog}>
              <section role="dialog" aria-modal="true" aria-labelledby="phone-modal-title" className="profile-settings-dialog" onClick={event => event.stopPropagation()}>
                <h3 id="phone-modal-title">{phoneChangeStep === 'request' ? 'تغيير رقم الهاتف' : 'تأكيد الرقم الجديد'}</h3>
                {phoneChangeStep === 'request' ? (
                  <form onSubmit={requestPhoneChange}>
                    <p className="profile-settings-note">أدخل الرقم بالصيغة الدولية أو المحلية — الرمز الافتراضي {DEFAULT_PHONE_COUNTRY_CODE} للعراق. سيصل رمز تحقق SMS إلى الرقم الجديد، ولا يُعتمد الرقم قبل إدخال الرمز.</p>
                    <div className="profile-settings-field">
                      <label htmlFor="settings-phone">رقم الهاتف</label>
                      <input id="settings-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder={`${DEFAULT_PHONE_COUNTRY_CODE} 7XX XXX XXXX`} maxLength={24} required value={phoneDraft} onChange={event => setPhoneDraft(event.target.value)} />
                    </div>
                    <div className="profile-settings-dialog-actions">
                      <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={closePhoneChangeDialog}>إلغاء</button>
                      <button className="profile-settings-action" type="submit" disabled={accountSettingsBusy || !phoneDraft.trim()}>{accountSettingsBusy ? 'جارٍ الإرسال...' : 'إرسال رمز التحقق'}</button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={confirmPhoneChange}>
                    <p className="profile-settings-note">أرسلنا رمزاً إلى {formatPhoneForDisplay(phoneChangeTarget)}. أدخل الرمز لاعتماد الرقم — لا يُعرض الرقم مؤكداً قبل تأكيد Supabase.</p>
                    <div className="profile-settings-field">
                      <label htmlFor="settings-phone-code">رمز التحقق</label>
                      <input id="settings-phone-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={phoneOtpCode} onChange={event => setPhoneOtpCode(event.target.value.replace(/\D/g, ''))} />
                    </div>
                    <p className="profile-settings-note">إن انتهت صلاحية الرمز فأعد إرساله إلى الرقم نفسه. إلغاء الطلب هنا لا يغيّر رقمك الحالي، وأي طلب غير مؤكد ينتهي تلقائياً في Supabase.</p>
                    <div className="profile-settings-dialog-actions">
                      <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={cancelPhoneChangeRequest}>إلغاء الطلب</button>
                      <button type="button" className="profile-settings-dialog-cancel" disabled={accountSettingsBusy} onClick={() => void resendPhoneChangeCode()}>إعادة إرسال الرمز</button>
                      <button className="profile-settings-action" type="submit" disabled={accountSettingsBusy || phoneOtpCode.length < 6}>{accountSettingsBusy ? 'جارٍ التحقق...' : 'تأكيد الرقم'}</button>
                    </div>
                  </form>
                )}
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

      <PopularityGiftsSheet
        open={showPopularitySheet}
        userId={activeUserId}
        recipientName={displayName(person)}
        currentUserId={currentUserId}
        onClose={() => setShowPopularitySheet(false)}
        onPopularityChange={value => setPopularity(value)}
      />

      {avatarLightboxSrc && typeof document !== 'undefined' && createPortal(
        <ProfileAvatarLightbox
          src={avatarLightboxSrc}
          alt={displayName(person)}
          onClose={() => setAvatarLightboxSrc(null)}
        />,
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
        {resolvedCoverPreview && (
          <img
            src={resolvedCoverPreview}
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
          <div
            className={`relative -mt-11 h-[92px] w-[92px] shrink-0 profile-story-ring ${profileStoryState ?? ''}`}
            role={profileStoryIds.length ? 'button' : undefined}
            tabIndex={profileStoryIds.length ? 0 : undefined}
            aria-label={profileStoryIds.length ? `عرض قصص ${displayName(person)}` : undefined}
            onClick={handleAvatarClick}
            onPointerDown={handleAvatarPointerDown}
            onPointerMove={handleAvatarPointerMove}
            onPointerUp={handleAvatarPointerEnd}
            onPointerCancel={handleAvatarPointerEnd}
            onPointerLeave={handleAvatarPointerEnd}
            onKeyDown={event => {
              if (!profileStoryIds.length) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openProfileStories();
              }
            }}
          >
            <span className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border-4 border-black">
              {resolvedAvatarPreview ? (
                <img
                  src={resolvedAvatarPreview}
                  className="h-full w-full rounded-full object-cover"
                  alt=""
                  draggable={false}
                  onContextMenu={event => event.preventDefault()}
                />
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
              <FollowButton
                targetUserId={activeUserId}
                currentUserId={currentUserId}
                isPrivate={person.is_private}
                followsMe={followsMe}
                initialFollowing={isFollowing}
                initialRequestSent={followRequestSent}
                onFollowingChange={next => {
                  setFollowers(prev => Math.max(0, prev + (next ? 1 : -1)));
                  setIsFollowing(next);
                }}
              />
              <Link href={`/messages/${activeUserId}`} aria-label="إرسال رسالة" className="flex h-9 w-9 items-center justify-center rounded-full border border-[#53575B] text-white transition hover:bg-white/10">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </Link>
            </div>
          )}
          {/* حساب خاص لا يتابعه المشاهد: تُخفى الإحصاءات وقائمتا المتابعة معاً،
              فلا يبقى سوى المعلومات العامة وزر «طلب متابعة». */}
          {!isPrivateLocked && (
            <div dir="rtl" className="flex items-center gap-2 text-xs sm:gap-3 sm:text-sm">
              <div className="whitespace-nowrap"><span className="font-bold text-white">{formattedPostCount}</span> <span className="text-[#71767B]">المنشورات</span></div>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('aani:open-follow-list', { detail: { kind: 'following', targetUserId: activeUserId } }))}
                className="cursor-pointer whitespace-nowrap transition hover:opacity-80"
              >
                <span className="font-bold text-white">{formattedFollowing}</span> <span className="text-[#71767B]">متابع</span>
              </button>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('aani:open-follow-list', { detail: { kind: 'followers', targetUserId: activeUserId } }))}
                className="cursor-pointer whitespace-nowrap transition hover:opacity-80"
              >
                <span className="font-bold text-white">{formattedFollowers}</span> <span className="text-[#71767B]">المتابعون</span>
              </button>
            </div>
          )}
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

      {!isPrivateLocked && (own || profileHighlights.length > 0) && (
        <div className="mb-2 mt-6 px-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#F7F9F9]">أبرز القصص</h2>
          </div>
          <ProfileHighlightsRow
            collections={profileHighlights}
            onSelect={setSelectedHighlightCollection}
            onAdd={own ? () => setShowHighlightsManager(true) : undefined}
            addButtonId="openModalBtn"
          />
        </div>
      )}

      {isPrivateLocked && (
        <div className="mt-6 px-4">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#2F3336] bg-[#111] px-6 py-10 text-center">
            <span aria-hidden="true" className="grid h-14 w-14 place-items-center rounded-full border border-[#53575B] text-white">
              <Lock size={26} strokeWidth={1.8} />
            </span>
            <p className="text-[15px] font-bold text-white">هذا الحساب خاص</p>
            <p className="max-w-xs text-[13px] leading-6 text-[#71767B]">
              لا تُعرض المنشورات والريلز والقصص وأبرز القصص إلا للمتابعين الذين وافق صاحب الحساب على طلبهم.
            </p>
          </div>
        </div>
      )}

      {!isPrivateLocked && <ProfileTabs activeTab={profileContentTab} onChange={setProfileContentTab} />}

      {!isPrivateLocked && loading && (
        <GridSkeleton count={9} className="mt-4 gap-[2px] rounded-none" />
      )}
      {!isPrivateLocked && profileContentTab === 'tagged' && taggedLoading && (
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
      {!isPrivateLocked && !loading && !error && posts.length === 0 && profileContentTab !== 'tagged' && (
        <EmptyState className="mt-4 min-h-64" />
      )}
      {!isPrivateLocked && !loading && !error && (posts.length > 0 || profileContentTab === 'tagged') && (() => {
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
        if (profileContentTab === 'reposts' && repostsError) {
          // فشل قراءة سجلات reposts (RLS/جدول): حالة خطأ مرئية بدل تبويب فارغ مضلل
          return (
            <div className="mt-6 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-5 text-center" dir="rtl">
              <p className="text-sm font-semibold text-red-200">{repostsError}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black"
              >
                إعادة المحاولة
              </button>
            </div>
          );
        }
        if (!mediaPosts.length) {
          // الحالة الفارغة الموحدة: الشعار وكلمة «لا يوجد» فقط بلا حدود حمراء
          return <EmptyState className="min-h-64" />;
        }
        return (
          <ProfileMediaGrid
            posts={mediaPosts}
            variant={profileContentTab}
            onOpenPost={openProfileGridPost}
          />
        );
      })()}
      {!isPrivateLocked && feedViewerPostId && (feedViewerSource === 'reposts'
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
      {!isPrivateLocked && reelsPlayerPostId && (reelsPlayerSource === 'videos'
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
            <FollowButton
              targetUserId={activeUserId}
              currentUserId={currentUserId}
              isPrivate={person.is_private}
              followsMe={followsMe}
              initialFollowing={isFollowing}
              initialRequestSent={followRequestSent}
              disabled={profileActionBusy}
              className="ms-auto"
              onFollowingChange={next => {
                setFollowers(prev => Math.max(0, prev + (next ? 1 : -1)));
                setIsFollowing(next);
              }}
            />
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
      {avatarCropFile && typeof document !== 'undefined' && createPortal(
        <HighlightCoverCropper
          file={avatarCropFile}
          title="اقتصاص الصورة الشخصية"
          outputSuffix="-avatar"
          onCancel={() => {
            restoreAvatarPreviewAfterCancel();
          }}
          onSave={file => {
            setPendingAvatarFile(file);
            setImagePreview('avatar', URL.createObjectURL(file));
            setAvatarCropFile(null);
          }}
        />,
        document.body,
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
