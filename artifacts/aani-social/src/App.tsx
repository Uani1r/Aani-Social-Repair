import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { 
  ArrowUpLeft, Bell, Bookmark, Clock, Film, Filter, Heart, Home, 
  MessageCircle, MessageSquare, MoreVertical, Plus, Repeat, Search, Send, 
  Settings, Sparkles, Star, Trash2, UserRound, X, SendHorizontal, Pencil,
  ThumbsUp,
  Bot, Loader2, Play, Flag, Eye, EyeOff, Volume2, VolumeX, Type, Smile, Music2, AtSign, ChevronDown, Ban,
} from 'lucide-react';

import { toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadStoryMedia } from '@/lib/storyUpload';
import { usePosts } from '@/hooks/usePosts';
import { recordShare } from '@/lib/interactions';
import { displayName, formatDate, normalizeProfile, type Post, type Profile } from '@/lib/types';
import {
  clampCanvas,
  getStoryDrawPoint,
  isHorizontalGestureArea,
  STORY_DRAW_COLORS,
  STORY_DRAW_SIZES,
  STORY_VIEWER_PREVIEW_LIMIT,
  STORY_VIEWER_PREVIEW_TTL_MS,
  storyViewerDisplayName,
  type NotificationItem,
  type StoryDrawPoint,
  type StoryDrawStroke,
  type StoryGestureState,
  type StoryGestureTarget,
  type StoryViewerEntry,
  type StoryViewerPreviewRow,
  type StoryViewerPreviewSession,
  type StoryViewerPreviewState,
  type StoryViewerProfile,
} from '@/lib/appShared';

import NotFound from '@/pages/not-found';
import { AuthPage } from '@/pages/AuthPage';
import FeedPage from '@/pages/FeedPage';
import PostDetailPage from '@/pages/PostDetailPage';
import SearchPage from '@/pages/SearchPage';
import MessagesPage from '@/pages/MessagesPage';
import ProfilePage from '@/pages/ProfilePage';
import ReelsPage from '@/pages/ReelsPage';
import CreatePostModal from '@/components/CreatePostModal';
import SettingsModal from '@/components/SettingsModal';
import Shell from '@/components/Shell';
import StoryTypedPreview from '@/components/StoryTypedPreview';
import Avatar from './components/Avatar';
import AIAssistantModal from './components/AIAssistantModal';
import SharedPostPreview from './components/SharedPostPreview';
import FeedPostCard from './components/FeedPostCard';
import CommentsDrawer from './components/CommentsDrawer';
import ShareSheet from './components/ShareSheet';
import StoryComposerSheet from './components/StoryComposerSheet';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from './components/StoryDmCard';
import StoryCreationEditor from '@/components/StoryCreationEditor';
import type { MentionCandidate } from './components/StoryMentionPicker';
import {
  DEFAULT_ADJUSTMENTS as DEFAULT_FILTER_ADJUSTMENTS,
  buildStoryFilterCss,
  decodeStoryFilterKey,
  encodeStoryFilterKey,
  getStoryFilterOverlay,
  type StoryAdjustments,
} from '@/lib/storyFilters';
import {
  STORY_TEXT_BACKGROUNDS,
  nextStoryTextAlign,
  type StoryTextAlign,
  type StoryTextAnimation,
} from '@/lib/storyFonts';
import '@/index.css';

// --- شريط القصص الموحد ---

