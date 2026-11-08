import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';

import { toast } from 'sonner';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName } from '@/lib/types';
import type { Profile } from '@/lib/types';
import {
  clampCanvas,
  drawStoryStroke,
  getStoryDrawPoint,
  STORY_DRAW_COLORS,
  STORY_DRAW_SIZES,
  type StoryDrawStroke,
  type StoryDrawTool,
  type StoryGestureState,
  type StoryGestureTarget,
  type StoryViewerEntry,
  type StoryViewerPreviewSession,
  type StoryViewerPreviewState,
} from '@/lib/appShared';

import StoryComposerSheet from './StoryComposerSheet';
import StoryCreationEditor from '@/components/StoryCreationEditor';
import TextOnlyStoryCanvas from '@/components/story/TextOnlyStoryCanvas';
import StoryViewer from '@/components/StoryViewer';
import StoriesStrip from '@/components/stories/StoriesStrip';
import type {
  StoryAuthor,
  StoryCanvasStyle,
  StoryCanvasStyleOverlay,
  StoryDrawingOverlay,
  StoryImageOverlay,
  StoryMediaTransformOverlay,
  StoryImageStickerUpdate,
  StoryRow,
  StoryTextOverlay,
  StoryTimedText,
} from '@/components/stories/types';
import { useStoriesData } from '@/components/stories/useStoriesData';
import { useStoryCreationActions } from '@/components/stories/useStoryCreationActions';
import { useStoryViewerActions } from '@/components/stories/useStoryViewerActions';
import { useStoryViewerData } from '@/components/stories/useStoryViewerData';
import type { MentionCandidate } from './StoryMentionPicker';
import {
  DEFAULT_ADJUSTMENTS as DEFAULT_FILTER_ADJUSTMENTS,
  buildStoryFilterCss,
  decodeStoryFilterKey,
  getStoryFilterOverlay,
  type StoryAdjustments,
} from '@/lib/storyFilters';
import {
  STORY_TEXT_BACKGROUNDS,
  nextStoryTextAlign,
  type StoryTextAlign,
  type StoryTextAnimation,
} from '@/lib/storyFonts';

// --- شريط القصص الموحد ---

type Point = { x: number; y: number };