function StoriesBar({
  userId,
  currentProfile,
  pendingReshare,
  onReshareHandled,
  pendingProfileStoryOwnerId,
  onProfileStoryHandled,
}: {
  userId: string;
  currentProfile: Profile | null;
  pendingReshare: StoryDmCardStory | null;
  onReshareHandled: () => void;
  pendingProfileStoryOwnerId: string | null;
  onProfileStoryHandled: () => void;
}) {
  const [groupedStories, setGroupedStories] = useState<{ [key: string]: any[] }>({});
  const [activeUserGroup, setActiveUserGroup] = useState<string | null>(null);
  const [activeStoryIndex, setActiveStoryIndex] = useState(0);
  const [profileStoryOwnerId, setProfileStoryOwnerId] = useState<string | null>(null);
  const [profilePreviewStories, setProfilePreviewStories] = useState<any[]>([]);

  // تُحفظ معرّفات القصص التي شاهدها المستخدم، لا معرّفات أصحابها.
  const seenStoryStorageKey = `aani:seen-story-ids:${userId}`;
  const [seenStoryIds, setSeenStoryIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(seenStoryStorageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') as string[] : [];
    } catch {
      return [];
    }
  });

  const markStorySeen = useCallback((storyId: string) => {
    if (!storyId) return;

    setSeenStoryIds(previous => {
      if (previous.includes(storyId)) return previous;

      const next = [...previous, storyId];
      try {
        localStorage.setItem(seenStoryStorageKey, JSON.stringify(next));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      return next;
    });
  }, [seenStoryStorageKey]);

  const [showUI, setShowUI] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [replyText, setReplyText] = useState('');
  const [replyFocused, setReplyFocused] = useState(false);
  const [replyKeyboardInset, setReplyKeyboardInset] = useState(0);
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isLikeSaving, setIsLikeSaving] = useState(false);
  const [storyViewsOpen, setStoryViewsOpen] = useState(false);
  const [storyViewsLoading, setStoryViewsLoading] = useState(false);
  const [storyViewsError, setStoryViewsError] = useState(false);
  const [storyViewsCount, setStoryViewsCount] = useState(0);
  const [storyViewers, setStoryViewers] = useState<StoryViewerEntry[]>([]);
  const [storyViewerPreview, setStoryViewerPreview] = useState<StoryViewerPreviewState | null>(null);
  const [viewerActionBusyId, setViewerActionBusyId] = useState<string | null>(null);
  const [viewerReportTarget, setViewerReportTarget] = useState<StoryViewerEntry | null>(null);
  const [viewerReportCategory, setViewerReportCategory] = useState<'spam' | 'harassment' | 'hate' | 'fake_account' | 'other'>('spam');
  const [viewerReportDetails, setViewerReportDetails] = useState('');
  const [viewerReportBusy, setViewerReportBusy] = useState(false);
  const [viewerRowMenuOpen, setViewerRowMenuOpen] = useState(false);
  const storyViewerTouchStartRef = useRef<{
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    pathLength: number;
    startedInViewersPanel: boolean;
  } | null>(null);
  const storyViewerPausedBeforeTouchRef = useRef(false);
  const suppressStoryClickUntilRef = useRef(0);
  const storyViewsWasPausedRef = useRef(false);
  const storyVideoRef = useRef<HTMLVideoElement | null>(null);
  const storyVideoWasPlayingRef = useRef(false);
  const storyViewsRequestRef = useRef(0);
  const storyViewsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [originalStoryAuthor, setOriginalStoryAuthor] = useState<NonNullable<StoryDmCardStory['author']> | null>(null);
  const [showMenu, setShowMenu] = useState(false);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showStoryPicker, setShowStoryPicker] = useState(false);

  // أثناء شاشات القصص (اختيار/معاينة/عارض القصص) تُخفى أشرطة التطبيق وتُعزل الحركات
  useEffect(() => {
    const immersive = showStoryPicker || showUploadModal || Boolean(activeUserGroup);
    document.body.classList.toggle('aani-immersive', immersive);

    return () => {
      document.body.classList.remove('aani-immersive');
    };
  }, [showStoryPicker, showUploadModal, activeUserGroup]);
  const [storyFile, setStoryFile] = useState<File | null>(null);
  const [previewStoryUrl, setPreviewStoryUrl] = useState<string | null>(null);
  const [reshareStory, setReshareStory] = useState<StoryDmCardStory | null>(null);
  const [reshareScaledDown, setReshareScaledDown] = useState(false);

  const [storyMoreOpen, setStoryMoreOpen] = useState(false);
  const [storyDurationOpen, setStoryDurationOpen] = useState(false);
  const [storyDrawingOpen, setStoryDrawingOpen] = useState(false);
  const [storyDrawColor, setStoryDrawColor] = useState(STORY_DRAW_COLORS[0]);
  const [storyDrawSize, setStoryDrawSize] = useState(STORY_DRAW_SIZES[1]);
  const [storyDrawStrokes, setStoryDrawStrokes] = useState<StoryDrawStroke[]>([]);
  const storyDrawingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeStoryDrawStrokeRef = useRef<StoryDrawStroke | null>(null);
  // أدوات إضافية للمحرر: الأصدقاء المقربون ومدة عرض القصة على الشاشة.
  const storyExtraTools: Array<{ key: string; label: string; action: () => void }> = [
    {
      key: 'close-friends',
      label: 'الأصدقاء المقربون',
      action: () => {
        setStoryDurationOpen(false);
        setStoryMoreOpen(false);
        setCloseFriendsOpen(true);
      },
    },
    {
      key: 'duration',
      label: 'مدة عرض الستوري',
      action: () => setStoryDurationOpen(open => !open),
    },
  ];
  const [storyFiltersOpen, setStoryFiltersOpen] = useState(false);
  const [storyFilterId, setStoryFilterId] = useState('original');
  const [storyFilterAdjustments, setStoryFilterAdjustments] = useState<StoryAdjustments>(DEFAULT_FILTER_ADJUSTMENTS);
  const storyFilterValue = buildStoryFilterCss(storyFilterId, storyFilterAdjustments);
  const storyFilterOverlay = getStoryFilterOverlay(storyFilterId);
  // مقطع موسيقي مختار (يُحفظ للاستخدام عند تفعيل المزوّد الحقيقي)
  const [storyMusicOpen, setStoryMusicOpen] = useState(false);
  const [storyMusicTrack, setStoryMusicTrack] = useState<{ id: string; title: string; artist: string } | null>(null);
  // أشخاص تمت الإشارة إليهم (مخفيون بصرياً، يُحفظون مع القصة)
  const [storyMentionsOpen, setStoryMentionsOpen] = useState(false);
  const [storyMentions, setStoryMentions] = useState<MentionCandidate[]>([]);
  const [closeFriendsOpen, setCloseFriendsOpen] = useState(false);
  const storyToolsRef = useRef<HTMLDivElement | null>(null);


  // محرر النص الغني للقصة
  const [storyTextEditorOpen, setStoryTextEditorOpen] = useState(false);
  const [storyText, setStoryText] = useState('');
  const [storyKeyboardInset, setStoryKeyboardInset] = useState(0);

  // نمط نص القصة: الخط + اللون + المحاذاة + الحركة + الخلفية
  const [storyFontFamily, setStoryFontFamily] = useState('Cairo');
  const [storyTextColor, setStoryTextColor] = useState('#FFFFFF');
  const [storyTextAlign, setStoryTextAlign] = useState<StoryTextAlign>('center');
  const [storyTextAnimation, setStoryTextAnimation] = useState<StoryTextAnimation>('none');
  const [storyBackgroundIndex, setStoryBackgroundIndex] = useState(0);
  const [storyTypedLength, setStoryTypedLength] = useState(0);
  const [storyAnimationTick, setStoryAnimationTick] = useState(0);
  const storyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // مرجع لحالة النوافذ الفرعية داخل معالجات اللمس (لتجنّب قراءة حالة قديمة)
  const storyPanelsRef = useRef({ filters: false, textEditor: false, more: false, drawing: false });

  useEffect(() => {
    storyPanelsRef.current = {
      filters: storyFiltersOpen,
      textEditor: storyTextEditorOpen,
      more: storyMoreOpen,
      drawing: storyDrawingOpen,
    };
  }, [storyFiltersOpen, storyTextEditorOpen, storyMoreOpen, storyDrawingOpen]);

  // تُغلق النوافذ الفرعية وحدها دون فتح أي أداة أخرى
  const closeStoryPanels = useCallback(() => {
    setStoryFiltersOpen(false);
    setStoryTextEditorOpen(false);
    setStoryMoreOpen(false);
    setStoryDrawingOpen(false);
  }, []);

  const storyBackgroundPreset = STORY_TEXT_BACKGROUNDS[storyBackgroundIndex % STORY_TEXT_BACKGROUNDS.length];
  const storyHasBackground = storyBackgroundPreset.key !== 'none';

  // معاينة حيّة داخل المحرر: تُظهر الخط واللون والخلفية والحركة على النص نفسه
  const storyEditorPreviewMode =
    storyText.trim().length > 0 && (storyTextAnimation !== 'none' || storyHasBackground);

  const storyPreviewClassName = [
    'pointer-events-none absolute inset-x-0 top-0 whitespace-pre-wrap break-words font-bold',
    storyHasBackground ? 'mx-auto w-fit max-w-full' : '',
    storyTextAnimation === 'none' ? '' : `aani-story-anim-${storyTextAnimation}`,
  ]
    .filter(Boolean)
    .join(' ');

  // إعادة التركيز على حقل النص حتى لا تختفي لوحة المفاتيح عند استخدام الشريط
  const keepStoryEditorFocus = useCallback(() => {
    const field = storyTextAreaRef.current;
    if (!field) return;
    if (document.activeElement === field) return;
    field.focus({ preventScroll: true });
  }, []);

  // تكبير حقل النص تلقائياً مع طول الكتابة
  useEffect(() => {
    const field = storyTextAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [storyText, storyFontFamily, storyTextAlign, storyTextEditorOpen]);

  // محرك إيماءات واحد: يُقفل التفاعل كلياً على العنصر الذي بدأ منه اللمس
  const [storyCanvasScale, setStoryCanvasScale] = useState(1);
  const [storyCanvasOffset, setStoryCanvasOffset] = useState({ x: 0, y: 0 });

  const [storyMediaZoom, setStoryMediaZoom] = useState(1);
  const [storyMediaRotate, setStoryMediaRotate] = useState(0);
  const [storyMediaOffset, setStoryMediaOffset] = useState({ x: 0, y: 0 });

  const [storyTextOffset, setStoryTextOffset] = useState({ x: 0, y: 0 });
  const [storyTextScale, setStoryTextScale] = useState(1);
  const [storyTextRotation, setStoryTextRotation] = useState(0);

  const storyGestureRef = useRef<StoryGestureState | null>(null);
  const lastStoryTouchRef = useRef(0);

  // قيم المرجع حسب العنصر المقفل
  const readStoryGestureBase = (target: StoryGestureTarget) => {
    if (target === 'text') {
      return { x: storyTextOffset.x, y: storyTextOffset.y, scale: storyTextScale, rotate: storyTextRotation };
    }

    if (target === 'image') {
      return { x: storyMediaOffset.x, y: storyMediaOffset.y, scale: storyMediaZoom, rotate: storyMediaRotate };
    }

    return { x: storyCanvasOffset.x, y: storyCanvasOffset.y, scale: storyCanvasScale, rotate: 0 };
  };

  const storyTouchCenter = (touches: React.TouchList) => {
    const [first, second] = [touches[0], touches[1]];
    return {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
      dist: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
      angle: (Math.atan2(second.clientY - first.clientY, second.clientX - first.clientX) * 180) / Math.PI,
    };
  };

  // بدء الإيماءة: يُقفل الهدف من أول لمسة فقط
  const startStoryGesture = (event: React.TouchEvent, target: StoryGestureTarget) => {
    const base = readStoryGestureBase(target);
    const touches = event.touches;
    if (!touches.length) return;

    if (touches.length >= 2) {
      const center = storyTouchCenter(touches);
      storyGestureRef.current = {
        target,
        touchCount: 2,
        startX: center.x,
        startY: center.y,
        startDist: center.dist,
        startAngle: center.angle,
        ...base,
        moved: true,
        startTime: Date.now(),
      };
      return;
    }

    const touch = touches[0];
    storyGestureRef.current = {
      target,
      touchCount: 1,
      startX: touch.clientX,
      startY: touch.clientY,
      startDist: 0,
      startAngle: 0,
      ...base,
      moved: false,
      startTime: Date.now(),
    };
  };

  const handleStoryCanvasTouchStart = (event: React.TouchEvent) => {
    event.stopPropagation();

    const element = event.target as HTMLElement | null;
    const gesture = storyGestureRef.current;

    // إصبع إضافي أثناء الإيماءة: يبقى الهدف مقفلاً ويُعاد ضبط المرجع فقط
    if (gesture) {
      if (event.touches.length >= 2) {
        const center = storyTouchCenter(event.touches);
        storyGestureRef.current = {
          ...gesture,
          touchCount: 2,
          startX: center.x,
          startY: center.y,
          startDist: center.dist,
          startAngle: center.angle,
          ...readStoryGestureBase(gesture.target),
          moved: true,
        };
      }
      return;
    }

    const target: StoryGestureTarget = element?.closest('[data-story-text]')
      ? 'text'
      : element?.closest('[data-story-media]')
        ? 'image'
        : 'canvas';

    startStoryGesture(event, target);
  };

  const handleStoryCanvasTouchMove = (event: React.TouchEvent) => {
    const gesture = storyGestureRef.current;
    if (!gesture) return;
    event.stopPropagation();

    const touches = event.touches;
    if (!touches.length) return;

    // تغيّر عدد الأصابع: إعادة ضبط المرجع لمنع القفزات
    if (touches.length !== gesture.touchCount) {
      if (touches.length >= 2) {
        const center = storyTouchCenter(touches);
        storyGestureRef.current = {
          ...gesture,
          touchCount: 2,
          startX: center.x,
          startY: center.y,
          startDist: center.dist,
          startAngle: center.angle,
          ...readStoryGestureBase(gesture.target),
          moved: true,
        };
      } else {
        const touch = touches[0];
        storyGestureRef.current = {
          ...gesture,
          touchCount: 1,
          startX: touch.clientX,
          startY: touch.clientY,
          startDist: 0,
          startAngle: 0,
          ...readStoryGestureBase(gesture.target),
        };
      }
      return;
    }

    // تُقاس الحركة داخل نظام لوحة القصة نفسها
    const scaleFactor = 1 / Math.max(0.4, storyCanvasScale);

    if (touches.length >= 2) {
      const center = storyTouchCenter(touches);
      const ratio = gesture.startDist > 0 ? center.dist / gesture.startDist : 1;
      const deltaAngle = center.angle - gesture.startAngle;
      const deltaX = (center.x - gesture.startX) / scaleFactor;
      const deltaY = (center.y - gesture.startY) / scaleFactor;

      gesture.moved = true;

      if (gesture.target === 'text') {
        setStoryTextScale(Math.min(5, Math.max(0.3, gesture.scale * ratio)));
        setStoryTextRotation(gesture.rotate + deltaAngle);
        setStoryTextOffset({
          x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.45),
          y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.45),
        });
        return;
      }

      if (gesture.target === 'image') {
        setStoryMediaZoom(Math.min(4, Math.max(0.4, gesture.scale * ratio)));
        setStoryMediaRotate(gesture.rotate + deltaAngle);
        setStoryMediaOffset({
          x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.6),
          y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.6),
        });
        return;
      }

      setStoryCanvasScale(Math.min(3, Math.max(0.6, gesture.scale * ratio)));
      setStoryCanvasOffset({
        x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.45),
        y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.45),
      });
      return;
    }

    const touch = touches[0];
    const deltaX = (touch.clientX - gesture.startX) * (1 / Math.max(0.4, storyCanvasScale));
    const deltaY = (touch.clientY - gesture.startY) * (1 / Math.max(0.4, storyCanvasScale));
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) gesture.moved = true;

    if (gesture.target === 'text') {
      setStoryTextOffset({
        x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.45),
        y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.4),
      });
      return;
    }

    if (gesture.target === 'image') {
      setStoryMediaOffset({
        x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.6),
        y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.6),
      });
      return;
    }
  };

  const handleStoryCanvasTouchEnd = (event: React.TouchEvent) => {
    const gesture = storyGestureRef.current;
    if (!gesture) return;
    event.stopPropagation();

    if (event.touches.length > 0) {
      const touches = event.touches;
      if (touches.length >= 2) {
        const center = storyTouchCenter(touches);
        storyGestureRef.current = {
          ...gesture,
          touchCount: 2,
          startDist: center.dist,
          startAngle: center.angle,
          startX: center.x,
          startY: center.y,
          moved: gesture.moved,
        };
      } else {
        const touch = touches[0];
        storyGestureRef.current = {
          ...gesture,
          touchCount: 1,
          startX: touch.clientX,
          startY: touch.clientY,
          startDist: 0,
          startAngle: 0,
          moved: gesture.moved,
        };
      }
      return;
    }

    storyGestureRef.current = null;
    if (reshareStory) lastStoryTouchRef.current = Date.now();

    // نقرة قصيرة: إن كانت إحدى النوافذ الفرعية مفتوحة تُغلق فقط،
    // وإلا تُفتح نافذة كتابة النص (الوضع الأساسي فقط)
    if (!gesture.moved && Date.now() - gesture.startTime < 400) {
      if (reshareStory) {
        setReshareScaledDown(current => !current);
        return;
      }
      const panels = storyPanelsRef.current;
      if (panels.filters || panels.textEditor || panels.more || panels.drawing) {
        closeStoryPanels();
        return;
      }
      setStoryTextEditorOpen(true);
    }
  };



  // إبقاء شريط أدوات النص فوق لوحة المفاتيح
  useEffect(() => {
    if (!storyTextEditorOpen) {
      setStoryKeyboardInset(0);
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateInset = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setStoryKeyboardInset(inset);
    };

    updateInset();
    viewport.addEventListener('resize', updateInset);
    viewport.addEventListener('scroll', updateInset);

    return () => {
      viewport.removeEventListener('resize', updateInset);
      viewport.removeEventListener('scroll', updateInset);
    };
  }, [storyTextEditorOpen]);

  // حركة الآلة الكاتبة: إظهار النص حرفاً بحرف بعد إغلاق المحرر
  useEffect(() => {
    if (storyTextAnimation !== 'typewriter' || storyTextEditorOpen || !storyText.trim()) {
      setStoryTypedLength(storyText.length);
      return;
    }

    setStoryTypedLength(0);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setStoryTypedLength(index);
      if (index >= storyText.length) {
        window.clearInterval(timer);
      }
    }, 65);

    return () => window.clearInterval(timer);
  }, [storyText, storyTextAnimation, storyTextEditorOpen]);

  const visibleStoryText =
    storyTextAnimation === 'typewriter' && !storyTextEditorOpen
      ? storyText.slice(0, storyTypedLength)
      : storyText;

  useEffect(() => {
    if (!storyMoreOpen) return;

    const onDocumentClick = (event: MouseEvent) => {
      if (!storyToolsRef.current?.contains(event.target as Node)) {
        setStoryMoreOpen(false);
        setStoryDurationOpen(false);
      }
    };

    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [storyMoreOpen]);

  useEffect(() => {
    if (!storyFile) {
      setPreviewStoryUrl(null);
      return;
    }

    const url = URL.createObjectURL(storyFile);
    setPreviewStoryUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [storyFile]);
  const [caption, setCaption] = useState('');
  const [isCloseFriendsOnly, setIsCloseFriendsOnly] = useState(false);
  const [uploadDuration, setUploadDuration] = useState<number>(60);
  const storyDurationManuallyChosenRef = useRef(true);
  const [timedTexts, setTimedTexts] = useState<Array<{ id: string; text: string; startTime: number; endTime: number; x: number; y: number }>>([]);
  const [newText, setNewText] = useState('');
  const [textStart, setTextStart] = useState(0);
  const [textEnd, setTextEnd] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    if (!pendingReshare) return;
    const expiresAt = pendingReshare.expires_at ? Date.parse(pendingReshare.expires_at) : Number.NaN;
    if (!pendingReshare.media_url || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      toast.error('هذه القصة لم تعد متاحة لإعادة المشاركة');
      onReshareHandled();
      return;
    }

    setStoryFile(null);
    setStoryDrawStrokes([]);
    setStoryDrawingOpen(false);
    activeStoryDrawStrokeRef.current = null;
    setReshareStory(pendingReshare);
    setReshareScaledDown(true);
    setCaption(pendingReshare.caption || '');
    setStoryText('');
    setStoryCanvasScale(1);
    setStoryCanvasOffset({ x: 0, y: 0 });
    setStoryMediaZoom(1);
    setStoryMediaRotate(0);
    setStoryMediaOffset({ x: 0, y: 0 });
    setStoryTextOffset({ x: 0, y: 0 });
    setStoryTextScale(1);
    setStoryTextRotation(0);
    setStoryMentions([]);
    setStoryFilterId('original');
    setStoryFilterAdjustments(DEFAULT_FILTER_ADJUSTMENTS);
    storyDurationManuallyChosenRef.current = true;
    setUploadDuration(Math.min(120, Math.max(5, pendingReshare.duration_seconds || 60)));
    setStoryDurationOpen(false);
    setShowUploadModal(true);
    onReshareHandled();
  }, [pendingReshare, onReshareHandled]);

  const editorMediaUrl = reshareStory?.media_url || previewStoryUrl;
  const editorIsVideo = reshareStory
    ? reshareStory.media_type === 'video'
    : Boolean(storyFile?.type.startsWith('video'));

  const fetchStories = useCallback(async () => {
    if (!supabaseConfigured || !userId) return;

    const { data: followings, error: followingsError } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', userId);
    if (followingsError) console.warn('[stories] تعذر تحميل قائمة المتابَعين:', followingsError);

    const followedIds = (followings || []).map(f => f.following_id);
    const allowedUserIds = [userId, ...followedIds];

    // صلاحية القصة ووقت انتهائها يتحقق منهما RLS بساعة قاعدة البيانات، لا ساعة الجهاز.
    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .in('user_id', allowedUserIds)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[stories] تعذر جلب القصص:', error);
      setGroupedStories({});
      toast.error(`تعذر تحميل القصص من قاعدة البيانات: ${error.message}`);
      return;
    }

    const storyRows = data || [];
    const authorIds = [...new Set(storyRows.map(story => String(story.user_id)))];
    const { data: authors, error: authorsError } = authorIds.length
      ? await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', authorIds)
      : { data: [], error: null };
    if (authorsError) console.warn('[stories] تعذر تحميل ملفات أصحاب القصص:', authorsError);

    const authorById = new Map<string, any>((authors || []).map(author => [String(author.id), author] as [string, any]));
    const groups: { [key: string]: any[] } = {};
    storyRows.forEach(story => {
      const authorId = String(story.user_id);
      if (!groups[authorId]) groups[authorId] = [];
      groups[authorId].push({ ...story, author: authorById.get(authorId) || null });
    });
    setGroupedStories(groups);
  }, [userId]);

  useEffect(() => { void fetchStories(); }, [fetchStories]);

  const activeStories = useMemo(() => {
    if (activeUserGroup && activeUserGroup === profileStoryOwnerId) return profilePreviewStories;
    return activeUserGroup && groupedStories[activeUserGroup] ? groupedStories[activeUserGroup] : [];
  }, [activeUserGroup, groupedStories, profileStoryOwnerId, profilePreviewStories]);

  useEffect(() => {
    if (!pendingProfileStoryOwnerId) return;
    if (!supabaseConfigured) {
      toast.error('تعذر تحميل قصص هذا الحساب');
      onProfileStoryHandled();
      return;
    }

    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('stories')
          .select('*')
          .eq('user_id', pendingProfileStoryOwnerId)
          .order('created_at', { ascending: true });
        if (!active) return;
        if (error) {
          console.error('[stories] تعذر تحميل قصص الملف الشخصي:', error);
          toast.error(`تعذر تحميل القصص من قاعدة البيانات: ${error.message}`);
          onProfileStoryHandled();
          return;
        }
        if (!data?.length) {
          toast.info('لا توجد قصص متاحة لهذا الحساب');
          onProfileStoryHandled();
          return;
        }

        const { data: author, error: authorError } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .eq('id', pendingProfileStoryOwnerId)
          .maybeSingle();
        if (!active) return;
        if (authorError) console.warn('[stories] تعذر تحميل ملف صاحب القصة:', authorError);
        const storiesWithAuthor = data.map(story => ({ ...story, author: author || null }));

        setProfileStoryOwnerId(pendingProfileStoryOwnerId);
        setProfilePreviewStories(storiesWithAuthor);
        setActiveUserGroup(pendingProfileStoryOwnerId);
        setActiveStoryIndex(0);
        setProgress(0);
        setCurrentTimeSec(0);
        onProfileStoryHandled();
      } catch (error) {
        if (!active) return;
        console.error('[stories] فشل طلب قصص الملف الشخصي:', error);
        toast.error('تعذر تحميل القصص. تحقق من الاتصال ثم أعد المحاولة.');
        onProfileStoryHandled();
      }
    })();

    return () => {
      active = false;
    };
  }, [pendingProfileStoryOwnerId, onProfileStoryHandled]);

  const currentStory = activeStories[activeStoryIndex] || null;
  const isStoryOwner = Boolean(currentStory && currentStory.user_id === userId);
  const fallbackStoryDuration = 60;
  const storedStoryDuration = Number(currentStory?.duration_seconds);
  const storyDisplayDuration = currentStory
    ? Math.min(120, Math.max(5, storedStoryDuration || fallbackStoryDuration))
    : 60;
  const currentStoryFilter = decodeStoryFilterKey((currentStory as { filter_key?: string } | null)?.filter_key);
  useEffect(() => {
    const originalStoryId = (currentStory as { original_story_id?: string } | null)?.original_story_id;
    if (!originalStoryId || !supabaseConfigured) {
      setOriginalStoryAuthor(null);
      return;
    }

    let active = true;
    setOriginalStoryAuthor(null);
    void (async () => {
      try {
        const { data: originalStory, error } = await supabase
          .from('stories')
          .select('user_id')
          .eq('id', originalStoryId)
          .maybeSingle();
        if (error) throw error;
        if (!originalStory) return;

        const { data: author, error: authorError } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .eq('id', originalStory.user_id)
          .maybeSingle();
        if (authorError) console.warn('[stories] تعذر تحميل ملف صاحب القصة الأصلية:', authorError);
        if (active) setOriginalStoryAuthor((author as StoryDmCardStory['author']) ?? null);
      } catch (error) {
        if (active) console.warn('[stories] تعذر تحميل بيانات القصة الأصلية:', error);
      }
    })();

    return () => {
      active = false;
    };
  }, [currentStory]);
  const currentStoryFilterOverlay = getStoryFilterOverlay(currentStoryFilter.id);
  const myStories = groupedStories[userId] || [];
  const hasMyStory = myStories.length > 0;
  const myStoryHasCloseFriends = myStories.some(story => story.is_close_friends);
  const hasSeenAllStories = (stories: any[]) =>
    stories.length > 0 && stories.every(story => seenStoryIds.includes(String(story.id)));
  const hasSeenAllMyStories = hasSeenAllStories(myStories);

  useEffect(() => {
    setReplyText('');
    setReplyFocused(false);
    setReplyKeyboardInset(0);
    setStoryViewsOpen(false);
    setStoryViewsLoading(false);
    setStoryViewsError(false);
    setStoryViewsCount(0);
    setStoryViewers([]);
    setViewerReportTarget(null);
    setViewerRowMenuOpen(false);
    setIsPaused(false);
    storyViewsWasPausedRef.current = false;
    storyViewsRequestRef.current += 1;

    return () => {
      storyViewsRequestRef.current += 1;
      if (storyViewsChannelRef.current) {
        void supabase.removeChannel(storyViewsChannelRef.current);
        storyViewsChannelRef.current = null;
      }
    };
  }, [currentStory?.id]);

  useEffect(() => {
    if (!storyViewerPreview) return;
    const preview = storyViewerPreview;
    const expirePreview = () => {
      try {
        localStorage.setItem(preview.storageKey, JSON.stringify({
          profileIds: [],
          createdAt: preview.createdAt,
          expiresAt: preview.expiresAt,
          expired: true,
        } satisfies StoryViewerPreviewSession));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      setStoryViewerPreview(current => current?.storageKey === preview.storageKey ? null : current);
    };
    const remaining = preview.expiresAt - Date.now();
    if (remaining <= 0) {
      expirePreview();
      return;
    }
    const timer = window.setTimeout(expirePreview, remaining);
    return () => window.clearTimeout(timer);
  }, [storyViewerPreview]);

  useEffect(() => {
    const expireStoredPreviews = () => {
      try {
        const prefix = 'aani:story-viewer-preview:';
        let index = 0;
        while (index < localStorage.length) {
          const key = localStorage.key(index);
          if (!key || !key.startsWith(prefix)) {
            index += 1;
            continue;
          }

          let session: Partial<StoryViewerPreviewSession> | null = null;
          try {
            session = JSON.parse(localStorage.getItem(key) || 'null') as Partial<StoryViewerPreviewSession> | null;
          } catch {
            localStorage.removeItem(key);
            continue;
          }
          if (!session || !Number.isFinite(session.expiresAt) || !Number.isFinite(session.createdAt)) {
            localStorage.removeItem(key);
            continue;
          }
          if ((session.expiresAt as number) <= Date.now() && !session.expired) {
            localStorage.setItem(key, JSON.stringify({
              profileIds: [],
              createdAt: session.createdAt,
              expiresAt: session.expiresAt,
              expired: true,
            } satisfies StoryViewerPreviewSession));
            setStoryViewerPreview(current => current?.storageKey === key ? null : current);
          }
          index += 1;
        }
      } catch {
        /* التخزين المحلي غير متاح */
      }
    };

    expireStoredPreviews();
    const timer = window.setInterval(expireStoredPreviews, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!currentStory || isStoryOwner || !supabaseConfigured) {
      setIsLiked(false);
      return;
    }

    let active = true;
    void supabase
      .from('story_likes')
      .select('id')
      .eq('story_id', currentStory.id)
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.error('[story likes] تعذر تحميل حالة الإعجاب:', error);
          return;
        }
        setIsLiked(Boolean(data));
      })
      .catch(error => {
        if (active) console.error('[story likes] تعذر تحميل حالة الإعجاب:', error);
      });

    return () => {
      active = false;
    };
  }, [currentStory?.id, isStoryOwner, userId]);

  useEffect(() => {
    if (!currentStory || isStoryOwner || !userId || !supabaseConfigured) return;

    let active = true;
    void supabase
      .rpc('aani_record_story_view', { p_story_id: currentStory.id })
      .then(({ error }) => {
        if (active && error) {
          console.warn('[story views] تعذر تسجيل المشاهدة في الخلفية:', error);
        }
      })
      .catch(error => {
        if (active) {
          console.warn('[story views] تعذر تسجيل المشاهدة في الخلفية:', error);
        }
      });

    return () => {
      active = false;
    };
  }, [currentStory?.id, isStoryOwner, userId]);

  useEffect(() => {
    if (!replyFocused || isStoryOwner) {
      setReplyKeyboardInset(0);
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateInset = () => {
      setReplyKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    };

    updateInset();
    viewport.addEventListener('resize', updateInset);
    viewport.addEventListener('scroll', updateInset);
    return () => {
      viewport.removeEventListener('resize', updateInset);
      viewport.removeEventListener('scroll', updateInset);
    };
  }, [replyFocused, isStoryOwner]);

  useEffect(() => {
    if (!currentStory || isPaused || storyViewsOpen) return;
    const duration = storyDisplayDuration * 1000;
    const interval = 50;
    const step = (interval / duration) * 100;

    const timer = setInterval(() => {
      setProgress(prev => {
        const nextProg = prev + step;
        setCurrentTimeSec((nextProg / 100) * storyDisplayDuration);
        if (nextProg >= 100) {
          handleNextStory();
          return 0;
        }
        return nextProg;
      });
    }, interval);

    return () => clearInterval(timer);
  }, [currentStory, storyDisplayDuration, isPaused, storyViewsOpen, activeStoryIndex, activeUserGroup]);

  const handleNextStory = () => {
    if (currentStory?.id) markStorySeen(String(currentStory.id));

    if (activeStoryIndex < activeStories.length - 1) {
      setActiveStoryIndex(prev => prev + 1);
      setProgress(0);
      setCurrentTimeSec(0);
    } else {
      const userIds = Object.keys(groupedStories);
      const currentIdx = userIds.indexOf(activeUserGroup || '');
      if (currentIdx !== -1 && currentIdx < userIds.length - 1) {
        setActiveUserGroup(userIds[currentIdx + 1]);
        setActiveStoryIndex(0);
        setProgress(0);
        setCurrentTimeSec(0);
      } else {
        setActiveUserGroup(null);
      }
    }
  };

  const handlePrevStory = () => {
    if (activeStoryIndex > 0) {
      setActiveStoryIndex(prev => prev - 1);
      setProgress(0);
      setCurrentTimeSec(0);
    } else {
      const userIds = Object.keys(groupedStories);
      const currentIdx = userIds.indexOf(activeUserGroup || '');
      if (currentIdx > 0) {
        const prevUser = userIds[currentIdx - 1];
        setActiveUserGroup(prevUser);
        setActiveStoryIndex(groupedStories[prevUser].length - 1);
        setProgress(0);
        setCurrentTimeSec(0);
      }
    }
  };

  const handleAddTimedText = () => {
    if (!newText.trim()) return;
    setTimedTexts([...timedTexts, {
      id: Math.random().toString(),
      text: newText.trim(),
      startTime: textStart,
      endTime: textEnd,
      x: 50,
      y: 50
    }]);
    setNewText('');
  };

  const loadStoryViewerEntries = async (storyId: string, requestId: number) => {
    const [viewsResult, likesResult] = await Promise.all([
      supabase
        .from('story_views')
        .select('user_id, viewed_at, viewer:profiles(id, username, full_name, display_name, avatar_url, is_private)', { count: 'exact' })
        .eq('story_id', storyId)
        .order('viewed_at', { ascending: true }),
      supabase
        .from('story_likes')
        .select('user_id')
        .eq('story_id', storyId),
    ]);
    if (viewsResult.error) throw viewsResult.error;
    if (likesResult.error) throw likesResult.error;
    if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return null;

    const likedUserIds = new Set((likesResult.data || []).map(item => String(item.user_id)));
    const viewerIds = [...new Set((viewsResult.data || []).map(item => String(item.user_id)))];
    let followedIds = new Set<string>();
    let pendingIds = new Set<string>();
    if (userId && viewerIds.length > 0) {
      const [followsResult, requestsResult] = await Promise.all([
        supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', userId)
          .in('following_id', viewerIds),
        supabase
          .from('follow_requests')
          .select('recipient_id')
          .eq('requester_id', userId)
          .in('recipient_id', viewerIds),
      ]);
      if (followsResult.error) {
        console.warn('[story views] تعذر تحميل حالات المتابعة:', followsResult.error);
      } else {
        followedIds = new Set((followsResult.data || []).map(item => String(item.following_id)));
      }
      if (requestsResult.error) {
        console.warn('[story views] تعذر تحميل طلبات المتابعة:', requestsResult.error);
      } else {
        pendingIds = new Set((requestsResult.data || []).map(item => String(item.recipient_id)));
      }
    }

    if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return null;
    const rows = (viewsResult.data || []).map(item => ({
      ...item,
      is_liked: likedUserIds.has(String(item.user_id)),
      is_following: followedIds.has(String(item.user_id)),
      follow_request_pending: pendingIds.has(String(item.user_id)),
    })) as StoryViewerEntry[];
    setStoryViewers(rows);
    setStoryViewsCount(viewsResult.count ?? rows.length);
    return rows;
  };

  const loadStoryViewerPreview = async (storyId: string, actualViewerIds: string[], requestId: number) => {
    if (!userId) return;
    const storageKey = `aani:story-viewer-preview:${userId}:session`;
    let session: StoryViewerPreviewSession | null = null;

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<StoryViewerPreviewSession>;
        if (
          Array.isArray(parsed.profileIds)
          && parsed.profileIds.every(id => typeof id === 'string')
          && Number.isFinite(parsed.createdAt)
          && Number.isFinite(parsed.expiresAt)
        ) {
          session = {
            profileIds: parsed.profileIds as string[],
            createdAt: parsed.createdAt as number,
            expiresAt: parsed.expiresAt as number,
            expired: parsed.expired === true,
          };
        }
      }
    } catch {
      session = null;
    }

    if (session && (session.expired || session.expiresAt <= Date.now())) {
      const expiredSession: StoryViewerPreviewSession = {
        ...session,
        profileIds: [],
        expired: true,
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(expiredSession));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      setStoryViewerPreview(null);
      return;
    }

    let profileRows: StoryViewerProfile[] = [];
    if (session?.profileIds.length) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url')
        .in('id', session.profileIds);
      if (error) throw error;
      const profileById = new Map<string, StoryViewerProfile>(
        ((data || []) as StoryViewerProfile[]).map(profile => [String(profile.id), profile] as [string, StoryViewerProfile]),
      );
      profileRows = session.profileIds
        .map(id => profileById.get(id))
        .filter((profile): profile is StoryViewerProfile => Boolean(profile));
    } else if (!session) {
      const actualIds = new Set(actualViewerIds);
      const pageSize = 100;
      let offset = 0;
      while (profileRows.length < STORY_VIEWER_PREVIEW_LIMIT) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url')
          .neq('id', userId)
          .order('created_at', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        const page = (data || []) as StoryViewerProfile[];
        profileRows.push(...page.filter(profile => profile.id !== userId && !actualIds.has(String(profile.id))));
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      profileRows = profileRows.slice(0, STORY_VIEWER_PREVIEW_LIMIT);
      const createdAt = Date.now();
      session = {
        profileIds: profileRows.map(profile => String(profile.id)),
        createdAt,
        expiresAt: createdAt + STORY_VIEWER_PREVIEW_TTL_MS,
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(session));
      } catch {
        /* ستبقى المعاينة مؤقتة لهذه الجلسة فقط */
      }
    }

    if (!session || requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;
    const actualIds = new Set(actualViewerIds);
    const previewRows = profileRows
      .filter(profile => !actualIds.has(String(profile.id)))
      .map((profile, index, profiles) => ({
        user_id: String(profile.id),
        viewed_at: new Date(session!.createdAt - (profiles.length - index) * 60_000).toISOString(),
        viewer: profile,
      }));

    setStoryViewerPreview({
      storyId,
      storageKey,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      rows: previewRows,
    });
  };

  const handleOpenStoryViews = async (wasPausedBeforeOpen = isPaused) => {
    if (!currentStory || !isStoryOwner || !supabaseConfigured || storyViewsOpen) return;

    const storyId = currentStory.id;
    const requestId = ++storyViewsRequestRef.current;
    storyViewsWasPausedRef.current = wasPausedBeforeOpen;
    storyVideoWasPlayingRef.current = Boolean(storyVideoRef.current && !storyVideoRef.current.paused);
    storyVideoRef.current?.pause();
    setIsPaused(true);
    setStoryViewsOpen(true);
    setStoryViewsLoading(true);
    setStoryViewsError(false);
    setStoryViewers([]);
    setStoryViewerPreview(null);

    if (storyViewsChannelRef.current) {
      void supabase.removeChannel(storyViewsChannelRef.current);
      storyViewsChannelRef.current = null;
    }

    try {
      const rows = await loadStoryViewerEntries(storyId, requestId);
      if (!rows || requestId !== storyViewsRequestRef.current) return;

      try {
        await loadStoryViewerPreview(storyId, rows.map(item => item.user_id), requestId);
      } catch (previewError) {
        console.warn('[story views] تعذر تحميل حسابات المعاينة المؤقتة:', previewError);
      }
      if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;

      const refreshStoryViewerEntries = () => {
        const refreshRequestId = ++storyViewsRequestRef.current;
        void loadStoryViewerEntries(storyId, refreshRequestId).then(rows => {
          if (!rows) return;
          const realViewerIds = new Set(rows.map(item => item.user_id));
          setStoryViewerPreview(current => current?.storyId === storyId
            ? { ...current, rows: current.rows.filter(item => !realViewerIds.has(item.user_id)) }
            : current);
        }).catch(error => {
          if (refreshRequestId !== storyViewsRequestRef.current) return;
          console.error('[story views] تعذر تحديث قائمة المشاهدين:', error);
          setStoryViewsError(true);
        });
      };

      const channel = supabase
        .channel(`story-viewers:${storyId}:${requestId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'story_views',
          filter: `story_id=eq.${storyId}`,
        }, refreshStoryViewerEntries)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'story_likes',
          filter: `story_id=eq.${storyId}`,
        }, refreshStoryViewerEntries)
        .subscribe();
      storyViewsChannelRef.current = channel;
    } catch (error) {
      if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;
      console.error('[story views] تعذر تحميل قائمة المشاهدين:', error);
      setStoryViewsError(true);
      setStoryViewers([]);
      setStoryViewsCount(0);
      toast.error('تعذر تحميل المشاهدين والإعجابات الفعلية. تحقق من ترحيل بيانات مشاهدي الستوري.');
    } finally {
      if (currentStory?.id === storyId) setStoryViewsLoading(false);
    }
  };

  const handleCloseStoryViews = () => {
    storyViewsRequestRef.current += 1;
    if (storyViewsChannelRef.current) {
      void supabase.removeChannel(storyViewsChannelRef.current);
      storyViewsChannelRef.current = null;
    }
    setStoryViewsOpen(false);
    setViewerRowMenuOpen(false);
    setViewerReportTarget(null);
    setIsPaused(storyViewsWasPausedRef.current);
    if (storyVideoWasPlayingRef.current) {
      void storyVideoRef.current?.play().catch(error => {
        console.warn('[story viewer] تعذرت متابعة تشغيل الفيديو بعد إغلاق المشاهدات:', error);
      });
    }
    storyVideoWasPlayingRef.current = false;
  };

  const handleOpenViewerReport = (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId) return;
    setViewerReportTarget(viewer);
    setViewerReportCategory('spam');
    setViewerReportDetails('');
  };

  const handleSubmitViewerReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = viewerReportTarget;
    if (!target || !isStoryOwner || target.user_id === userId || !supabaseConfigured || viewerReportBusy) return;

    setViewerReportBusy(true);
    try {
      const { error } = await supabase.from('user_reports').insert({
        reporter_id: userId,
        reported_user_id: target.user_id,
        category: viewerReportCategory,
        details: viewerReportDetails.trim(),
      });
      if (error) {
        if (error.code === '23505') throw new Error('سبق أن أبلغت عن هذا الحساب.');
        throw error;
      }
      toast.success('تم إرسال البلاغ لمراجعة الحساب.');
      setViewerReportTarget(null);
    } catch (error) {
      console.error('[story views] تعذر إرسال بلاغ الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال البلاغ. تأكد من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerReportBusy(false);
    }
  };

  const handleBlockStoryViewer = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;
    const name = viewer.viewer?.display_name || viewer.viewer?.full_name || viewer.viewer?.username || 'هذا المستخدم';
    if (!window.confirm(`هل تريد حظر ${name}؟ سيُمنع من مشاهدة قصصك والتواصل معك.`)) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      const { error } = await supabase.rpc('aani_block_user', { p_blocked_user_id: viewer.user_id });
      if (error) throw error;
      const wasVisible = storyViewers.some(item => item.user_id === viewer.user_id);
      setStoryViewers(current => current.filter(item => item.user_id !== viewer.user_id));
      setStoryViewerPreview(current => current?.storyId === currentStory?.id
        ? { ...current, rows: current.rows.filter(item => item.user_id !== viewer.user_id) }
        : current);
      if (wasVisible) setStoryViewsCount(count => Math.max(0, count - 1));
      toast.success('تم حظر الحساب ومنع التواصل وإزالة المتابعة والأصدقاء المقربين المتبادلة.');
    } catch (error) {
      console.error('[story views] تعذر حظر الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حظر الحساب. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const handleHideStoryFromViewer = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;
    const name = viewer.viewer?.display_name || viewer.viewer?.full_name || viewer.viewer?.username || 'هذا المستخدم';
    if (!window.confirm(`إخفاء قصصك المستقبلية عن ${name}؟ لن تُحذف مشاهداته السابقة.`)) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      const { error } = await supabase.rpc('aani_hide_story_from_user', { p_hidden_user_id: viewer.user_id });
      if (error) throw error;
      toast.success('تم حفظ إخفاء قصصك المستقبلية عن هذا الحساب. لم تُحذف مشاهداته السابقة.');
    } catch (error) {
      console.error('[story views] تعذر إخفاء القصص عن الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ إعداد الإخفاء. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const handleToggleStoryViewerFollow = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      if (viewer.is_following) {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', userId)
          .eq('following_id', viewer.user_id);
        if (error) throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, is_following: false, follow_request_pending: false }
          : item));
        toast.success('تم إلغاء المتابعة');
        return;
      }

      if (viewer.follow_request_pending) {
        const { error } = await supabase
          .from('follow_requests')
          .delete()
          .eq('requester_id', userId)
          .eq('recipient_id', viewer.user_id);
        if (error) throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, follow_request_pending: false }
          : item));
        toast.success('تم إلغاء طلب المتابعة');
        return;
      }

      if (viewer.viewer?.is_private) {
        const { error } = await supabase.from('follow_requests').insert({
          requester_id: userId,
          recipient_id: viewer.user_id,
        });
        if (error && error.code !== '23505') throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, follow_request_pending: true }
          : item));
        toast.success(error ? 'سبق إرسال طلب المتابعة' : 'تم إرسال طلب المتابعة');
        return;
      }

      const { error } = await supabase.from('follows').insert({
        follower_id: userId,
        following_id: viewer.user_id,
      });
      if (error && error.code !== '23505') throw error;
      setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
        ? { ...item, is_following: true, follow_request_pending: false }
        : item));
      toast.success(error ? 'الحساب متابَع بالفعل' : 'تمت متابعة الحساب');
    } catch (error) {
      console.error('[story views] تعذر تحديث المتابعة:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر تحديث حالة المتابعة. تحقق من الاتصال والصلاحيات.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const suppressStoryClick = () => {
    const suppressUntil = Date.now() + 700;
    suppressStoryClickUntilRef.current = suppressUntil;
    window.setTimeout(() => {
      if (suppressStoryClickUntilRef.current === suppressUntil) {
        suppressStoryClickUntilRef.current = 0;
      }
    }, 700);
  };

  const handleStoryViewerTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    suppressStoryClickUntilRef.current = 0;
    storyViewerPausedBeforeTouchRef.current = isPaused;
    if (event.touches.length !== 1) {
      storyViewerTouchStartRef.current = null;
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
      storyViewerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    storyViewerTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: 0,
      startedInViewersPanel: Boolean(target?.closest('[data-story-viewers-panel]')),
    };
  };

  const handleStoryViewerTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = storyViewerTouchStartRef.current;
    if (!start) return;
    if (event.touches.length !== 1) {
      storyViewerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - start.lastX;
    const deltaY = touch.clientY - start.lastY;
    storyViewerTouchStartRef.current = {
      ...start,
      lastX: touch.clientX,
      lastY: touch.clientY,
      pathLength: start.pathLength + Math.hypot(deltaX, deltaY),
    };
  };

  const handleStoryViewerTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = storyViewerTouchStartRef.current;
    storyViewerTouchStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;

    const deltaY = touch.clientY - start.y;
    const finalSegment = Math.hypot(touch.clientX - start.lastX, touch.clientY - start.lastY);
    const totalTravel = start.pathLength + finalSegment;
    const isClearSwipe = Math.abs(deltaY) >= 64 && totalTravel >= 72;

    if (storyViewsOpen) {
      if (viewerReportTarget || viewerRowMenuOpen) {
        if (isClearSwipe) suppressStoryClick();
        return;
      }
      if (isClearSwipe && isStoryOwner && deltaY > 0 && start.startedInViewersPanel) {
        suppressStoryClick();
        handleCloseStoryViews();
        return;
      }
      if (isClearSwipe) suppressStoryClick();
      return;
    }

    if (showMenu) {
      if (isClearSwipe) suppressStoryClick();
      return;
    }
    if (!isClearSwipe) return;

    suppressStoryClick();

    if (deltaY < 0 && isStoryOwner) {
      void handleOpenStoryViews(storyViewerPausedBeforeTouchRef.current);
      return;
    }

    if (deltaY > 0) setActiveUserGroup(null);
  };

  const handleStoryViewerTouchCancel = () => {
    storyViewerTouchStartRef.current = null;
  };

  const handleToggleLike = async () => {
    if (!supabaseConfigured || !currentStory || isStoryOwner || isLikeSaving) return;
    setIsLikeSaving(true);

    try {
      if (isLiked) {
        const { error } = await supabase
          .from('story_likes')
          .delete()
          .eq('story_id', currentStory.id)
          .eq('user_id', userId);
        if (error) throw error;
        setIsLiked(false);
        toast.success('تم إلغاء الإعجاب');
      } else {
        const { error } = await supabase
          .from('story_likes')
          .upsert(
            { story_id: currentStory.id, user_id: userId },
            { onConflict: 'story_id,user_id', ignoreDuplicates: true },
          );
        if (error) throw error;
        setIsLiked(true);
        try {
          const { error: notificationError } = await supabase.from('notifications').insert({
            user_id: currentStory.user_id,
            actor_id: userId,
            type: 'like',
            content: 'أعجب بستوريك',
            reference_id: currentStory.id,
          });
          if (notificationError) console.warn('[story likes] تعذر إرسال إشعار الإعجاب:', notificationError);
        } catch (notificationError) {
          console.warn('[story likes] تعذر إرسال إشعار الإعجاب:', notificationError);
        }
        toast.success('تم الإعجاب بالستوري');
      }
    } catch (error) {
      console.error('[story likes] تعذر حفظ الإعجاب:', error);
      toast.error('تعذر حفظ الإعجاب. حاول مرة أخرى.');
    } finally {
      setIsLikeSaving(false);
    }
  };

  const handleSendReply = async (customContent?: string) => {
    const textToSend = (customContent ?? replyText).trim();
    if (!supabaseConfigured || !currentStory || isStoryOwner || !textToSend || isSendingReply) return;

    setIsSendingReply(true);
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: userId,
        recipient_id: currentStory.user_id,
        content: `[story-reply]${textToSend}`,
        story_id: currentStory.id,
      });
      if (error) throw error;

      try {
        const { error: notificationError } = await supabase.from('notifications').insert({
          user_id: currentStory.user_id,
          actor_id: userId,
          type: 'reply',
          content: `رد على ستوريك: ${textToSend}`,
          reference_id: currentStory.id,
        });
        if (notificationError) console.warn('[story replies] تعذر إرسال إشعار الرد:', notificationError);
      } catch (notificationError) {
        console.warn('[story replies] تعذر إرسال إشعار الرد:', notificationError);
      }

      setReplyText('');
      toast.success('تم إرسال الرد إلى صاحب الستوري');
    } catch (error) {
      console.error('[story replies] تعذر حفظ الرد:', error);
      toast.error('تعذر إرسال الرد. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setIsSendingReply(false);
    }
  };

  const buildStoryTimedTexts = () => [
    ...timedTexts,
    ...(storyDrawStrokes.length > 0
      ? [{
          id: 'story-drawing',
          type: 'drawing' as const,
          startTime: 0,
          endTime: uploadDuration,
          strokes: storyDrawStrokes,
        }]
      : []),
  ];

  const handleUploadStory = async () => {
    if (!supabaseConfigured) return;
    const sourceStory = storyFile ? null : reshareStory;
    if (!storyFile && !caption.trim() && !sourceStory?.media_url) return;

    setUploading(true);
    try {
      let mediaUrl = sourceStory?.media_url || '';
      let mediaType = sourceStory?.media_type === 'video' ? 'video' : sourceStory ? 'photo' : 'text';

      if (storyFile) {
        const safeName = storyFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const filePath = `${userId}/story-${Date.now()}-${safeName}`;
        const { error: uploadErr } = await supabase.storage.from(storageBucket).upload(filePath, storyFile, { contentType: storyFile.type, upsert: true });
        if (uploadErr) throw uploadErr;
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
        mediaType = storyFile.type.startsWith('video') ? 'video' : 'photo';
      }

      const { data: storyId, error: insertError } = await supabase.rpc('aani_create_story', {
        p_media_url: mediaUrl || null,
        p_media_type: mediaType,
        p_caption: caption.trim() || sourceStory?.caption || null,
        p_is_close_friends: isCloseFriendsOnly,
        p_duration_seconds: uploadDuration,
        p_timed_texts: buildStoryTimedTexts(),
        p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
        p_original_story_id: sourceStory?.id || null,
        p_share_type: sourceStory ? 'reshare' : 'original',
        p_expiry_seconds: null,
      });
      if (insertError) throw insertError;
      if (typeof storyId !== 'string') throw new Error('لم تُرجع قاعدة البيانات معرّف القصة المنشورة.');

      if (storyMentions.length > 0) {
        void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', storyMentions);
      }

      setStoryFile(null);
      setReshareStory(null);
      setReshareScaledDown(false);
      setCaption('');
      setTimedTexts([]);
      setStoryDrawStrokes([]);
      setStoryDrawingOpen(false);
      activeStoryDrawStrokeRef.current = null;
      setStoryMentions([]);
      setStoryDurationOpen(false);
      storyDurationManuallyChosenRef.current = false;
      setShowUploadModal(false);
      await fetchStories();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'تعذر نشر القصة.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteStory = async () => {
    if (!supabaseConfigured || !currentStory) return;
    if (currentStory.user_id !== userId) return;
    if (!confirm('هل أنت متأكد من رغبتك في حذف هذه الستوري؟')) return;
    const { error } = await supabase
      .from('stories')
      .delete()
      .eq('id', currentStory.id)
      .eq('user_id', userId);
    if (error) {
      alert(error.message);
      return;
    }
    setShowMenu(false);
    await fetchStories();
    handleNextStory();
  };

  // ربط الإشارات بالقصة بعد نشرها فقط: سجل مستقل + إشعار + رسالة خاصة
  const linkStoryMentions = async (storyId: string, authorName: string, mentions: MentionCandidate[]) => {
    if (!storyId || mentions.length === 0) return;

    const { error: mentionError } = await supabase.from('story_mentions').insert(
      mentions.map(person => ({ story_id: storyId, author_id: userId, mentioned_id: person.id })),
    );
    if (mentionError) return;

    for (const person of mentions) {
      await supabase.from('notifications').insert({
        user_id: person.id,
        actor_id: userId,
        type: 'mention',
        content: 'قصة جديدة بانتظارك',
        reference_id: storyId,
      });

      const message = {
        sender_id: userId,
        recipient_id: person.id,
        content: `[story:${storyId}] تمت الإشارة إليك بواسطة ${authorName} في قصته.`,
        story_id: storyId,
      };

      const { error: messageError } = await supabase.from('messages').insert(message);
      if (messageError) {
        // توافق مع قاعدة بيانات لم يُضَف إليها عمود story_id بعد
        const { story_id, ...legacyMessage } = message;
        void story_id;
        await supabase.from('messages').insert(legacyMessage);
      }
    }
  };

  const handleQuickPublishStory = (closeFriends: boolean) => {
    const mediaFile = storyFile;
    const sourceStory = mediaFile ? null : reshareStory;
    const storyCaption = caption.trim();
    const mentions = [...storyMentions];
    const durationSeconds = uploadDuration;
    if (!supabaseConfigured || (!mediaFile && !sourceStory?.media_url)) return;

    // إغلاق المحرر أولاً، ثم متابعة الرفع دون حجب التفاعل مع الصفحة الرئيسية.
    setShowUploadModal(false);
    setUploading(true);
    setUploadProgress(0);

    void (async () => {
      try {
        let mediaUrl = sourceStory?.media_url || '';
        let mediaType = sourceStory?.media_type === 'video' ? 'video' : 'photo';

        if (mediaFile) {
          const safeName = mediaFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
          const filePath = `${userId}/story-${Date.now()}-${safeName}`;
          await uploadStoryMedia({
            file: mediaFile,
            path: filePath,
            onProgress: setUploadProgress,
          });
          mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
          mediaType = mediaFile.type.startsWith('video') ? 'video' : 'photo';
        } else {
          setUploadProgress(85);
        }

        const { data: storyId, error: insertError } = await supabase.rpc('aani_create_story', {
          p_media_url: mediaUrl || null,
          p_media_type: mediaType,
          p_caption: storyCaption || sourceStory?.caption || null,
          p_is_close_friends: closeFriends,
          p_duration_seconds: durationSeconds,
          p_timed_texts: buildStoryTimedTexts(),
          p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
          p_original_story_id: sourceStory?.id || null,
          p_share_type: sourceStory ? 'reshare' : 'original',
          p_expiry_seconds: null,
        });

        if (insertError) throw insertError;
        if (typeof storyId === 'string' && mentions.length > 0) {
          void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', mentions);
        }

        setStoryFile(current => current === mediaFile ? null : current);
        setReshareStory(null);
        setReshareScaledDown(false);
        setCaption(current => current.trim() === storyCaption ? '' : current);
        setStoryText('');
        setTimedTexts([]);
        setStoryDrawStrokes([]);
        setStoryDrawingOpen(false);
        activeStoryDrawStrokeRef.current = null;
        setStoryMentions([]);
        setStoryDurationOpen(false);
        storyDurationManuallyChosenRef.current = false;
        await fetchStories();
        toast.success('تم نشر القصة بنجاح', { duration: 5000 });
      } catch (error) {
        console.error('Story publish failed:', error);
        const errorInfo = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
        const details = error instanceof Error
          ? error.message
          : String(errorInfo?.message || '');
        const errorCode = String(errorInfo?.code || '');
        if (errorCode === 'PGRST202' || /aani_create_story|function.*not found|PGRST202/i.test(details)) {
          toast.error('حدّث قاعدة البيانات بتشغيل ترحيل القصص ثم أعد المحاولة');
        } else if (errorCode === '42501' || /row-level security|permission denied/i.test(details)) {
          toast.error('رفضت صلاحيات قاعدة البيانات نشر القصة. تأكد من تطبيق تحديث الخصوصية والقصص.');
        } else {
          toast.error(details ? `تعذر نشر القصة: ${details}` : 'تعذر نشر القصة، حاول مرة أخرى');
        }
        setShowUploadModal(true);
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    })();
  };

  const handleCreateTextStory = async () => {
    const text = window.prompt('اكتب نص القصة');
    if (!text?.trim() || !supabaseConfigured) return;

    try {
      const { error } = await supabase.rpc('aani_create_story', {
        p_media_url: null,
        p_media_type: 'text',
        p_caption: text.trim(),
        p_is_close_friends: false,
        p_duration_seconds: uploadDuration,
        p_timed_texts: [],
        p_filter_key: null,
        p_original_story_id: null,
        p_share_type: 'original',
        p_expiry_seconds: null,
      });

      if (error) throw error;

      await fetchStories();
      toast.success('نُشرت قصتك');
    } catch {
      toast.error('تعذر نشر القصة، حاول مرة أخرى');
    }
  };

  const redrawStoryDrawingCanvas = useCallback(() => {
    const canvas = storyDrawingCanvasRef.current;
    if (!canvas) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    storyDrawStrokes.forEach(stroke => {
      if (stroke.points.length === 0) return;
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.size;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
      if (stroke.points.length === 1) {
        context.arc(
          stroke.points[0].x * width,
          stroke.points[0].y * height,
          Math.max(1, stroke.size / 2),
          0,
          Math.PI * 2,
        );
        context.fill();
        return;
      }
      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x * width, point.y * height);
      }
      context.stroke();
    });
  }, [storyDrawStrokes]);

  useEffect(() => {
    if (!showUploadModal || !editorMediaUrl) return;
    const canvas = storyDrawingCanvasRef.current;
    if (!canvas) return;

    redrawStoryDrawingCanvas();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(redrawStoryDrawingCanvas);
    observer?.observe(canvas);
    window.addEventListener('resize', redrawStoryDrawingCanvas);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', redrawStoryDrawingCanvas);
    };
  }, [editorMediaUrl, redrawStoryDrawingCanvas, showUploadModal]);

  const handleStoryDrawPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!storyDrawingOpen) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget;
    const point = getStoryDrawPoint(canvas, event.clientX, event.clientY);
    const stroke: StoryDrawStroke = {
      id: `draw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      color: storyDrawColor,
      size: storyDrawSize,
      points: [point],
    };
    activeStoryDrawStrokeRef.current = stroke;
    const context = canvas.getContext('2d');
    if (context) {
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.fillStyle = stroke.color;
      context.beginPath();
      context.arc(point.x * canvas.clientWidth, point.y * canvas.clientHeight, Math.max(1, stroke.size / 2), 0, Math.PI * 2);
      context.fill();
    }
    canvas.setPointerCapture(event.pointerId);
  };

  const handleStoryDrawPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStoryDrawStrokeRef.current;
    if (!storyDrawingOpen || !stroke) return;
    event.preventDefault();
    event.stopPropagation();

    const canvas = event.currentTarget;
    const point = getStoryDrawPoint(canvas, event.clientX, event.clientY);
    const previous = stroke.points[stroke.points.length - 1];
    stroke.points.push(point);
    const context = canvas.getContext('2d');
    if (!context) return;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(previous.x * canvas.clientWidth, previous.y * canvas.clientHeight);
    context.lineTo(point.x * canvas.clientWidth, point.y * canvas.clientHeight);
    context.stroke();
  };

  const handleStoryDrawPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStoryDrawStrokeRef.current;
    if (!stroke) return;
    event.preventDefault();
    event.stopPropagation();
    activeStoryDrawStrokeRef.current = null;
    setStoryDrawStrokes(previous => [...previous, { ...stroke, points: [...stroke.points] }]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const undoStoryDrawStroke = () => {
    if (activeStoryDrawStrokeRef.current) activeStoryDrawStrokeRef.current = null;
    setStoryDrawStrokes(previous => previous.slice(0, -1));
  };

  return (
    <div className="contents" dir="rtl">
      <div className="story-bar story-strip mb-2 w-full">
        <div className="story-bar-content flex w-full items-center gap-[18px] overflow-x-auto no-scrollbar px-1 pb-1 pt-1">
        {/* قصتك */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div
            className={`relative flex h-16 w-16 cursor-pointer items-center justify-center rounded-full ${hasMyStory ? 'p-[2.5px]' : 'border-[1.5px] border-dashed border-zinc-600/70 p-[2px]'}`}
            style={hasMyStory ? {
              background: hasSeenAllMyStories
                ? '#3a3a42'
                : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
            } : undefined}
            onClick={() => {
              if (uploading) return;
              if (hasMyStory) {
                setActiveUserGroup(userId);
                setActiveStoryIndex(0);
                setProgress(0);
              } else {
                setShowStoryPicker(true);
              }
            }}
          >
            {hasMyStory || uploading ? (
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-[#121212] bg-zinc-900">
                <Avatar profile={currentProfile} extraLarge />
              </span>
            ) : (
              <span className="text-2xl font-light text-zinc-500">+</span>
            )}
            {uploading && (
              <svg
                viewBox="0 0 64 64"
                className="pointer-events-none absolute inset-0 z-10 h-16 w-16 animate-spin"
                role="progressbar"
                aria-label={`جارٍ نشر القصة ${uploadProgress}%`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress}
              >
                <circle cx="32" cy="32" r="29" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.5" />
                <circle
                  cx="32"
                  cy="32"
                  r="29"
                  fill="none"
                  stroke="#ec4899"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 29}
                  strokeDashoffset={2 * Math.PI * 29 * (1 - uploadProgress / 100)}
                  style={{ transition: 'stroke-dashoffset 120ms linear' }}
                />
              </svg>
            )}
            {hasMyStory && myStoryHasCloseFriends && (
              <span
                className="absolute -bottom-0.5 -left-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-[#121212] bg-emerald-500 text-white"
                title="أصدقاء مقربون"
              >
                <Star size={10} fill="currentColor" />
              </span>
            )}
            <button
              type="button"
              disabled={uploading}
              onClick={(e) => {
                e.stopPropagation();
                if (!uploading) setShowStoryPicker(true);
              }}
              className="absolute -bottom-0.5 -right-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-300 disabled:opacity-50"
              title="إضافة ستوري جديدة"
            >
              <Plus size={12} />
            </button>
          </div>
          <span className="text-[11.5px] text-zinc-400 truncate w-16 text-center">قصتك</span>
        </div>

        {/* قصص المتابَعين بحلقة العلم العراقي */}
        {Object.keys(groupedStories).filter(id => id !== userId).map(authorId => {
          const firstStory = groupedStories[authorId][0];
          const isSeen = hasSeenAllStories(groupedStories[authorId]);
          const hasCloseFriendsStory = groupedStories[authorId].some(story => story.is_close_friends);

          return (
            <div
              key={authorId}
              className="flex flex-col items-center gap-1 cursor-pointer shrink-0"
              onClick={() => {
                setActiveUserGroup(authorId);
                setActiveStoryIndex(0);
                setProgress(0);
                setCurrentTimeSec(0);
              }}
            >
              <span
                className="relative flex h-16 w-16 items-center justify-center rounded-full p-[2.5px] transition-colors duration-200"
                style={{
                  background: isSeen
                    ? '#3a3a42'
                    : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
                }}
              >
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-[#121212] bg-zinc-900">
                  <Avatar profile={firstStory.author} extraLarge />
                </span>
                {hasCloseFriendsStory && (
                  <span className="absolute -bottom-0.5 -left-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[#121212] bg-emerald-500 text-white" title="أصدقاء مقربون">
                    <Star size={10} fill="currentColor" />
                  </span>
                )}
              </span>
              <span className="text-[11.5px] text-zinc-400 truncate w-16 text-center">
                {firstStory.author?.username || 'عضو'}
              </span>
            </div>
          );
        })}
        </div>
      </div>

      <StoryComposerSheet
        open={showStoryPicker}
        onClose={() => setShowStoryPicker(false)}
        archive={(groupedStories[userId] || []) as any}
        onTextMode={() => {
          setShowStoryPicker(false);
          void handleCreateTextStory();
        }}
        onFilesSelected={files => {
          if (!files.length) return;

          if (files.length > 1) {
            toast.info('سيُستخدم أول وسيط مختار لنشر القصة');
          }

          setStoryFile(files[0]);
          setStoryDrawStrokes([]);
          setStoryDrawingOpen(false);
          activeStoryDrawStrokeRef.current = null;
          setReshareStory(null);
          setReshareScaledDown(false);
          storyDurationManuallyChosenRef.current = true;
          setUploadDuration(60);
          setStoryDurationOpen(false);
          setShowStoryPicker(false);
          setShowUploadModal(true);
        }}
      />

      {currentStory && (
        <div
          className="fixed inset-0 z-[110] h-[100dvh] w-screen overflow-hidden bg-[#0d0d0d] text-white"
          role="dialog"
          aria-modal="true"
          aria-label="عارض القصص"
          onTouchStartCapture={handleStoryViewerTouchStart}
          onTouchMoveCapture={handleStoryViewerTouchMove}
          onTouchEnd={handleStoryViewerTouchEnd}
          onTouchCancel={handleStoryViewerTouchCancel}
          onClickCapture={event => {
            const target = event.target instanceof Element ? event.target : null;
            const isMenuInteraction = target?.closest('[data-story-viewer-menu], [data-story-viewer-menu-toggle]');
            if (showMenu && !isMenuInteraction) {
              setShowMenu(false);
              event.preventDefault();
              event.stopPropagation();
              return;
            }

            if (Date.now() < suppressStoryClickUntilRef.current) {
              suppressStoryClickUntilRef.current = 0;
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <div className="relative h-full w-full overflow-hidden bg-black select-none">
            {showUI && (
              <div className="absolute inset-x-2 z-30 flex gap-1 px-1" style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}>
                {activeStories.map((st, idx) => (
                  <div key={st.id} className="h-0.5 flex-1 bg-white/[0.18] rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-[#d0d0d8] transition-all duration-75 ease-linear"
                      style={{ 
                        width: idx < activeStoryIndex ? '100%' : idx === activeStoryIndex ? `${progress}%` : '0%' 
                      }}
                    />
                  </div>
                ))}
              </div>
            )}

            {showUI && (
              <div className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent" style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}>
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <Link href={`/profile/${currentStory.user_id}`} className="flex min-w-0 items-center gap-2">
                    <Avatar profile={currentStory.author} storyBorder={false} />
                    <div className="user-identity-meta h-8 min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="truncate font-bold text-xs">{displayName(currentStory.author)}</span>
                        {currentStory.is_close_friends && (
                          <span className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold">أصدقاء مقربون</span>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate text-[10px] text-zinc-300" dir="ltr">{currentStory.author?.username}</span>
                        <span className="shrink-0 text-[10px] text-zinc-300">{formatDate(currentStory.created_at)}</span>
                      </div>
                    </div>
                  </Link>
                  {currentStory.original_story_id && originalStoryAuthor && (
                    <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/85">
                      {originalStoryAuthor.avatar_url ? (
                        <img src={originalStoryAuthor.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[7px] font-bold">
                          {displayName(originalStoryAuthor).replace('@', '').charAt(0)}
                        </span>
                      )}
                      <span className="max-w-[42vw] truncate text-[9px]">
                        من قصة {displayName(originalStoryAuthor)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-story-viewer-menu-toggle="true"
                    aria-label="خيارات الستوري"
                    onClick={() => setShowMenu(!showMenu)}
                    className="p-1 hover:bg-white/20 rounded-full"
                  >
                    <MoreVertical size={18} />
                  </button>
                  <button onClick={() => setActiveUserGroup(null)} className="p-1 hover:bg-white/20 rounded-full">
                    <X size={20} />
                  </button>
                </div>
              </div>
            )}

            {showMenu && (
              <div data-story-viewer-menu="true" className="absolute top-14 left-3 z-40 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl text-xs space-y-1">
                {currentStory.user_id === userId ? (
                  <button onClick={handleDeleteStory} className="flex items-center gap-2 text-red-400 p-2 w-full hover:bg-zinc-800 rounded-lg">
                    <Trash2 size={14} /> حذف الستوري
                  </button>
                ) : (
                  <button onClick={() => { alert('تم رفع البلاغ للتحقق'); setShowMenu(false); }} className="p-2 w-full text-zinc-300 hover:bg-zinc-800 rounded-lg">
                    إبلاغ عن الستوري
                  </button>
                )}
              </div>
            )}

            <div className="absolute inset-0 flex h-full w-full items-center justify-center bg-zinc-950">
              {currentStory.media_url ? (
                currentStory.media_type === 'video' ? (
                  <video
                    ref={storyVideoRef}
                    key={currentStory.id}
                    src={currentStory.media_url}
                    autoPlay
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-contain"
                    style={{ filter: currentStoryFilter.css }}
                  />
                ) : (
                  <img
                    src={currentStory.media_url}
                    alt=""
                    className="h-full w-full object-contain"
                    style={{ filter: currentStoryFilter.css }}
                  />
                )
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-[#1f1f27] p-6 text-center text-base font-bold text-white">
                  {currentStory.caption}
                </div>
              )}

              {currentStoryFilterOverlay && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background: currentStoryFilterOverlay.color,
                    opacity: currentStoryFilterOverlay.opacity,
                    mixBlendMode: currentStoryFilterOverlay.blend as never,
                  }}
                />
              )}

              {(Array.isArray(currentStory.timed_texts) ? currentStory.timed_texts : []).map((tt: any) => {
                if (!tt || currentTimeSec < tt.startTime || currentTimeSec > tt.endTime) return null;

                if (tt.type === 'drawing' && Array.isArray(tt.strokes)) {
                  return (
                    <svg
                      key={tt.id || 'story-drawing'}
                      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {tt.strokes.map((stroke: any, index: number) => {
                        const points = Array.isArray(stroke?.points)
                          ? stroke.points.filter((point: any) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
                          : [];
                        if (points.length === 0) return null;
                        const first = points[0];
                        const path = points.length === 1
                          ? `M ${first.x * 1000} ${first.y * 1000} L ${first.x * 1000 + 0.01} ${first.y * 1000}`
                          : points.map((point: StoryDrawPoint, pointIndex: number) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x * 1000} ${point.y * 1000}`).join(' ');
                        const width = Number.isFinite(stroke.size) ? Math.min(24, Math.max(1, stroke.size)) : 5;
                        return (
                          <path
                            key={stroke.id || index}
                            d={path}
                            fill="none"
                            stroke={typeof stroke.color === 'string' ? stroke.color : '#FFFFFF'}
                            strokeWidth={width}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        );
                      })}
                    </svg>
                  );
                }

                return (
                  <div
                    key={tt.id}
                    style={{ top: `${tt.y}%`, left: `${tt.x}%`, transform: 'translate(-50%, -50%)' }}
                    className="absolute bg-black/70 text-white font-bold px-3 py-1.5 rounded-xl text-xs border border-white/20 backdrop-blur-sm z-20"
                  >
                    {tt.text}
                  </div>
                );
              })}

              {currentStory.caption && currentStory.media_url && (
                <div
                  className="absolute inset-x-4 z-10 rounded-xl bg-black/60 p-3 text-center text-xs text-white backdrop-blur-md"
                  style={{ bottom: isStoryOwner
                    ? 'calc(4.5rem + env(safe-area-inset-bottom))'
                    : `calc(5.5rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
                >
                  {currentStory.caption}
                </div>
              )}

              <div className="absolute inset-y-0 left-0 w-1/3 z-20" onClick={handleNextStory} />
              <div className="absolute inset-y-0 right-0 w-1/3 z-20" onClick={handlePrevStory} />
              <div 
                className="absolute inset-y-0 left-1/3 w-1/3 z-20"
                onClick={() => setShowUI(!showUI)}
                onMouseDown={() => setIsPaused(true)}
                onMouseUp={() => setIsPaused(false)}
                onTouchStart={() => setIsPaused(true)}
                onTouchEnd={() => setIsPaused(false)}
              />
            </div>

            {isStoryOwner && (
              <div
                className="absolute inset-x-0 bottom-0 z-[25] h-24"
                aria-hidden="true"
              />
            )}

            {showUI && isStoryOwner && (
              <button
                type="button"
                onClick={() => void handleOpenStoryViews()}
                aria-label="عرض مشاهدات الستوري"
                title="عرض المشاهدات"
                className="absolute left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center text-white drop-shadow-[0_1px_5px_rgba(0,0,0,0.9)]"
                style={{ bottom: 'calc(0.65rem + env(safe-area-inset-bottom))' }}
              >
                <Eye size={23} />
              </button>
            )}

            {showUI && !isStoryOwner && (
              <div
                className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pt-5"
                style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
                onClick={event => event.stopPropagation()}
              >
                <div className="flex min-w-0 flex-1 items-center rounded-full border border-zinc-700/70 bg-zinc-900/95 px-3 py-2 shadow-lg">
                  <input
                    key={currentStory.id}
                    type="text"
                    placeholder="رد على الستوري..."
                    aria-label="اكتب رداً على الستوري"
                    maxLength={3900}
                    value={replyText}
                    disabled={isSendingReply}
                    onFocus={() => setReplyFocused(true)}
                    onBlur={() => setReplyFocused(false)}
                    onChange={event => setReplyText(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void handleSendReply();
                      }
                    }}
                    className="w-full min-w-0 bg-transparent text-xs text-white outline-none placeholder-zinc-400 disabled:opacity-60"
                  />
                  {replyText.trim() && (
                    <button
                      type="button"
                      onClick={() => void handleSendReply()}
                      disabled={isSendingReply}
                      aria-label="إرسال الرد"
                      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pink-400 transition hover:bg-white/10 disabled:opacity-50"
                    >
                      {isSendingReply ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void handleToggleLike()}
                  disabled={isLikeSaving}
                  aria-label={isLiked ? 'إلغاء الإعجاب بالستوري' : 'الإعجاب بالستوري'}
                  aria-pressed={isLiked}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-700/70 bg-zinc-900/90 transition disabled:opacity-50 ${isLiked ? 'text-pink-500' : 'text-white'}`}
                >
                  {isLikeSaving ? <Loader2 size={17} className="animate-spin" /> : <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />}
                </button>
              </div>
            )}

            {storyViewsOpen && isStoryOwner && (
              <>
                <button
                  type="button"
                  aria-label="إغلاق قائمة المشاهدات"
                  className="absolute inset-0 z-[60] bg-black/45"
                  onClick={event => {
                    event.stopPropagation();
                    handleCloseStoryViews();
                  }}
                />
                <section
                  data-story-viewers-panel="true"
                  className="absolute inset-x-0 bottom-0 z-[70] flex h-[88dvh] max-h-[90dvh] flex-col overflow-hidden rounded-t-3xl border-t border-white/10 bg-zinc-950/95 px-4 pt-2 shadow-2xl backdrop-blur-xl"
                  style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
                  role="dialog"
                  aria-modal="true"
                  aria-label="مشاهدات الستوري"
                  onClick={event => event.stopPropagation()}
                >
                  <div data-story-viewers-panel-header="true" className="mx-auto mb-3 mt-1 h-1 w-10 rounded-full bg-white/30" />
                  <div data-story-viewers-panel-header="true" className="mb-1 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-white">المشاهدات</h2>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-zinc-400">{storyViewsCount}</span>
                      <button
                        type="button"
                        onClick={handleCloseStoryViews}
                        aria-label="إغلاق"
                        className="rounded-full p-1 text-zinc-300 transition hover:bg-white/10"
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                    {storyViewsLoading && (
                      <div className="flex items-center justify-center py-5 text-zinc-400" role="status" aria-label="جارٍ تحميل المشاهدات">
                        <Loader2 size={20} className="animate-spin" />
                      </div>
                    )}
                    {storyViewsError && (
                      <p className="py-5 text-center text-xs text-red-300">تعذر تحميل بيانات المشاهدين أو الإعجابات الفعلية. تحقق من قاعدة البيانات والاتصال.</p>
                    )}
                    {!storyViewsLoading && !storyViewsError && storyViewers.length > 0 && (
                      <ul className="space-y-2">
                        {storyViewers.map(item => (
                          <li key={`${currentStory.id}:${item.user_id}`} className="flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-white/[0.03]">
                            <Avatar profile={item.viewer} />
                            <div className="min-w-0 flex-1">
                              <div className="user-identity-meta h-8">
                                <p className="truncate text-xs font-semibold leading-tight text-white">
                                  {storyViewerDisplayName(item.viewer)}
                                </p>
                                <p className="truncate text-[10px] leading-none text-zinc-400" dir="ltr">
                                  {item.viewer?.username || 'اسم المستخدم غير متاح'}
                                </p>
                              </div>
                              <time className="mt-1 block text-[10px] text-zinc-500">
                                {formatDate(item.viewed_at)}
                              </time>
                            </div>
                            {item.is_liked && (
                              <Heart size={16} fill="currentColor" className="shrink-0 text-pink-500" aria-label="أعجب بالستوري" />
                            )}
                            <DropdownMenu onOpenChange={setViewerRowMenuOpen}>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`خيارات ${item.viewer?.username || 'المشاهد'}`}
                                  disabled={Boolean(viewerActionBusyId)}
                                  className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                                >
                                  <MoreVertical size={18} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="z-[150] min-w-48 border-zinc-800 bg-zinc-900 text-white">
                                <DropdownMenuItem onSelect={() => handleOpenViewerReport(item)}>
                                  <Flag size={15} /> الإبلاغ عن الحساب
                                </DropdownMenuItem>
                                <DropdownMenuItem className="text-amber-300 focus:text-amber-200" onSelect={() => void handleBlockStoryViewer(item)}>
                                  <Ban size={15} /> حظر الحساب
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void handleHideStoryFromViewer(item)}>
                                  <EyeOff size={15} /> إخفاء الستوري عنه
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void handleToggleStoryViewerFollow(item)}>
                                  <UserRound size={15} />
                                  {item.is_following
                                    ? 'إلغاء المتابعة'
                                    : item.follow_request_pending
                                      ? 'إلغاء طلب المتابعة'
                                      : item.viewer?.is_private
                                        ? 'طلب متابعة'
                                        : 'متابعة'}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </li>
                        ))}
                      </ul>
                    )}

                    {storyViewerPreview?.storyId === currentStory.id && storyViewerPreview.expiresAt > Date.now() && storyViewerPreview.rows.length > 0 && (
                      <div className="mt-1">
                        <ul className="space-y-2">
                          {storyViewerPreview.rows.map(item => (
                            <li key={`preview:${currentStory.id}:${item.user_id}`} className="flex items-center gap-2 py-2">
                              <Avatar profile={item.viewer} />
                              <div className="min-w-0 flex-1">
                                <div className="user-identity-meta h-8">
                                  <p className="truncate text-xs font-semibold leading-tight text-white">
                                    {storyViewerDisplayName(item.viewer)}
                                  </p>
                                  <p className="truncate text-[10px] leading-none text-zinc-400" dir="ltr">
                                    {item.viewer?.username || 'اسم المستخدم غير متاح'}
                                  </p>
                                </div>
                                <time className="mt-1 block text-[10px] text-zinc-500">
                                  {formatDate(item.viewed_at)} · معاينة
                                </time>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </section>

                {viewerReportTarget && (
                  <div
                    className="absolute inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
                    onClick={() => {
                      if (!viewerReportBusy) setViewerReportTarget(null);
                    }}
                  >
                    <form
                      dir="rtl"
                      onSubmit={event => void handleSubmitViewerReport(event)}
                      onClick={event => event.stopPropagation()}
                      className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-4 text-white shadow-2xl"
                    >
                      <h3 className="text-sm font-bold">الإبلاغ عن الحساب</h3>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        {storyViewerDisplayName(viewerReportTarget.viewer)}
                      </p>
                      <label className="mt-4 block text-[11px] text-zinc-300">
                        سبب الإبلاغ
                        <select
                          required
                          value={viewerReportCategory}
                          onChange={event => setViewerReportCategory(event.target.value as typeof viewerReportCategory)}
                          className="mt-1.5 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-xs text-white outline-none focus:border-sky-400"
                        >
                          <option value="spam">رسائل أو محتوى مزعج</option>
                          <option value="harassment">مضايقة أو تنمّر</option>
                          <option value="hate">خطاب كراهية</option>
                          <option value="fake_account">حساب منتحل أو مزيف</option>
                          <option value="other">سبب آخر</option>
                        </select>
                      </label>
                      <label className="mt-3 block text-[11px] text-zinc-300">
                        تفاصيل إضافية (اختياري)
                        <textarea
                          value={viewerReportDetails}
                          onChange={event => setViewerReportDetails(event.target.value)}
                          maxLength={1000}
                          rows={3}
                          className="mt-1.5 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-xs text-white outline-none focus:border-sky-400"
                        />
                      </label>
                      <div className="mt-4 flex gap-2">
                        <button type="button" disabled={viewerReportBusy} onClick={() => setViewerReportTarget(null)} className="h-10 flex-1 rounded-lg border border-zinc-700 text-xs text-zinc-300 disabled:opacity-50">
                          إلغاء
                        </button>
                        <button type="submit" disabled={viewerReportBusy} className="h-10 flex-1 rounded-lg bg-sky-500 text-xs font-bold text-zinc-950 disabled:opacity-50">
                          {viewerReportBusy ? <Loader2 size={15} className="mx-auto animate-spin" /> : 'إرسال البلاغ'}
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showUploadModal && (
        <StoryCreationEditor
          editorMediaUrl={editorMediaUrl}
          editorIsVideo={editorIsVideo}
          reshareStory={reshareStory}
          reshareScaledDown={reshareScaledDown}
          currentProfile={currentProfile}
          storyCanvasOffset={storyCanvasOffset}
          storyCanvasScale={storyCanvasScale}
          storyMediaOffset={storyMediaOffset}
          storyMediaZoom={storyMediaZoom}
          storyMediaRotate={storyMediaRotate}
          storyFilterValue={storyFilterValue}
          storyFilterOverlay={storyFilterOverlay}
          storyText={storyText}
          storyTextEditorOpen={storyTextEditorOpen}
          storyTextAnimation={storyTextAnimation}
          storyTextOffset={storyTextOffset}
          storyTextScale={storyTextScale}
          storyTextRotation={storyTextRotation}
          storyFontFamily={storyFontFamily}
          storyTextColor={storyTextColor}
          storyTextAlign={storyTextAlign}
          storyHasBackground={storyHasBackground}
          storyBackgroundPreset={storyBackgroundPreset}
          visibleStoryText={visibleStoryText}
          storyDrawingOpen={storyDrawingOpen}
          storyDrawingCanvasRef={storyDrawingCanvasRef}
          storyToolsRef={storyToolsRef}
          storyMoreOpen={storyMoreOpen}
          storyDurationOpen={storyDurationOpen}
          storyExtraTools={storyExtraTools}
          uploadDuration={uploadDuration}
          storyKeyboardInset={storyKeyboardInset}
          storyEditorPreviewMode={storyEditorPreviewMode}
          storyAnimationTick={storyAnimationTick}
          storyPreviewClassName={storyPreviewClassName}
          storyTextAreaRef={storyTextAreaRef}
          storyFilterId={storyFilterId}
          storyFilterAdjustments={storyFilterAdjustments}
          storyMusicTrack={storyMusicTrack}
          storyDrawColor={storyDrawColor}
          storyDrawSize={storyDrawSize}
          storyDrawStrokesCount={storyDrawStrokes.length}
          storyFile={storyFile}
          uploading={uploading}
          userId={userId}
          storyMusicOpen={storyMusicOpen}
          storyMentionsOpen={storyMentionsOpen}
          closeFriendsOpen={closeFriendsOpen}
          onCloseMusic={() => setStoryMusicOpen(false)}
          onSelectMusic={track => {
            setStoryMusicTrack({ id: track.id, title: track.title, artist: track.artist });
            setStoryMusicOpen(false);
            toast.success(`تم اختيار: ${track.title}`);
          }}
          onCloseMentions={() => setStoryMentionsOpen(false)}
          onConfirmMentions={people => {
            setStoryMentions(people);
            setStoryMentionsOpen(false);
            if (people.length === 1) {
              toast.success(`تمت الإشارة إلى ${people[0].username}`);
            } else if (people.length > 1) {
              toast.success(`تمت الإشارة إلى ${people.length} أشخاص`);
            }
          }}
          onCloseCloseFriends={() => setCloseFriendsOpen(false)}
          onClose={() => {
            setShowUploadModal(false);
            setStoryDrawingOpen(false);
            activeStoryDrawStrokeRef.current = null;
            if (reshareStory) {
              setReshareStory(null);
              setReshareScaledDown(false);
              setCaption('');
              setStoryText('');
            }
          }}
          onMediaClick={() => {
            if (reshareStory && Date.now() - lastStoryTouchRef.current > 500) {
              setReshareScaledDown(current => !current);
            }
          }}
          onVideoMetadata={duration => {
            if (Number.isFinite(duration) && duration > 0 && !storyDurationManuallyChosenRef.current) {
              setUploadDuration(Math.min(120, Math.max(5, Math.ceil(duration))));
            }
          }}
          onCanvasTouchStart={handleStoryCanvasTouchStart}
          onCanvasTouchMove={handleStoryCanvasTouchMove}
          onCanvasTouchEnd={handleStoryCanvasTouchEnd}
          onDrawPointerDown={handleStoryDrawPointerDown}
          onDrawPointerMove={handleStoryDrawPointerMove}
          onDrawPointerUp={handleStoryDrawPointerUp}
          onSelectStoryTool={toolKey => {
            if (toolKey === 'text') {
              setStoryDrawingOpen(false);
              setStoryFiltersOpen(false);
              setStoryTextEditorOpen(true);
            } else if (toolKey === 'mention') {
              setStoryDrawingOpen(false);
              setStoryTextEditorOpen(false);
              setStoryFiltersOpen(false);
              setStoryMentionsOpen(true);
            } else if (toolKey === 'music') {
              setStoryDrawingOpen(false);
              setStoryTextEditorOpen(false);
              setStoryMusicOpen(true);
            } else if (toolKey === 'effects') {
              setStoryDrawingOpen(false);
              setStoryTextEditorOpen(false);
              setStoryFiltersOpen(open => !open);
            } else if (toolKey === 'draw') {
              if (!editorMediaUrl) {
                toast.info('اختر صورة أو فيديو أولاً');
                return;
              }
              setStoryTextEditorOpen(false);
              setStoryFiltersOpen(false);
              setStoryMoreOpen(false);
              setStoryDurationOpen(false);
              setStoryDrawingOpen(true);
            }
          }}
          onToggleMore={() => {
            const nextOpen = !storyMoreOpen;
            setStoryMoreOpen(nextOpen);
            if (!nextOpen) setStoryDurationOpen(false);
          }}
          onDurationChange={duration => {
            storyDurationManuallyChosenRef.current = true;
            setUploadDuration(duration);
          }}
          onStoryTextChange={setStoryText}
          onFinishTextEditing={() => {
            setCaption(storyText.trim());
            setStoryTextEditorOpen(false);
          }}
          onFontFamilyChange={setStoryFontFamily}
          onTextColorChange={setStoryTextColor}
          onCycleAlign={() => setStoryTextAlign(prev => nextStoryTextAlign(prev))}
          onCycleBackground={() => setStoryBackgroundIndex(prev => (prev + 1) % STORY_TEXT_BACKGROUNDS.length)}
          onAnimationChange={value => {
            setStoryTextAnimation(value);
            setStoryAnimationTick(tick => tick + 1);
          }}
          onInteract={() => {
            keepStoryEditorFocus();
            window.setTimeout(keepStoryEditorFocus, 80);
          }}
          onSelectFilter={setStoryFilterId}
          onAdjustFilter={(key, value) => setStoryFilterAdjustments(prev => ({ ...prev, [key]: value }))}
          onResetFilters={() => {
            setStoryFilterId('original');
            setStoryFilterAdjustments(DEFAULT_FILTER_ADJUSTMENTS);
          }}
          onCloseFilters={() => setStoryFiltersOpen(false)}
          onDrawColorChange={setStoryDrawColor}
          onDrawSizeChange={setStoryDrawSize}
          onUndoDrawing={undoStoryDrawStroke}
          onCloseDrawing={() => setStoryDrawingOpen(false)}
          onQuickPublish={closeFriends => void handleQuickPublishStory(closeFriends)}
        />
      )}
    </div>
  );
}

function NotificationsModal({ isOpen, onClose, currentUserId }: { isOpen: boolean; onClose: () => void; currentUserId: string }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (!supabaseConfigured) {
      setError('إعدادات Supabase غير مكتملة.');
      setItems([]);
      return;
    }

    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      const { data, error: queryError } = await supabase
        .from('notifications')
        .select('id,content,type,is_read,created_at')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false })
        .limit(40);
      if (!active) return;
      if (queryError) {
        setItems([]);
        setError(queryError.message);
        setLoading(false);
        return;
      }

      let rows = (data || []) as NotificationItem[];

      // إثراء اختياري: صاحب الإشعار ومرجع المنشور (يجعل إشعار إعادة النشر قابلاً للنقر)
      try {
        const { data: refs } = await supabase
          .from('notifications')
          .select('id,entity_id,actor_id')
          .eq('user_id', currentUserId)
          .order('created_at', { ascending: false })
          .limit(40);

        if (refs?.length) {
          const refRows = refs as Array<{ id: string; entity_id?: string | null; actor_id?: string | null }>;
          const refMap = new Map(refRows.map(row => [row.id, row]));
          rows = rows.map(item => ({ ...item, ...(refMap.get(item.id) || {}) }));

          const actorIds = Array.from(
            new Set(rows.map(item => item.actor_id).filter((id): id is string => Boolean(id))),
          );

          if (actorIds.length) {
            const { data: profiles } = await supabase
              .from('profiles')
              .select('id, username, full_name, avatar_url')
              .in('id', actorIds);
            const profileMap = new Map(((profiles || []) as Profile[]).map(person => [person.id, person]));
            rows = rows.map(item => (item.actor_id ? { ...item, actor: profileMap.get(item.actor_id) || null } : item));
          }
        }
      } catch (enrichError) {
        console.warn('[notifications] تعذر إثراء الإشعارات:', enrichError);
      }

      if (!active) return;
      setItems(rows);
      setLoading(false);
    };

    void load();
    return () => { active = false; };
  }, [isOpen, currentUserId]);

  const markAllRead = async () => {
    if (!supabaseConfigured || !items.some(item => !item.is_read)) return;
    setUpdating(true);
    setError('');
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', currentUserId)
      .eq('is_read', false);
    if (updateError) setError(updateError.message);
    else setItems(current => current.map(item => ({ ...item, is_read: true })));
    setUpdating(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <section
        className="max-h-[80vh] w-full max-w-md overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-notifications-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 p-4">
          <h2 id="aani-notifications-title" className="flex items-center gap-2 text-base font-bold">
            <Bell size={18} /> الإشعارات
          </h2>
          <div className="flex items-center gap-3">
            {items.some(item => !item.is_read) && (
              <button type="button" onClick={() => void markAllRead()} disabled={updating} className="text-xs text-pink-400 disabled:opacity-50">
                {updating ? 'جارٍ التحديث…' : 'تحديد الكل كمقروء'}
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="إغلاق الإشعارات" className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4">
          {loading && <p className="py-8 text-center text-sm text-zinc-400">جارٍ تحميل الإشعارات…</p>}
          {!loading && error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
          {!loading && !error && items.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">لا توجد إشعارات جديدة.</p>}
          {!loading && !error && items.map(item => {
            const target = item.type === 'repost' && item.entity_id ? `/post/${item.entity_id}` : null;
            const card = (
              <article className={`mb-2 rounded-xl border p-3 ${item.is_read ? 'border-zinc-800 bg-zinc-950/40' : 'border-pink-500/30 bg-pink-500/5'}`}>
                <div className="flex items-start gap-2.5">
                  {item.actor && <Avatar profile={item.actor} />}
                  <div className="min-w-0 flex-1">
                    {item.actor && (
                      <strong className="block truncate text-xs text-white">{displayName(item.actor)}</strong>
                    )}
                    <p className="text-sm">{item.content || 'لديك إشعار جديد في آني.'}</p>
                    <time className="mt-1 block text-[11px] text-zinc-500">{formatDate(item.created_at)}</time>
                  </div>
                </div>
              </article>
            );

            return target ? (
              <Link key={item.id} href={target} onClick={onClose} className="block">{card}</Link>
            ) : (
              <div key={item.id}>{card}</div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [selectedPostForComments, setSelectedPostForComments] = useState<string | null>(null);
  const [pendingStoryReshare, setPendingStoryReshare] = useState<StoryDmCardStory | null>(null);
  const clearPendingStoryReshare = useCallback(() => setPendingStoryReshare(null), []);
  const [pendingProfileStoryOwnerId, setPendingProfileStoryOwnerId] = useState<string | null>(null);
  const clearPendingProfileStory = useCallback(() => setPendingProfileStoryOwnerId(null), []);
  const user = session?.user;

  useEffect(() => {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';

    if (!supabaseConfigured) {
      setAuthLoading(false);
      return;
    }

    let mounted = true;

    const loadSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (mounted) setSession(data.session);
      } catch (error) {
        console.error('تعذر استعادة جلسة المستخدم:', error);
        if (mounted) setSession(null);
      } finally {
        if (mounted) setAuthLoading(false);
      }
    };

    void loadSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setProfile(null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !user?.id) return;
    void supabase.from('profiles').select('*').eq('id', user.id).maybeSingle().then(({ data }) => setProfile(data as Profile | null));
  }, [user?.id]);

  const signOut = async () => { 
    if (supabaseConfigured) await supabase.auth.signOut(); 
    setSession(null); 
    setProfile(null); 
  };

  if (authLoading) return <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>;

  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL ? import.meta.env.BASE_URL.replace(/\/$/, '') : ''}>
        {user ? (
          <Shell
            userId={user.id}
            profile={profile}
            onSignOut={() => void signOut()}
            onOpenComments={(id) => setSelectedPostForComments(id)}
            NotificationsModalComponent={NotificationsModal}
          >
            <Switch>
              <Route path="/feed"><FeedPage
                userId={user.id}
                profile={profile}
                onOpenComments={(id) => setSelectedPostForComments(id)}
                pendingStoryReshare={pendingStoryReshare}
                onStoryReshareHandled={clearPendingStoryReshare}
                pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                onProfileStoryHandled={clearPendingProfileStory}
                StoriesBarComponent={StoriesBar}
              /></Route>
              <Route path="/post/:postId">{params => <PostDetailPage postId={params.postId} currentUserId={user.id} onOpenComments={(id) => setSelectedPostForComments(id)} />}</Route>
              <Route path="/"><FeedPage
                userId={user.id}
                profile={profile}
                onOpenComments={(id) => setSelectedPostForComments(id)}
                pendingStoryReshare={pendingStoryReshare}
                onStoryReshareHandled={clearPendingStoryReshare}
                pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                onProfileStoryHandled={clearPendingProfileStory}
                StoriesBarComponent={StoriesBar}
              /></Route>
              <Route path="/reels"><ReelsPage userId={user.id} /></Route>
              <Route path="/search"><SearchPage userId={user.id} /></Route>
              <Route path="/messages"><MessagesPage currentUserId={user.id} onReshareStory={setPendingStoryReshare} /></Route>
              <Route path="/messages/:userId">{params => <MessagesPage currentUserId={user.id} selectedId={params.userId} onReshareStory={setPendingStoryReshare} />}</Route>
              <Route path="/profile">{() => <ProfilePage targetUserId={user.id} currentUserId={user.id} profile={profile} onProfileUpdate={setProfile} onOpenComments={(id) => setSelectedPostForComments(id)} onOpenStories={setPendingProfileStoryOwnerId} />}</Route>
              <Route path="/profile/:userId">{params => <ProfilePage key={params.userId} targetUserId={params.userId} currentUserId={user.id} profile={profile} onProfileUpdate={setProfile} onOpenComments={(id) => setSelectedPostForComments(id)} onOpenStories={setPendingProfileStoryOwnerId} />}</Route>
              <Route component={NotFound} />
            </Switch>

            {selectedPostForComments && (
              <CommentsDrawer
                postId={selectedPostForComments}
                currentUserId={user.id}
                isOpen={Boolean(selectedPostForComments)}
                onClose={() => setSelectedPostForComments(null)}
              />
            )}
          </Shell>
        ) : (
          <Switch>
            <Route path="/signup"><AuthPage mode="signup" afterAuth={() => undefined} /></Route>
            <Route path="/login"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route path="/"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route component={NotFound} />
          </Switch>
        )}
      </WouterRouter>
    </TooltipProvider>
  );
}

export default App;