export default function StoriesBar({
  userId,
  currentProfile,
  pendingReshare,
  onReshareHandled,
  pendingProfileStoryOwnerId,
  pendingStoryId,
  onProfileStoryHandled,
}: {
  userId: string;
  currentProfile: Profile | null;
  pendingReshare: StoryDmCardStory | null;
  onReshareHandled: () => void;
  pendingProfileStoryOwnerId: string | null;
  pendingStoryId: string | null;
  onProfileStoryHandled: () => void;
}) {
  const [groupedStories, setGroupedStories] = useState<Record<string, StoryRow[]>>({});
  const [archiveStories, setArchiveStories] = useState<StoryRow[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveViewerOpen, setArchiveViewerOpen] = useState(false);
  const [activeUserGroup, setActiveUserGroup] = useState<string | null>(null);
  const [activeStoryIndex, setActiveStoryIndex] = useState(0);
  const [profileStoryOwnerId, setProfileStoryOwnerId] = useState<string | null>(null);
  const [profilePreviewStories, setProfilePreviewStories] = useState<StoryRow[]>([]);

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
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [videoDurationForStory, setVideoDurationForStory] = useState<{ storyId: string; durationSeconds: number } | null>(null);
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
  const storyViewsWasPausedRef = useRef(false);
  const storyVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentStoryRef = useRef<StoryRow | null>(null);
  const progressStoryIdRef = useRef<string | null>(null);
  const autoAdvancedStoryIdRef = useRef<string | null>(null);
  const autoAdvanceStoryRef = useRef<(storyId: string) => void>(() => {});
  const storyVideoWasPlayingRef = useRef(false);
  const storyViewsRequestRef = useRef(0);
  const storyViewsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [originalStoryAuthor, setOriginalStoryAuthor] = useState<StoryAuthor | null>(null);
  const [showMenu, setShowMenu] = useState(false);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showStoryPicker, setShowStoryPicker] = useState(false);
  const skipStoryGalleryAutoOpenRef = useRef(false);
  const [showTextOnlyStoryCanvas, setShowTextOnlyStoryCanvas] = useState(false);
  const [textCanvasBackground, setTextCanvasBackground] = useState('#000000');
  const textCanvasMediaPickerRef = useRef(false);
  const storyStickerInputRef = useRef<HTMLInputElement | null>(null);
  const storyFileInputRef = useRef<HTMLInputElement | null>(null);
  const localStickerObjectUrlsRef = useRef<Set<string>>(new Set());

  // أثناء شاشات القصص (اختيار/معاينة/عارض القصص) تُخفى أشرطة التطبيق وتُعزل الحركات
  useEffect(() => {
    const immersive = showStoryPicker || showUploadModal || showTextOnlyStoryCanvas || Boolean(activeUserGroup);
    document.body.classList.toggle('aani-immersive', immersive);

    return () => {
      document.body.classList.remove('aani-immersive');
    };
  }, [showStoryPicker, showUploadModal, showTextOnlyStoryCanvas, activeUserGroup]);

  useEffect(() => {
    const openStoryComposer = () => {
      setArchiveViewerOpen(false);
      skipStoryGalleryAutoOpenRef.current = true;
      setShowStoryPicker(true);
    };

    window.addEventListener('aani:open-story-composer', openStoryComposer);
    return () => window.removeEventListener('aani:open-story-composer', openStoryComposer);
  }, []);

  const [storyFile, setStoryFile] = useState<File | null>(null);
  const [previewStoryUrl, setPreviewStoryUrl] = useState<string | null>(null);
  const previewStoryUrlRef = useRef<{ file: File; url: string } | null>(null);
  const [reshareStory, setReshareStory] = useState<StoryDmCardStory | null>(null);
  const [reshareScaledDown, setReshareScaledDown] = useState(false);

  const [storyMoreOpen, setStoryMoreOpen] = useState(false);
  const [storyDurationOpen, setStoryDurationOpen] = useState(false);
  const [storyDrawingOpen, setStoryDrawingOpen] = useState(false);
  const [storyDrawingTool, setStoryDrawingTool] = useState<StoryDrawTool>('smooth');
  const [storyCropOpen, setStoryCropOpen] = useState(false);
  const [storyDrawColor, setStoryDrawColor] = useState(STORY_DRAW_COLORS[0]);
  const [storyDrawSize, setStoryDrawSize] = useState(STORY_DRAW_SIZES[1]);
  const [storyDrawStrokes, setStoryDrawStrokes] = useState<StoryDrawStroke[]>([]);
  const storyDrawingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeStoryDrawStrokeRef = useRef<StoryDrawStroke | null>(null);
  // أدوات إضافية للمحرر: الأصدقاء المقربون ومدة عرض القصة وأداة القص.
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
    {
      key: 'crop',
      label: 'قص الوسيط',
      action: () => {
        if (!storyFile && !reshareStory?.media_url) {
          toast.info('اختر صورة أو فيديو أولاً');
          return;
        }
        setStoryMoreOpen(false);
        setStoryDurationOpen(false);
        setStoryDrawingOpen(false);
        setStoryTextEditorOpen(false);
        setStoryFiltersOpen(false);
        setStoryCropOpen(true);
      },
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
  const [timedTexts, setTimedTexts] = useState<StoryTimedText[]>([]);
  const [editingStoryTextId, setEditingStoryTextId] = useState<string | null>(null);
  const [activeStoryStickerId, setActiveStoryStickerId] = useState<string | null>(null);
  const [draggingStoryStickerId, setDraggingStoryStickerId] = useState<string | null>(null);
  const [storyStickerOverDeleteZone, setStoryStickerOverDeleteZone] = useState(false);

  useEffect(() => {
    const activeUrls = new Set(timedTexts
      .filter((layer): layer is StoryImageOverlay => layer.type === 'image' && Boolean(layer.localFile))
      .map(layer => layer.src));
    localStickerObjectUrlsRef.current.forEach(url => {
      if (activeUrls.has(url)) return;
      URL.revokeObjectURL(url);
      localStickerObjectUrlsRef.current.delete(url);
    });
  }, [timedTexts]);

  useEffect(() => () => {
    localStickerObjectUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    localStickerObjectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (activeStoryStickerId && !timedTexts.some(layer => layer.type === 'image' && layer.id === activeStoryStickerId)) {
      setActiveStoryStickerId(null);
    }
  }, [activeStoryStickerId, timedTexts]);
  const storyGestureTextIdRef = useRef<string | null>(null);
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
  const storyPanelsRef = useRef({
    filters: false,
    textEditor: false,
    more: false,
    drawing: false,
    duration: false,
    music: false,
    mentions: false,
    closeFriends: false,
  });

  useEffect(() => {
    storyPanelsRef.current = {
      filters: storyFiltersOpen,
      textEditor: storyTextEditorOpen,
      more: storyMoreOpen,
      drawing: storyDrawingOpen,
      duration: storyDurationOpen,
      music: storyMusicOpen,
      mentions: storyMentionsOpen,
      closeFriends: closeFriendsOpen,
    };
  }, [storyFiltersOpen, storyTextEditorOpen, storyMoreOpen, storyDrawingOpen, storyDurationOpen, storyMusicOpen, storyMentionsOpen, closeFriendsOpen]);

  // تُغلق النوافذ الفرعية وحدها دون فتح أي أداة أخرى
  const closeStoryPanels = useCallback(() => {
    setStoryFiltersOpen(false);
    setStoryTextEditorOpen(false);
    setStoryMoreOpen(false);
    setStoryDrawingOpen(false);
    setStoryCropOpen(false);
    setStoryDurationOpen(false);
    setStoryMusicOpen(false);
    setStoryMentionsOpen(false);
    setCloseFriendsOpen(false);
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

  const [storyTextFontSize, setStoryTextFontSize] = useState(30);

  // محرك إيماءات واحد: يُقفل التفاعل كلياً على العنصر الذي بدأ منه اللمس
  const [storyCanvasScale, setStoryCanvasScale] = useState(1);
  const [storyCanvasOffset, setStoryCanvasOffset] = useState({ x: 0, y: 0 });

  const [storyMediaZoom, setStoryMediaZoom] = useState(1);
  const [storyMediaRotate, setStoryMediaRotate] = useState(0);
  const [storyMediaOffset, setStoryMediaOffset] = useState({ x: 0, y: 0 });

  const [storyTextOffset, setStoryTextOffset] = useState({ x: 0, y: 0 });
  const [storyTextScale, setStoryTextScale] = useState(1);
  const [storyTextRotation, setStoryTextRotation] = useState(0);
  const [storyAlignmentGuides, setStoryAlignmentGuides] = useState({ vertical: false, horizontal: false });
  const alignmentGuideTimerRef = useRef<number | null>(null);

  const showStoryAlignmentGuides = (vertical: boolean, horizontal: boolean) => {
    setStoryAlignmentGuides({ vertical, horizontal });
    if (alignmentGuideTimerRef.current !== null) window.clearTimeout(alignmentGuideTimerRef.current);
    alignmentGuideTimerRef.current = vertical || horizontal
      ? window.setTimeout(() => {
          setStoryAlignmentGuides({ vertical: false, horizontal: false });
          alignmentGuideTimerRef.current = null;
        }, 300)
      : null;
  };

  const snapStoryLayerPosition = (x: number, y: number) => {
    const vertical = Math.abs(x - 50) <= 2.5;
    const horizontal = Math.abs(y - 50) <= 2.5;
    showStoryAlignmentGuides(vertical, horizontal);
    return { x: vertical ? 50 : x, y: horizontal ? 50 : y };
  };

  const snapStoryTextOffset = (offset: Point) => {
    const position = snapStoryLayerPosition(
      50 + (offset.x / Math.max(1, window.innerWidth)) * 100,
      50 + (offset.y / Math.max(1, window.innerHeight)) * 100,
    );
    return {
      x: ((position.x - 50) / 100) * window.innerWidth,
      y: ((position.y - 50) / 100) * window.innerHeight,
    };
  };

  const snapStoryMediaOffset = (offset: Point) => {
    const vertical = Math.abs(offset.x) <= 12;
    const horizontal = Math.abs(offset.y) <= 12;
    showStoryAlignmentGuides(vertical, horizontal);
    return { x: vertical ? 0 : offset.x, y: horizontal ? 0 : offset.y };
  };

  const handleStoryTextTransformChange = (transform: { x: number; y: number; scale: number; rotation: number }) => {
    setStoryTextOffset(snapStoryTextOffset({ x: transform.x, y: transform.y }));
    setStoryTextScale(transform.scale);
    setStoryTextRotation(transform.rotation);
  };

  // تكبير حقل النص تلقائياً مع طول الكتابة
  useEffect(() => {
    const field = storyTextAreaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [storyText, storyFontFamily, storyTextAlign, storyTextEditorOpen, storyTextFontSize]);

  const storyGestureRef = useRef<StoryGestureState | null>(null);
  const lastStoryTouchRef = useRef(0);

  const openStoryTextEditor = (id?: string) => {
    setActiveStoryStickerId(null);
    const layer = id ? timedTexts.find((item): item is StoryTextOverlay =>
      item.id === id && (item.type === undefined || item.type === 'text'),
    ) : undefined;
    setEditingStoryTextId(layer?.id ?? null);
    setStoryText(layer?.text || '');
    setStoryTextOffset(layer ? {
      x: ((layer.x - 50) / 100) * window.innerWidth,
      y: ((layer.y - 50) / 100) * window.innerHeight,
    } : { x: 0, y: 0 });
    setStoryTextScale(layer?.scale ?? 1);
    setStoryTextFontSize(layer?.fontSize ?? 30);
    setStoryTextRotation(layer?.rotation ?? 0);
    setStoryFontFamily(layer?.fontFamily || 'Cairo');
    setStoryTextColor(layer?.textColor || '#FFFFFF');
    setStoryTextAlign(layer?.textAlign || 'center');
    setStoryTextAnimation(layer?.textAnimation || 'none');
    if (layer?.textBackground) {
      const backgroundIndex = STORY_TEXT_BACKGROUNDS.findIndex(item => item.background === layer.textBackground);
      setStoryBackgroundIndex(backgroundIndex >= 0 ? backgroundIndex : 0);
    } else {
      setStoryBackgroundIndex(0);
    }
    setStoryDrawingOpen(false);
    setStoryFiltersOpen(false);
    setStoryMoreOpen(false);
    setStoryDurationOpen(false);
    setStoryTextEditorOpen(true);
  };

  const handleStoryCanvasTap = (id?: string) => {
    if (id) {
      openStoryTextEditor(id);
      return;
    }

    if (activeStoryStickerId) {
      setActiveStoryStickerId(null);
      return;
    }

    const panels = storyPanelsRef.current;
    if (panels.textEditor) {
      finishStoryTextEditing();
      return;
    }
    if (panels.filters || panels.more || panels.drawing || panels.duration || panels.music || panels.mentions || panels.closeFriends) {
      closeStoryPanels();
      return;
    }

    openStoryTextEditor();
  };

  const handleStoryCanvasClick = () => {
    if (Date.now() - lastStoryTouchRef.current < 500) return;
    handleStoryCanvasTap();
  };

  // قيم المرجع حسب العنصر المقفل
  const readStoryGestureBase = (target: StoryGestureTarget) => {
    if (target === 'text') {
      const selectedLayer = storyGestureTextIdRef.current
        ? timedTexts.find((layer): layer is StoryTextOverlay => layer.id === storyGestureTextIdRef.current
          && (layer.type === undefined || layer.type === 'text'))
        : undefined;
      if (selectedLayer) {
        return {
          x: ((selectedLayer.x - 50) / 100) * window.innerWidth,
          y: ((selectedLayer.y - 50) / 100) * window.innerHeight,
          scale: selectedLayer.scale ?? 1,
          rotate: selectedLayer.rotation ?? 0,
        };
      }
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
    if (element?.closest('[data-story-editor-control], button:not([data-story-text]), input, textarea, select')) {
      storyGestureRef.current = null;
      storyGestureTextIdRef.current = null;
      return;
    }
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

    const textElement = element?.closest('[data-story-text]');
    storyGestureTextIdRef.current = textElement?.getAttribute('data-story-text-id') || null;
    const target: StoryGestureTarget = textElement
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
      const deltaX = (center.x - gesture.startX) * scaleFactor;
      const deltaY = (center.y - gesture.startY) * scaleFactor;
      gesture.moved = true;

      if (gesture.target === 'text') {
        const nextScale = Math.min(5, Math.max(0.3, gesture.scale * ratio));
        const nextRotation = gesture.rotate + deltaAngle;
        const nextOffset = snapStoryTextOffset({
          x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.45),
          y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.45),
        });
        setStoryTextScale(nextScale);
        setStoryTextRotation(nextRotation);
        setStoryTextOffset(nextOffset);
        const layerId = storyGestureTextIdRef.current;
        if (layerId) {
          setTimedTexts(previous => previous.map(layer => layer.id === layerId
            && (layer.type === undefined || layer.type === 'text') ? {
            ...layer,
            x: 50 + (nextOffset.x / window.innerWidth) * 100,
            y: 50 + (nextOffset.y / window.innerHeight) * 100,
            scale: nextScale,
            rotation: nextRotation,
          } : layer));
        }
        return;
      }

      if (gesture.target === 'image') {
        setStoryMediaZoom(Math.min(4, Math.max(0.4, gesture.scale * ratio)));
        setStoryMediaRotate(gesture.rotate + deltaAngle);
        setStoryMediaOffset(snapStoryMediaOffset({
          x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.6),
          y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.6),
        }));
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
    const screenDeltaX = touch.clientX - gesture.startX;
    const screenDeltaY = touch.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(screenDeltaX, screenDeltaY) < 6) return;
    gesture.moved = true;
    const deltaX = screenDeltaX * scaleFactor;
    const deltaY = screenDeltaY * scaleFactor;

    if (gesture.target === 'text') {
      const nextOffset = snapStoryTextOffset({
        x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.45),
        y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.4),
      });
      setStoryTextOffset(nextOffset);
      const layerId = storyGestureTextIdRef.current;
      if (layerId) {
        setTimedTexts(previous => previous.map(layer => layer.id === layerId
          && (layer.type === undefined || layer.type === 'text') ? {
          ...layer,
          x: 50 + (nextOffset.x / window.innerWidth) * 100,
          y: 50 + (nextOffset.y / window.innerHeight) * 100,
        } : layer));
      }
      return;
    }

    if (gesture.target === 'image') {
      setStoryMediaOffset(snapStoryMediaOffset({
        x: clampCanvas(gesture.x + deltaX, window.innerWidth * 0.6),
        y: clampCanvas(gesture.y + deltaY, window.innerHeight * 0.6),
      }));
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
    showStoryAlignmentGuides(false, false);
    lastStoryTouchRef.current = Date.now();
    const textLayerId = storyGestureTextIdRef.current;
    storyGestureTextIdRef.current = null;

    if (!gesture.moved && Date.now() - gesture.startTime < 400) {
      if (activeStoryStickerId && !textLayerId) {
        handleStoryCanvasTap();
        return;
      }
      if (reshareStory && !textLayerId) {
        setReshareScaledDown(current => !current);
        return;
      }
      handleStoryCanvasTap(textLayerId || undefined);
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
      const preview = previewStoryUrlRef.current;
      if (preview) URL.revokeObjectURL(preview.url);
      previewStoryUrlRef.current = null;
      setPreviewStoryUrl(null);
      return;
    }

    const existingPreview = previewStoryUrlRef.current;
    if (existingPreview?.file === storyFile) {
      setPreviewStoryUrl(existingPreview.url);
      return () => {
        if (previewStoryUrlRef.current?.url === existingPreview.url) {
          URL.revokeObjectURL(existingPreview.url);
          previewStoryUrlRef.current = null;
        }
      };
    }

    const url = URL.createObjectURL(storyFile);
    previewStoryUrlRef.current = { file: storyFile, url };
    setPreviewStoryUrl(url);

    return () => {
      if (previewStoryUrlRef.current?.url === url) {
        URL.revokeObjectURL(url);
        previewStoryUrlRef.current = null;
      }
    };
  }, [storyFile]);
  const [caption, setCaption] = useState('');
  const [isCloseFriendsOnly, setIsCloseFriendsOnly] = useState(false);
  const [uploadDuration, setUploadDuration] = useState<number>(60);
  const storyDurationManuallyChosenRef = useRef(true);
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

  const { fetchStories, fetchStoryArchive } = useStoriesData({
    userId,
    pendingProfileStoryOwnerId,
    pendingStoryId,
    onProfileStoryHandled,
    setGroupedStories,
    setArchiveStories,
    setArchiveLoading,
    setProfileStoryOwnerId,
    setProfilePreviewStories,
    setActiveUserGroup,
    setActiveStoryIndex,
    setProgress,
    setCurrentTimeSec,
  });

  const { handleQuickPublishStory, handleCreateTextStory } = useStoryCreationActions({
    userId,
    currentProfile,
    storyFile,
    reshareStory,
    caption,
    isCloseFriendsOnly,
    uploadDuration,
    storyMediaOffset,
    storyMediaZoom,
    storyMediaRotate,
    timedTexts,
    storyDrawStrokes,
    storyFilterId,
    storyFilterAdjustments,
    storyMentions,
    fetchStories,
    setUploading,
    setUploadProgress,
    setStoryFile,
    setReshareStory,
    setReshareScaledDown,
    setCaption,
    setTimedTexts,
    setStoryDrawStrokes,
    setStoryDrawingOpen,
    activeStoryDrawStrokeRef,
    setStoryMentions,
    setStoryDurationOpen,
    storyDurationManuallyChosenRef,
    setShowUploadModal,
    setStoryText,
  });

  const buildStoryTextLayer = (text: string): StoryTextOverlay => ({
    id: editingStoryTextId || `story-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    layerOrder: timedTexts.find(layer => layer.id === editingStoryTextId)?.layerOrder
      ?? Math.max(9, ...timedTexts.map((layer, index) => layer.layerOrder ?? index + 10)) + 1,
    type: 'text',
    text,
    startTime: 0,
    endTime: uploadDuration,
    x: Math.min(95, Math.max(5, 50 + (storyTextOffset.x / Math.max(1, window.innerWidth)) * 100)),
    y: Math.min(95, Math.max(5, 50 + (storyTextOffset.y / Math.max(1, window.innerHeight)) * 100)),
    fontFamily: storyFontFamily,
    textColor: storyTextColor,
    textAlign: storyTextAlign,
    textBackground: storyBackgroundPreset.background,
    textAnimation: storyTextAnimation,
    fontSize: storyTextFontSize,
    scale: storyTextScale,
    rotation: storyTextRotation,
  });

  function finishStoryTextEditing() {
    const text = storyText.trim();
    if (text) {
      const layer = buildStoryTextLayer(text);
      setTimedTexts(previous => editingStoryTextId
        ? previous.map(item => item.id === editingStoryTextId ? layer : item)
        : [...previous, layer]);
    } else if (editingStoryTextId) {
      setTimedTexts(previous => previous.filter(item => item.id !== editingStoryTextId));
    }
    setStoryText('');
    setEditingStoryTextId(null);
    setStoryTextEditorOpen(false);
    showStoryAlignmentGuides(false, false);
  }

  const updateStoryImageSticker = (id: string, update: StoryImageStickerUpdate) => {
    const current = timedTexts.find((layer): layer is StoryImageOverlay => layer.type === 'image' && layer.id === id);
    const hasPosition = update.x !== undefined || update.y !== undefined;
    const position = hasPosition && current
      ? snapStoryLayerPosition(update.x ?? current.x, update.y ?? current.y)
      : null;
    setTimedTexts(previous => previous.map(layer => layer.type === 'image' && layer.id === id
      ? { ...layer, ...update, ...(position || {}) }
      : layer));
  };

  const handleStoryImageStickerDragChange = (id: string, dragging: boolean, overDeleteZone: boolean) => {
    if (dragging) {
      setDraggingStoryStickerId(id);
      setStoryStickerOverDeleteZone(overDeleteZone);
      return;
    }

    showStoryAlignmentGuides(false, false);
    if (overDeleteZone) {
      setTimedTexts(previous => previous.filter(layer => layer.id !== id));
      setActiveStoryStickerId(current => current === id ? null : current);
    }
    setDraggingStoryStickerId(null);
    setStoryStickerOverDeleteZone(false);
  };

  const handleStoryDurationChange = (duration: number) => {
    storyDurationManuallyChosenRef.current = true;
    setUploadDuration(duration);
    setTimedTexts(previous => previous.map(layer => layer.type === 'image'
      ? { ...layer, endTime: duration }
      : layer));
  };

  const openStoryStickerPicker = () => {
    if (storyTextEditorOpen) finishStoryTextEditing();
    setStoryTextEditorOpen(false);
    setStoryFiltersOpen(false);
    setStoryDrawingOpen(false);
    setStoryMoreOpen(false);
    setStoryDurationOpen(false);
    setStoryMusicOpen(false);
    setStoryMentionsOpen(false);
    storyStickerInputRef.current?.click();
  };

  const handleStoryStickerFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('اختر صورة لإضافتها كملصق');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error('حجم صورة الملصق يجب ألا يتجاوز 20 ميغابايت');
      return;
    }

    const src = URL.createObjectURL(file);
    localStickerObjectUrlsRef.current.add(src);
    const sticker: StoryImageOverlay = {
      id: `story-sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      layerOrder: Math.max(9, ...timedTexts.map((layer, index) => layer.layerOrder ?? index + 10)) + 1,
      type: 'image',
      src,
      localFile: file,
      shape: 'square',
      startTime: 0,
      endTime: uploadDuration,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      cropX: 0,
      cropY: 0,
      cropScale: 1,
    };
    setTimedTexts(previous => [...previous, sticker]);
    setActiveStoryStickerId(sticker.id);
  };

  const closeTextOnlyStory = () => {
    setShowTextOnlyStoryCanvas(false);
    setStoryTextEditorOpen(false);
    setStoryText('');
    setTimedTexts([]);
    setEditingStoryTextId(null);
    setActiveStoryStickerId(null);
    setDraggingStoryStickerId(null);
    setStoryStickerOverDeleteZone(false);
    setStoryDrawStrokes([]);
    setStoryDrawingOpen(false);
    activeStoryDrawStrokeRef.current = null;
    closeStoryPanels();
  };

  const openTextOnlyStory = () => {
    textCanvasMediaPickerRef.current = false;
    setShowStoryPicker(false);
    setShowUploadModal(false);
    setStoryFile(null);
    setReshareStory(null);
    setReshareScaledDown(false);
    setCaption('');
    setStoryText('');
    setTimedTexts([]);
    setEditingStoryTextId(null);
    setActiveStoryStickerId(null);
    setDraggingStoryStickerId(null);
    setStoryStickerOverDeleteZone(false);
    setStoryTextEditorOpen(false);
    setStoryFontFamily('Cairo');
    setStoryTextColor('#FFFFFF');
    setStoryTextAlign('center');
    setStoryTextAnimation('none');
    setStoryBackgroundIndex(0);
    setStoryTextOffset({ x: 0, y: 0 });
    setStoryTextScale(1);
    setStoryTextFontSize(30);
    setStoryTextRotation(0);
    setStoryAlignmentGuides({ vertical: false, horizontal: false });
    setTextCanvasBackground('#000000');
    setStoryDrawStrokes([]);
    setStoryDrawingOpen(false);
    activeStoryDrawStrokeRef.current = null;
    setStoryFiltersOpen(false);
    setStoryFilterId('original');
    setStoryFilterAdjustments(DEFAULT_FILTER_ADJUSTMENTS);
    setStoryMusicOpen(false);
    setStoryMusicTrack(null);
    setStoryMentionsOpen(false);
    setStoryMentions([]);
    setCloseFriendsOpen(false);
    setStoryMoreOpen(false);
    setStoryDurationOpen(false);
    setUploadDuration(60);
    setIsCloseFriendsOnly(false);
    storyDurationManuallyChosenRef.current = true;
    setShowTextOnlyStoryCanvas(true);
  };

  const openArchivedStoryForReshare = (story: StoryRow) => {
    setArchiveViewerOpen(false);
    setActiveUserGroup(null);

    const canvasStyle = story.timed_texts.find(
      (layer): layer is StoryCanvasStyleOverlay => layer.type === 'canvas-style',
    );
    const drawing = story.timed_texts.find(
      (layer): layer is StoryDrawingOverlay => layer.type === 'drawing',
    );
    const storyFilter = decodeStoryFilterKey(story.filter_key);
    const duration = Math.min(120, Math.max(5, Number(story.duration_seconds) || 60));

    if (story.media_url && story.media_type !== 'text') {
      const mediaTransform = story.timed_texts.find(
        (layer): layer is StoryMediaTransformOverlay => layer.type === 'media-transform',
      );
      setStoryFile(null);
      setReshareStory(story);
      setReshareScaledDown(true);
      setCaption(story.caption || '');
      setStoryText('');
      setTimedTexts(story.timed_texts.filter(layer => layer.type !== 'drawing' && layer.type !== 'media-transform'));
      setStoryDrawStrokes(drawing?.strokes || []);
      setStoryDrawingOpen(false);
      activeStoryDrawStrokeRef.current = null;
      setStoryMentions([]);
      setStoryMusicTrack(null);
      setStoryCanvasScale(1);
      setStoryCanvasOffset({ x: 0, y: 0 });
      setStoryMediaOffset({
        x: ((mediaTransform?.x ?? 0) / 100) * window.innerWidth,
        y: ((mediaTransform?.y ?? 0) / 100) * window.innerHeight,
      });
      setStoryMediaZoom(mediaTransform?.scale ?? 1);
      setStoryMediaRotate(mediaTransform?.rotation ?? 0);
      setStoryTextOffset({ x: 0, y: 0 });
      setStoryTextScale(1);
      setStoryTextRotation(0);
      setStoryFilterId(storyFilter.id);
      setStoryFilterAdjustments(storyFilter.adjustments);
      setStoryAlignmentGuides({ vertical: false, horizontal: false });
      setStoryTextEditorOpen(false);
      setStoryDurationOpen(false);
      setIsCloseFriendsOnly(false);
      storyDurationManuallyChosenRef.current = true;
      setUploadDuration(duration);
      closeStoryPanels();
      setShowStoryPicker(false);
      setShowTextOnlyStoryCanvas(false);
      setShowUploadModal(true);
      return;
    }

    const restoredLayers = story.timed_texts.filter(layer => layer.type !== 'drawing' && layer.type !== 'media-transform');
    const hasTextLayer = restoredLayers.some(layer => layer.type === undefined || layer.type === 'text');
    const backgroundIndex = STORY_TEXT_BACKGROUNDS.findIndex(item => item.background === canvasStyle?.textBackground);
    openTextOnlyStory();
    setStoryText(hasTextLayer ? '' : story.caption || '');
    setTimedTexts(restoredLayers);
    setStoryDrawStrokes(drawing?.strokes || []);
    setTextCanvasBackground(canvasStyle?.background || '#000000');
    setStoryFontFamily(canvasStyle?.fontFamily || 'Cairo');
    setStoryTextColor(canvasStyle?.textColor || '#FFFFFF');
    setStoryTextAlign(canvasStyle?.textAlign || 'center');
    setStoryTextAnimation(canvasStyle?.textAnimation || 'none');
    setStoryBackgroundIndex(backgroundIndex >= 0 ? backgroundIndex : 0);
    setStoryFilterId(storyFilter.id);
    setStoryFilterAdjustments(storyFilter.adjustments);
    setStoryDrawStrokes(drawing?.strokes || []);
    setUploadDuration(duration);
  };

  const handlePublishTextOnlyStory = (closeFriends: boolean) => {
    const canvasStyle: StoryCanvasStyle = {
      background: textCanvasBackground || '#000000',
      textBackground: storyBackgroundPreset.background,
      textColor: storyTextColor,
      fontFamily: storyFontFamily,
      textAlign: storyTextAlign,
      textAnimation: storyTextAnimation,
    };
    const draftText = storyText.trim();
    let textLayersToPublish = [...timedTexts];
    if (editingStoryTextId) {
      if (draftText) {
        const updatedLayer = buildStoryTextLayer(draftText);
        const hasEditingLayer = textLayersToPublish.some(layer => layer.id === editingStoryTextId);
        textLayersToPublish = hasEditingLayer
          ? textLayersToPublish.map(layer => layer.id === editingStoryTextId ? updatedLayer : layer)
          : [...textLayersToPublish, updatedLayer];
      } else {
        textLayersToPublish = textLayersToPublish.filter(layer => layer.id !== editingStoryTextId);
      }
    } else if (draftText) {
      textLayersToPublish = [...textLayersToPublish, buildStoryTextLayer(draftText)];
    }

    const orderedLayers = textLayersToPublish.map((layer, index) =>
      layer.type === 'text' || layer.type === undefined || layer.type === 'image' || layer.type === 'drawing'
        ? { ...layer, layerOrder: layer.layerOrder ?? index + 10 }
        : layer,
    );
    void handleCreateTextStory('', canvasStyle, orderedLayers, closeFriends).then(published => {
      if (!published) return;
      setShowTextOnlyStoryCanvas(false);
      setStoryTextEditorOpen(false);
      setStoryText('');
      setEditingStoryTextId(null);
      setActiveStoryStickerId(null);
      setDraggingStoryStickerId(null);
      setStoryStickerOverDeleteZone(false);
    });
  };

  const orderedStoryUserIds = useMemo(() => {
    const seenIds = new Set(seenStoryIds);
    const newestStoryTime = (stories: StoryRow[]) => Math.max(
      0,
      ...stories.map(story => Date.parse(story.created_at)).filter(Number.isFinite),
    );

    return Object.keys(groupedStories).sort((firstId, secondId) => {
      if (firstId === userId) return secondId === userId ? 0 : -1;
      if (secondId === userId) return 1;

      const firstUnseen = groupedStories[firstId].some(story => !seenIds.has(story.id));
      const secondUnseen = groupedStories[secondId].some(story => !seenIds.has(story.id));
      if (firstUnseen !== secondUnseen) return firstUnseen ? -1 : 1;

      const newestDifference = newestStoryTime(groupedStories[secondId]) - newestStoryTime(groupedStories[firstId]);
      return newestDifference || firstId.localeCompare(secondId, 'ar');
    });
  }, [groupedStories, seenStoryIds, userId]);

  const activeStories = useMemo(() => {
    if (archiveViewerOpen) return archiveStories;
    if (activeUserGroup && activeUserGroup === profileStoryOwnerId) return profilePreviewStories;
    return activeUserGroup && groupedStories[activeUserGroup] ? groupedStories[activeUserGroup] : [];
  }, [activeUserGroup, archiveStories, archiveViewerOpen, groupedStories, profileStoryOwnerId, profilePreviewStories]);

  const currentStory = activeStories[activeStoryIndex] || null;
  currentStoryRef.current = currentStory;
  const isStoryOwner = Boolean(currentStory && currentStory.user_id === userId);
  const storedStoryDuration = Number(currentStory?.duration_seconds);
  const storyDisplayDuration = Number.isFinite(storedStoryDuration) && storedStoryDuration > 0
    ? Math.min(120, Math.max(5, storedStoryDuration))
    : 5;
  const currentVideoDuration = currentStory && videoDurationForStory?.storyId === currentStory.id
    ? videoDurationForStory?.durationSeconds ?? 5
    : null;
  const currentStoryFilter = decodeStoryFilterKey(currentStory?.filter_key ?? undefined);
  useEffect(() => {
    const originalStoryId = currentStory?.original_story_id;
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
          .select('id, username, full_name, display_name, avatar_url')
          .eq('id', originalStory.user_id)
          .maybeSingle();
        if (authorError) console.warn('[stories] تعذر تحميل ملف صاحب القصة الأصلية:', authorError);
        if (active) setOriginalStoryAuthor(normalizeStoryAuthor(author));
      } catch (error) {
        if (active) console.warn('[stories] تعذر تحميل بيانات القصة الأصلية:', error);
      }
    })();

    return () => {
      active = false;
    };
  }, [currentStory]);
  const currentStoryFilterOverlay = getStoryFilterOverlay(currentStoryFilter.id);
  const { loadStoryViewerEntries, loadStoryViewerPreview } = useStoryViewerData({
    userId,
    currentStory,
    storyViewsRequestRef,
    setStoryViewers,
    setStoryViewsCount,
    setStoryViewerPreview,
  });
  const {
    handleOpenStoryViews,
    handleCloseStoryViews,
    handleOpenViewerReport,
    handleSubmitViewerReport,
    handleReportStory,
    handleBlockStoryViewer,
    handleHideStoryFromViewer,
    handleToggleStoryViewerFollow,
    handleToggleLike,
    handleSendReply,
  } = useStoryViewerActions({
    userId,
    currentStory,
    isStoryOwner,
    isPaused,
    storyViewsOpen,
    storyViewers,
    viewerActionBusyId,
    viewerReportTarget,
    viewerReportCategory,
    viewerReportDetails,
    viewerReportBusy,
    isLiked,
    isLikeSaving,
    isSendingReply,
    replyText,
    storyViewsWasPausedRef,
    storyVideoRef,
    storyVideoWasPlayingRef,
    storyViewsRequestRef,
    storyViewsChannelRef,
    loadStoryViewerEntries,
    loadStoryViewerPreview,
    setStoryViewsOpen,
    setStoryViewsLoading,
    setStoryViewsError,
    setStoryViewsCount,
    setStoryViewers,
    setStoryViewerPreview,
    setViewerActionBusyId,
    setViewerReportTarget,
    setViewerReportCategory,
    setViewerReportDetails,
    setViewerReportBusy,
    setViewerRowMenuOpen,
    setIsPaused,
    setIsLiked,
    setIsLikeSaving,
    setIsSendingReply,
    setReplyText,
    setShowMenu,
  });

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
    if (progressStoryIdRef.current !== currentStory?.id) {
      progressStoryIdRef.current = currentStory?.id ?? null;
      progressRef.current = 0;
      setProgress(0);
      setCurrentTimeSec(0);
    }
    autoAdvancedStoryIdRef.current = null;
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
    if (!currentStory || isStoryOwner || archiveViewerOpen) return;
    markStorySeen(String(currentStory.id));
  }, [archiveViewerOpen, currentStory?.id, isStoryOwner, markStorySeen]);

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

    const storyId = currentStory.id;
    if (currentStory.media_type === 'video' && currentStory.media_url) {
      if (!Number.isFinite(currentVideoDuration) || currentVideoDuration === null || currentVideoDuration <= 0) return;
      const video = storyVideoRef.current;
      if (!video || video.readyState < 1) return;
      const remainingMs = Math.max(0, (currentVideoDuration - video.currentTime) * 1000);
      const videoEndFallback = window.setTimeout(() => {
        if (currentStoryRef.current?.id === storyId && storyVideoRef.current?.ended) {
          autoAdvanceStoryRef.current(storyId);
        }
      }, remainingMs);
      return () => window.clearTimeout(videoEndFallback);
    }

    const durationMs = storyDisplayDuration * 1000;
    const elapsedMs = Math.min(durationMs, Math.max(0, (progressRef.current / 100) * durationMs));
    const startedAt = Date.now() - elapsedMs;
    const updateProgress = () => {
      if (currentStoryRef.current?.id !== storyId) return;
      const elapsed = Math.min(durationMs, Math.max(0, Date.now() - startedAt));
      const nextProgress = Math.min(100, (elapsed / durationMs) * 100);
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      setCurrentTimeSec(elapsed / 1000);
    };

    updateProgress();
    const progressInterval = window.setInterval(updateProgress, 50);
    const storyTimeout = window.setTimeout(() => {
      if (currentStoryRef.current?.id !== storyId) return;
      progressRef.current = 100;
      setProgress(100);
      setCurrentTimeSec(storyDisplayDuration);
      autoAdvanceStoryRef.current(storyId);
    }, Math.max(0, durationMs - elapsedMs));

    return () => {
      window.clearInterval(progressInterval);
      window.clearTimeout(storyTimeout);
    };
  }, [activeStoryIndex, activeUserGroup, archiveViewerOpen, currentStory?.id, currentStory?.media_type, currentStory?.media_url, currentVideoDuration, isPaused, storyDisplayDuration, storyViewsOpen]);

  const handleNextStory = () => {
    if (currentStory?.id) markStorySeen(String(currentStory.id));

    if (archiveViewerOpen) {
      if (activeStoryIndex < activeStories.length - 1) {
        setActiveStoryIndex(index => index + 1);
        setProgress(0);
        setCurrentTimeSec(0);
      } else {
        setArchiveViewerOpen(false);
        setActiveUserGroup(null);
      }
      return;
    }

    if (activeStoryIndex < activeStories.length - 1) {
      setActiveStoryIndex(prev => prev + 1);
      setProgress(0);
      setCurrentTimeSec(0);
    } else {
      const userIds = orderedStoryUserIds;
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

  autoAdvanceStoryRef.current = (storyId: string) => {
    if (currentStoryRef.current?.id !== storyId || autoAdvancedStoryIdRef.current === storyId) return;
    autoAdvancedStoryIdRef.current = storyId;
    handleNextStory();
  };

  const handleStoryVideoMetadata = (storyId: string, durationSeconds: number) => {
    if (currentStoryRef.current?.id !== storyId || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    setVideoDurationForStory({ storyId, durationSeconds });
    progressRef.current = 0;
    setProgress(0);
    setCurrentTimeSec(0);
  };

  const handleStoryVideoTimeUpdate = (storyId: string, currentTimeSeconds: number, durationSeconds: number) => {
    if (currentStoryRef.current?.id !== storyId || !Number.isFinite(currentTimeSeconds)) return;
    const storedDuration = videoDurationForStory?.storyId === storyId
      ? videoDurationForStory?.durationSeconds
      : undefined;
    const duration = storedDuration !== undefined && Number.isFinite(storedDuration) && storedDuration > 0
      ? storedDuration
      : Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : 5;
    const elapsed = Math.min(duration, Math.max(0, currentTimeSeconds));
    const nextProgress = Math.min(100, (elapsed / duration) * 100);
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    setCurrentTimeSec(elapsed);
  };

  const handleStoryVideoEnded = (storyId: string) => {
    autoAdvanceStoryRef.current(storyId);
  };

  const handlePrevStory = () => {
    if (archiveViewerOpen) {
      if (activeStoryIndex > 0) {
        setActiveStoryIndex(index => index - 1);
        setProgress(0);
        setCurrentTimeSec(0);
      }
      return;
    }

    if (activeStoryIndex > 0) {
      setActiveStoryIndex(prev => prev - 1);
      setProgress(0);
      setCurrentTimeSec(0);
    } else {
      const userIds = orderedStoryUserIds;
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
    if (archiveViewerOpen) {
      const archiveIndex = archiveStories.findIndex(story => story.id === currentStory.id);
      const remainingStories = archiveStories.filter(story => story.id !== currentStory.id);
      setArchiveStories(remainingStories);
      if (remainingStories.length === 0) {
        setArchiveViewerOpen(false);
        setActiveUserGroup(null);
      } else {
        setActiveStoryIndex(Math.min(Math.max(0, archiveIndex), remainingStories.length - 1));
        setProgress(0);
        setCurrentTimeSec(0);
      }
      return;
    }
    await fetchStories();
    handleNextStory();
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

    const strokes = activeStoryDrawStrokeRef.current
      ? [...storyDrawStrokes, activeStoryDrawStrokeRef.current]
      : storyDrawStrokes;
    strokes.forEach(stroke => drawStoryStroke(context, stroke, width, height));
  }, [storyDrawStrokes]);

  useEffect(() => {
    if ((!showUploadModal && !showTextOnlyStoryCanvas) || (showUploadModal && !editorMediaUrl)) return;
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
  }, [editorMediaUrl, redrawStoryDrawingCanvas, showTextOnlyStoryCanvas, showUploadModal]);

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
      tool: storyDrawingTool,
    };
    activeStoryDrawStrokeRef.current = stroke;
    canvas.setPointerCapture(event.pointerId);
    redrawStoryDrawingCanvas();
  };

  const handleStoryDrawPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStoryDrawStrokeRef.current;
    if (!storyDrawingOpen || !stroke) return;
    event.preventDefault();
    event.stopPropagation();

    const canvas = event.currentTarget;
    stroke.points.push(getStoryDrawPoint(canvas, event.clientX, event.clientY));
    redrawStoryDrawingCanvas();
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

  const handleStoryFilesSelected = (files: File[]) => {
    if (!files.length) return;

    if (textCanvasMediaPickerRef.current) {
      textCanvasMediaPickerRef.current = false;
      setShowTextOnlyStoryCanvas(false);
      setStoryTextEditorOpen(false);
      setStoryText('');
      setCaption('');
      setStoryDrawStrokes([]);
      setStoryMentions([]);
    }
    setTimedTexts([]);
    setEditingStoryTextId(null);

    if (files.length > 1) {
      toast.info('سيُستخدم أول وسيط مختار لنشر القصة');
    }

    if (previewStoryUrlRef.current) {
      URL.revokeObjectURL(previewStoryUrlRef.current.url);
    }
    const previewUrl = URL.createObjectURL(files[0]);
    previewStoryUrlRef.current = { file: files[0], url: previewUrl };
    setPreviewStoryUrl(previewUrl);
    setStoryFile(files[0]);
    setStoryCanvasScale(1);
    setStoryCanvasOffset({ x: 0, y: 0 });
    setStoryMediaZoom(1);
    setStoryMediaRotate(0);
    setStoryMediaOffset({ x: 0, y: 0 });
    setStoryAlignmentGuides({ vertical: false, horizontal: false });
    setStoryDrawStrokes([]);
    setStoryDrawingOpen(false);
    activeStoryDrawStrokeRef.current = null;
    setReshareStory(null);
    setReshareScaledDown(false);
    storyDurationManuallyChosenRef.current = false;
    setUploadDuration(5);
    setStoryDurationOpen(false);
    setShowStoryPicker(false);
    setShowUploadModal(true);
  };

  return (
    <div className="contents" dir="rtl">
      <input
        ref={storyStickerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label="اختيار صورة كملصق للقصة"
        onChange={handleStoryStickerFileChange}
      />
      <input
        ref={storyFileInputRef}
        type="file"
        accept="image/*,video/*"
        className="sr-only"
        aria-label="اختيار صورة أو فيديو للقصة"
        onChange={event => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = '';
          handleStoryFilesSelected(files);
        }}
      />
      <StoriesStrip
        userId={userId}
        currentProfile={currentProfile}
        groupedStories={groupedStories}
        seenStoryIds={seenStoryIds}
        orderedUserIds={orderedStoryUserIds}
        uploading={uploading}
        uploadProgress={uploadProgress}
        onOpenMyStories={() => {
          setArchiveViewerOpen(false);
          setActiveUserGroup(userId);
          setActiveStoryIndex(0);
          setProgress(0);
        }}
        onOpenPicker={() => {
          setArchiveViewerOpen(false);
          storyFileInputRef.current?.click();
        }}
        onOpenStoryGroup={authorId => {
          setArchiveViewerOpen(false);
          setActiveUserGroup(authorId);
          setActiveStoryIndex(0);
          setProgress(0);
          setCurrentTimeSec(0);
        }}
      />

      {createPortal(
        <>
          <StoryComposerSheet
        open={showStoryPicker}
        autoOpenGallery={!skipStoryGalleryAutoOpenRef.current}
        onClose={() => {
          setShowStoryPicker(false);
          if (textCanvasMediaPickerRef.current) {
            textCanvasMediaPickerRef.current = false;
            setShowTextOnlyStoryCanvas(true);
          }
        }}
        archive={archiveStories}
        archiveLoading={archiveLoading}
        onOpenArchive={() => { void fetchStoryArchive(); }}
        onOpenArchivedStory={story => {
          setShowStoryPicker(false);
          setArchiveViewerOpen(true);
          setActiveUserGroup(userId);
          setActiveStoryIndex(Math.max(0, archiveStories.findIndex(item => item.id === story.id)));
          setProgress(0);
          setCurrentTimeSec(0);
        }}
        onTextMode={openTextOnlyStory}
        onFilesSelected={handleStoryFilesSelected}
      />

      {showTextOnlyStoryCanvas && (
        <TextOnlyStoryCanvas
          userId={userId}
          currentProfile={currentProfile}
          storyText={storyText}
          textLayers={timedTexts}
          onUpdateImageSticker={updateStoryImageSticker}
          onActivateImageSticker={setActiveStoryStickerId}
          draggingStoryStickerId={draggingStoryStickerId}
          storyStickerOverDeleteZone={storyStickerOverDeleteZone}
          onStoryStickerDragChange={handleStoryImageStickerDragChange}
          onCanvasTap={handleStoryCanvasTap}
          onClose={closeTextOnlyStory}
          fontFamily={storyFontFamily}
          textColor={storyTextColor}
          textAlign={storyTextAlign}
          textAnimation={storyTextAnimation}
          textBackgroundPreset={storyBackgroundPreset}
          canvasBackground={textCanvasBackground}
          storyTextOffset={storyTextOffset}
          storyTextScale={storyTextScale}
          storyTextFontSize={storyTextFontSize}
          storyTextRotation={storyTextRotation}
          storyAlignmentGuides={storyAlignmentGuides}
          editorOpen={storyTextEditorOpen}
          keyboardInset={storyKeyboardInset}
          animationTick={storyAnimationTick}
          previewClassName={storyPreviewClassName}
          editorPreviewMode={storyEditorPreviewMode}
          textAreaRef={storyTextAreaRef}
          storyToolsRef={storyToolsRef}
          storyDrawingCanvasRef={storyDrawingCanvasRef}
          storyMoreOpen={storyMoreOpen}
          storyDurationOpen={storyDurationOpen}
          extraTools={storyExtraTools}
          uploadDuration={uploadDuration}
          storyFiltersOpen={storyFiltersOpen}
          storyFilterId={storyFilterId}
          storyFilterAdjustments={storyFilterAdjustments}
          storyFilterValue={storyFilterValue}
          storyFilterOverlay={storyFilterOverlay}
          storyMusicTrack={storyMusicTrack}
          storyDrawingOpen={storyDrawingOpen}
          storyDrawTool={storyDrawingTool}
          storyDrawColor={storyDrawColor}
          storyDrawSize={storyDrawSize}
          storyDrawStrokes={storyDrawStrokes}
          storyMusicOpen={storyMusicOpen}
          storyMentionsOpen={storyMentionsOpen}
          closeFriendsOpen={closeFriendsOpen}
          uploading={uploading}
          onPublish={handlePublishTextOnlyStory}
          onOpenTextEditor={openStoryTextEditor}
          onFinishEditing={finishStoryTextEditing}
          onTextChange={setStoryText}
          onFontFamilyChange={setStoryFontFamily}
          onTextColorChange={setStoryTextColor}
          onCycleAlign={() => setStoryTextAlign(previous => nextStoryTextAlign(previous))}
          onCycleTextBackground={() => setStoryBackgroundIndex(previous => (previous + 1) % STORY_TEXT_BACKGROUNDS.length)}
          onAnimationChange={value => {
            setStoryTextAnimation(value);
            setStoryAnimationTick(tick => tick + 1);
          }}
          onTextFontSizeChange={setStoryTextFontSize}
          onTextTransformChange={handleStoryTextTransformChange}
          onInteract={() => {
            keepStoryEditorFocus();
            window.setTimeout(keepStoryEditorFocus, 80);
          }}
          onCanvasBackgroundChange={setTextCanvasBackground}
          onSelectTool={toolKey => {
            if (toolKey === 'text') {
              openStoryTextEditor();
            } else if (toolKey === 'image') {
              openStoryStickerPicker();
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
          onDurationChange={handleStoryDurationChange}
          onSelectFilter={setStoryFilterId}
          onAdjustFilter={(key, value) => setStoryFilterAdjustments(previous => ({ ...previous, [key]: value }))}
          onResetFilters={() => {
            setStoryFilterId('original');
            setStoryFilterAdjustments(DEFAULT_FILTER_ADJUSTMENTS);
          }}
          onCloseFilters={() => setStoryFiltersOpen(false)}
          onDrawColorChange={setStoryDrawColor}
          onDrawSizeChange={setStoryDrawSize}
          onDrawToolChange={setStoryDrawingTool}
          onUndoDrawing={undoStoryDrawStroke}
          onCloseDrawing={() => {
            activeStoryDrawStrokeRef.current = null;
            redrawStoryDrawingCanvas();
            setStoryDrawingOpen(false);
          }}
          onDrawPointerDown={handleStoryDrawPointerDown}
          onDrawPointerMove={handleStoryDrawPointerMove}
          onDrawPointerUp={handleStoryDrawPointerUp}
          onCanvasTouchStart={handleStoryCanvasTouchStart}
          onCanvasTouchMove={handleStoryCanvasTouchMove}
          onCanvasTouchEnd={handleStoryCanvasTouchEnd}
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
              toast.success(`تمت الإشارة إلى ${displayName(people[0])}`);
            } else if (people.length > 1) {
              toast.success(`تمت الإشارة إلى ${people.length} أشخاص`);
            }
          }}
          onCloseCloseFriends={() => setCloseFriendsOpen(false)}
        />
      )}

      {currentStory && (
        <StoryViewer
          currentStory={currentStory}
          activeStories={activeStories}
          activeStoryIndex={activeStoryIndex}
          progress={progress}
          currentStoryFilter={currentStoryFilter}
          currentStoryFilterOverlay={currentStoryFilterOverlay}
          storyVideoRef={storyVideoRef}
          currentTimeSec={currentTimeSec}
          showUI={showUI}
          isPaused={isPaused}
          isStoryOwner={isStoryOwner}
          isArchivedStory={archiveViewerOpen}
          originalStoryAuthor={originalStoryAuthor}
          userId={userId}
          showMenu={showMenu}
          storyViewsOpen={storyViewsOpen}
          storyViewsLoading={storyViewsLoading}
          storyViewsError={storyViewsError}
          storyViewsCount={storyViewsCount}
          storyViewers={storyViewers}
          storyViewerPreview={storyViewerPreview}
          viewerActionBusyId={viewerActionBusyId}
          viewerReportTarget={viewerReportTarget}
          viewerReportCategory={viewerReportCategory}
          viewerReportDetails={viewerReportDetails}
          viewerReportBusy={viewerReportBusy}
          viewerRowMenuOpen={viewerRowMenuOpen}
          replyKeyboardInset={replyKeyboardInset}
          replyText={replyText}
          isSendingReply={isSendingReply}
          isLiked={isLiked}
          isLikeSaving={isLikeSaving}
          onMenuChange={setShowMenu}
          onReportStory={() => { void handleReportStory(); }}
          onDeleteStory={() => void handleDeleteStory()}
          onCloseViewer={() => {
            setArchiveViewerOpen(false);
            setActiveUserGroup(null);
          }}
          onNextStory={handleNextStory}
          onPreviousStory={handlePrevStory}
          onToggleShowUI={() => setShowUI(!showUI)}
          onPauseChange={setIsPaused}
          onVideoMetadata={handleStoryVideoMetadata}
          onVideoTimeUpdate={handleStoryVideoTimeUpdate}
          onVideoEnded={handleStoryVideoEnded}
          onOpenStoryViews={wasPaused => void handleOpenStoryViews(wasPaused)}
          onCloseStoryViews={handleCloseStoryViews}
          onSendReply={() => void handleSendReply()}
          onReplyTextChange={setReplyText}
          onReplyFocusChange={focused => setReplyFocused(focused)}
          onToggleLike={() => void handleToggleLike()}
          onReshareArchivedStory={() => {
            if (currentStory) openArchivedStoryForReshare(currentStory);
          }}
          onViewerRowMenuOpenChange={setViewerRowMenuOpen}
          onOpenViewerReport={handleOpenViewerReport}
          onBlockStoryViewer={viewer => void handleBlockStoryViewer(viewer)}
          onHideStoryFromViewer={viewer => void handleHideStoryFromViewer(viewer)}
          onToggleStoryViewerFollow={viewer => void handleToggleStoryViewerFollow(viewer)}
          onViewerReportSubmit={event => void handleSubmitViewerReport(event)}
          onViewerReportCancel={() => setViewerReportTarget(null)}
          onViewerReportCategoryChange={setViewerReportCategory}
          onViewerReportDetailsChange={setViewerReportDetails}
        />
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
          storyTextLayers={timedTexts}
          storyTextEditorOpen={storyTextEditorOpen}
          storyTextAnimation={storyTextAnimation}
          storyTextOffset={storyTextOffset}
          storyTextScale={storyTextScale}
          storyTextRotation={storyTextRotation}
          storyTextFontSize={storyTextFontSize}
          storyAlignmentGuides={storyAlignmentGuides}
          storyFontFamily={storyFontFamily}
          storyTextColor={storyTextColor}
          storyTextAlign={storyTextAlign}
          storyHasBackground={storyHasBackground}
          storyBackgroundPreset={storyBackgroundPreset}
          visibleStoryText={visibleStoryText}
          storyDrawingOpen={storyDrawingOpen}
          storyDrawTool={storyDrawingTool}
          storyCropOpen={storyCropOpen}
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
          storyFiltersOpen={storyFiltersOpen}
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
              toast.success(`تمت الإشارة إلى ${displayName(people[0])}`);
            } else if (people.length > 1) {
              toast.success(`تمت الإشارة إلى ${people.length} أشخاص`);
            }
          }}
          onCloseCloseFriends={() => setCloseFriendsOpen(false)}
          onClose={() => {
            setShowUploadModal(false);
            closeStoryPanels();
            setActiveStoryStickerId(null);
            setDraggingStoryStickerId(null);
            setStoryStickerOverDeleteZone(false);
            setStoryDrawingOpen(false);
            setStoryTextEditorOpen(false);
            setStoryText('');
            setStoryAlignmentGuides({ vertical: false, horizontal: false });
            setTimedTexts([]);
            setEditingStoryTextId(null);
            activeStoryDrawStrokeRef.current = null;
            if (reshareStory) {
              setReshareStory(null);
              setReshareScaledDown(false);
              setCaption('');
              setStoryText('');
            }
          }}
          onMediaClick={() => {
            const panels = storyPanelsRef.current;
            if (activeStoryStickerId || panels.filters || panels.textEditor || panels.more || panels.drawing
              || panels.duration || panels.music || panels.mentions || panels.closeFriends) {
              handleStoryCanvasTap();
              return;
            }
            if (reshareStory) {
              if (Date.now() - lastStoryTouchRef.current > 500) {
                setReshareScaledDown(current => !current);
              }
              return;
            }
            handleStoryCanvasClick();
          }}
          onCreateTextLayer={handleStoryCanvasClick}
          onEditTextLayer={openStoryTextEditor}
          onUpdateImageSticker={updateStoryImageSticker}
          onActivateImageSticker={setActiveStoryStickerId}
          draggingStoryStickerId={draggingStoryStickerId}
          storyStickerOverDeleteZone={storyStickerOverDeleteZone}
          onStoryStickerDragChange={handleStoryImageStickerDragChange}
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
              openStoryTextEditor();
            } else if (toolKey === 'image') {
              openStoryStickerPicker();
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
          onDurationChange={handleStoryDurationChange}
          onStoryTextChange={setStoryText}
          onFinishTextEditing={finishStoryTextEditing}
          onTextFontSizeChange={setStoryTextFontSize}
          onTextTransformChange={handleStoryTextTransformChange}
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
          onDrawToolChange={setStoryDrawingTool}
          onUndoDrawing={undoStoryDrawStroke}
          onCloseDrawing={() => {
            activeStoryDrawStrokeRef.current = null;
            redrawStoryDrawingCanvas();
            setStoryDrawingOpen(false);
          }}
          onCloseCrop={() => setStoryCropOpen(false)}
          onApplyCrop={transform => {
            setStoryMediaZoom(transform.zoom);
            setStoryMediaOffset(transform.offset);
            setStoryCropOpen(false);
          }}
          onQuickPublish={closeFriends => void handleQuickPublishStory(closeFriends)}
        />
      )}
        </>,
        document.body,
      )}
    </div>
  );
}


