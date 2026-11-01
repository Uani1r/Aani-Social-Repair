import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { 
  ArrowUpLeft, Bell, Bookmark, Clock, Film, Filter, Heart, Home, 
  ImagePlus, MessageCircle, MessageSquare, MoreVertical, Plus, Repeat, Search, Send, 
  Settings, Sparkles, Star, Trash2, UserRound, Video, X, SendHorizontal, Pencil,
  ThumbsUp,
  Bot, Loader2, Play, Flag, Eye, EyeOff, Volume2, VolumeX, Type, Smile, Music2, AtSign, ChevronDown,
} from 'lucide-react';

import { Toaster, toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadStoryMedia } from '@/lib/storyUpload';
import { recordShare, postShareUrl } from '@/lib/interactions';
import { displayName, formatDate, normalizeProfile, type Post, type Profile } from '@/lib/types';

import NotFound from '@/pages/not-found';
import CommentsDrawer from './components/CommentsDrawer';
import ShareSheet from './components/ShareSheet';
import StoryComposerSheet from './components/StoryComposerSheet';
import CloseFriendsSheet from './components/CloseFriendsSheet';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from './components/StoryDmCard';
import StoryFilterBar from './components/StoryFilterBar';
import StoryExpirySlider from './components/StoryExpirySlider';
import StoryMusicSheet from './components/StoryMusicSheet';
import StoryMentionPicker, { type MentionCandidate } from './components/StoryMentionPicker';
import StoryTextToolbar from './components/StoryTextToolbar';
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

// --- مكون المساعد الذكي الآمن المربوط بـ Supabase Edge Function ---
function AIAssistantModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; error?: boolean }>>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  if (!open) return null;

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || loading) return;

    const nextMessages = [...messages, { role: 'user' as const, content: userMessage }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const history = nextMessages
        .filter((m) => !m.error)
        .slice(-20)
        .map(({ role, content }) => ({ role, content }));

      const requestId = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke('gemini-chat', {
        body: { messages: history },
        headers: { 'x-request-id': requestId },
      });

      if (error) {
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          const details = (await context.clone().json().catch(() => null)) as
            | { error?: string | { message?: string } }
            | null;
          const responseError = details?.error;
          const message =
            typeof responseError === 'string'
              ? responseError
              : responseError && typeof responseError === 'object'
                ? responseError.message
                : undefined;
          if (message) throw new Error(message);
        }
        throw new Error(error.message || 'تعذر الاتصال بمركز المساعد الذكي.');
      }

      if (typeof data?.text !== 'string' || !data.text.trim()) {
        throw new Error(data?.error || 'أرجع المساعد رداً فارغاً.');
      }

      setMessages([...nextMessages, { role: 'assistant', content: data.text.trim() }]);
    } catch (err: any) {
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: err.message || 'حدث خطأ في الاتصال، حاول مرة أخرى.',
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 w-full max-w-lg h-[580px] rounded-3xl shadow-2xl flex flex-col overflow-hidden text-white" onClick={e => e.stopPropagation()}>
        <div className="p-4 bg-zinc-800/80 border-b border-zinc-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-pink-400" />
            <h3 className="font-bold text-sm">مساعد آني الذكي</h3>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 p-4 overflow-y-auto space-y-3.5 text-xs">
          {messages.length === 0 && (
            <div className="text-center py-12 space-y-2">
              <Bot className="w-10 h-10 mx-auto text-pink-500 opacity-80" />
              <p className="text-zinc-400 font-medium">مرحباً بك! أنا مساعد آني الذكي.</p>
              <p className="text-zinc-500 text-[11px]">اكتب سؤالك للبدء بالمحادثة...</p>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] p-3 rounded-2xl leading-relaxed whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-pink-600 text-white rounded-br-none'
                  : msg.error
                    ? 'bg-red-500/10 border border-red-500/30 text-red-400 rounded-bl-none'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-bl-none'
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-800 border border-zinc-700 p-3 rounded-2xl flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin text-pink-400" />
                يفكر المساعد...
              </div>
            </div>
          )}
          <div ref={endOfMessagesRef} />
        </div>

        <form onSubmit={handleSendMessage} className="p-3 bg-zinc-950/80 border-t border-zinc-800 flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اكتب أمرك للمساعد هنا..."
            disabled={loading}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-pink-500"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white p-2.5 rounded-xl transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

// --- المكونات المساعدة ---
function Avatar({ profile, large = false, storyBorder = false, isCloseFriends = false, extraLarge = false }: { profile?: Partial<Profile> | null; large?: boolean; storyBorder?: boolean; isCloseFriends?: boolean; extraLarge?: boolean }) {
  const initials = (displayName(profile).replace('@', '').trim().slice(0, 2) || 'آ').toUpperCase();
  const sizeClass = extraLarge ? 'w-16 h-16 text-lg' : large ? 'w-12 h-12 text-base' : 'w-8 h-8 text-xs';
  const borderClass = isCloseFriends 
    ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-zinc-900' 
    : storyBorder 
      ? 'ring-2 ring-pink-500 ring-offset-2 ring-offset-zinc-900' 
      : '';
  const baseClass = `rounded-full object-cover flex items-center justify-center font-bold bg-zinc-800 text-white shrink-0 ${sizeClass} ${borderClass}`;
  return profile?.avatar_url
    ? <img className={baseClass} src={profile.avatar_url} alt="" />
    : <span className={baseClass}>{initials}</span>;
}

// --- صفحة تسجيل الدخول وإنشاء الحساب ---
export function AuthPage({ mode, afterAuth }: { mode: 'login' | 'signup'; afterAuth: () => void }) {
  const signUp = mode === 'signup';
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) { setError('إعدادات Supabase غير مكتملة في Secrets.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      if (signUp) {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim().toLowerCase(), full_name: fullName.trim() } },
        });

        if (authError) throw authError;

        if (data.session) { 
          afterAuth(); 
          setLocation('/feed'); 
        } else { 
          setSuccess('تم إنشاء الحساب. افتح رسالة التفعيل التي أرسلناها إلى بريدك الإلكتروني، ثم سجّل الدخول.');
        }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
        afterAuth(); setLocation('/feed');
      }
    } catch (reason: any) {
      const message = reason?.message || '';
      if (/profiles_username_lower_idx|duplicate key|unique constraint/i.test(message)) {
        setError('اسم المستخدم مستخدم بالفعل. اختر اسمًا آخر ثم حاول مجددًا.');
      } else if (/invalid path|request url|redirect/i.test(message)) {
        setError('رابط التفعيل غير مسموح في إعدادات Supabase. أضف نطاق الموقع المنشور إلى Auth ثم URL Configuration ثم Redirect URLs.');
      } else if (/database error saving new user/i.test(message)) {
        setError('تعذر إنشاء ملف الحساب. جرّب اسم مستخدم آخر، وإذا استمر الخطأ فتحقق من تطبيق مخطط profiles ومشغّل إنشاء الحساب في Supabase.');
      } else {
        setError(message || 'حدث خطأ في الاتصال. حاول مرة أخرى.');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-scenery">
        <div className="sun-disc" />
        <div className="scenery-copy">
          <span>أهلًا بك في آني</span>
          <h2>هنا،<br />يبدأ الحديث<br /><em>ببساطة.</em></h2>
          <p>مساحة عربية للحظاتك وأحاديثك اليومية.</p>
        </div>
        <div className="scenery-lines" />
      </div>
      <section className="auth-panel">
        <Link href="/login" className="brand auth-brand">
          <span className="brand-mark">آ</span><span>آني <small>Aani</small></span>
        </Link>
        <div className="auth-form-wrap fade-up">
          <span className="eyebrow">{signUp ? 'انضم إلى آني' : 'سعدنا بعودتك'}</span>
          <h1>{signUp ? 'ابدأ مساحتك.' : 'أكمل حديثك.'}</h1>
          <p className="auth-lede">{signUp ? 'أنشئ حسابك وشارك ما يجعل يومك يومًا.' : 'سجّل الدخول لتعود إلى مجتمعك.'}</p>
          {!supabaseConfigured && <div className="notice notice-error" role="alert">أضف إعدادات Supabase للاتصال.</div>}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {success && <div className="notice notice-success" role="status">{success}</div>}
          <form className="auth-form" onSubmit={submit}>
            {signUp && (
              <>
                <label className="field">
                  <span>الاسم الكامل</span>
                  <input required maxLength={80} value={fullName} onChange={e => setFullName(e.target.value)} autoComplete="name" />
                </label>
                <label className="field">
                  <span>اسم المستخدم</span>
                  <input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" dir="ltr" placeholder="username" />
                </label>
              </>
            )}
            <label className="field">
              <span>البريد الإلكتروني</span>
              <input required type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" dir="ltr" />
            </label>
            <label className="field">
              <span>كلمة المرور</span>
              <input required type="password" minLength={6} value={password} onChange={e => setPassword(e.target.value)} autoComplete={signUp ? 'new-password' : 'current-password'} dir="ltr" />
            </label>
            <button className="button-primary auth-submit" type="submit" disabled={busy || !supabaseConfigured}>
              {busy ? 'جارٍ المتابعة…' : signUp ? 'إنشاء حساب' : 'تسجيل الدخول'}
              <ArrowUpLeft size={17} />
            </button>
          </form>
          <p className="auth-switch">
            {signUp ? 'لديك حساب؟' : 'جديد هنا؟'} <Link href={signUp ? '/login' : '/signup'}>{signUp ? 'تسجيل الدخول' : 'أنشئ حسابًا'}</Link>
          </p>
        </div>
      </section>
    </div>
  );
}

// --- شريط القصص الموحد ---
// العنصر الذي بدأ منه اللمس: يُقفل التفاعل عليه وحده حتى نهاية الإيماءة
type StoryGestureTarget = 'text' | 'image' | 'canvas';

type StoryGestureState = {
  target: StoryGestureTarget;
  touchCount: number;
  startX: number;
  startY: number;
  startDist: number;
  startAngle: number;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  moved: boolean;
  startTime: number;
};

// معاينة حيّة لحركة «الآلة الكاتبة»: تكتب النص حرفاً حرفاً بعد مؤشر وامض
function StoryTypedPreview({ text, animate }: { text: string; animate: boolean }) {
  const [count, setCount] = useState(0);
  const [done, setDone] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!animate) {
      setDone(true);
      return;
    }

    setCount(0);
    setDone(false);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setCount(index);
      if (index >= textRef.current.length) {
        window.clearInterval(timer);
        setDone(true);
      }
    }, 60);

    return () => window.clearInterval(timer);
  }, [animate]);

  if (!animate || done) return <>{text}</>;

  return (
    <>
      {text.slice(0, count)}
      <span className="aani-story-caret">|</span>
    </>
  );
}

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

  // القصص المشاهدة (يُحفظ معرّف صاحبها محليًا لتمييز لون الحلقة فقط)
  const [seenStories, setSeenStories] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('aani:seen-stories');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const markStorySeen = useCallback((authorId: string) => {    if (!authorId) return;

    setSeenStories(prev => {
      if (prev.includes(authorId)) return prev;

      const next = [...prev, authorId];
      try {
        localStorage.setItem('aani:seen-stories', JSON.stringify(next));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      return next;
    });
  }, []);

  const [showUI, setShowUI] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [currentVideoPlaybackDuration, setCurrentVideoPlaybackDuration] = useState<{ storyId: string; seconds: number } | null>(null);
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
  const [storyViewers, setStoryViewers] = useState<Array<{
    user_id: string;
    viewed_at: string;
    viewer: { id: string; username: string | null; full_name: string | null; avatar_url: string | null } | null;
  }>>([]);
  const storyViewSwipeStartRef = useRef<number | null>(null);
  const storyViewsWasPausedRef = useRef(false);
  const storyVideoRef = useRef<HTMLVideoElement | null>(null);
  const storyVideoWasPlayingRef = useRef(false);
  const storyViewsRequestRef = useRef(0);
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
  const [storyExpiryOpen, setStoryExpiryOpen] = useState(false);
  // أدوات إضافية للمحرر: إدارة قائمة الأصدقاء المقربين دون إشعارات.
  const storyExtraTools: Array<{ key: string; label: string; action: () => void }> = [
    {
      key: 'close-friends',
      label: 'الأصدقاء المقربون',
      action: () => {
        setStoryExpiryOpen(false);
        setStoryMoreOpen(false);
        setCloseFriendsOpen(true);
      },
    },
    {
      key: 'expiry',
      label: 'مدة انتهاء القصة',
      action: () => setStoryExpiryOpen(open => !open),
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
  const storyPanelsRef = useRef({ filters: false, textEditor: false, more: false });

  useEffect(() => {
    storyPanelsRef.current = {
      filters: storyFiltersOpen,
      textEditor: storyTextEditorOpen,
      more: storyMoreOpen,
    };
  }, [storyFiltersOpen, storyTextEditorOpen, storyMoreOpen]);

  // تُغلق النوافذ الفرعية وحدها دون فتح أي أداة أخرى
  const closeStoryPanels = useCallback(() => {
    setStoryFiltersOpen(false);
    setStoryTextEditorOpen(false);
    setStoryMoreOpen(false);
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

  const clampCanvas = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

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
      if (panels.filters || panels.textEditor || panels.more) {
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
        setStoryExpiryOpen(false);
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
  const [uploadDuration, setUploadDuration] = useState<number>(30);
  const [customDurationSeconds, setCustomDurationSeconds] = useState<number | null>(null);
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
    setUploadDuration(pendingReshare.media_type === 'video'
      ? Math.min(120, Math.max(1, pendingReshare.duration_seconds || 120))
      : 30);
    setCustomDurationSeconds(null);
    setStoryExpiryOpen(false);
    setShowUploadModal(true);
    onReshareHandled();
  }, [pendingReshare, onReshareHandled]);

  const editorMediaUrl = reshareStory?.media_url || previewStoryUrl;
  const editorIsVideo = reshareStory
    ? reshareStory.media_type === 'video'
    : Boolean(storyFile?.type.startsWith('video'));

  const fetchStories = useCallback(async () => {
    if (!supabaseConfigured || !userId) return;

    const now = new Date();
    const nowIso = now.toISOString();
    const within24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: followings } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', userId);

    const followedIds = (followings || []).map(f => f.following_id);
    const allowedUserIds = [userId, ...followedIds];

    const { data } = await supabase
      .from('stories')
      .select('*, author:profiles(id, username, full_name, avatar_url)')
      .in('user_id', allowedUserIds)
      .gte('created_at', within24Hours)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true });

    if (data) {
      const groups: { [key: string]: any[] } = {};
      data.forEach(st => {
        const authorId = st.user_id;
        if (!groups[authorId]) groups[authorId] = [];
        groups[authorId].push(st);
      });
      setGroupedStories(groups);
    } else {
      setGroupedStories({});
    }
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
    const now = new Date();
    void supabase
      .from('stories')
      .select('*, author:profiles(id, username, full_name, avatar_url)')
      .eq('user_id', pendingProfileStoryOwnerId)
      .gte('created_at', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .gt('expires_at', now.toISOString())
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data?.length) {
          toast.info('لا توجد قصص متاحة لهذا الحساب');
          onProfileStoryHandled();
          return;
        }

        markStorySeen(pendingProfileStoryOwnerId);
        setProfileStoryOwnerId(pendingProfileStoryOwnerId);
        setProfilePreviewStories(data);
        setActiveUserGroup(pendingProfileStoryOwnerId);
        setActiveStoryIndex(0);
        setProgress(0);
        setCurrentTimeSec(0);
        onProfileStoryHandled();
      });

    return () => {
      active = false;
    };
  }, [pendingProfileStoryOwnerId, onProfileStoryHandled]);

  const currentStory = activeStories[activeStoryIndex] || null;
  const isStoryOwner = Boolean(currentStory && currentStory.user_id === userId);
  const storyDisplayDuration = !currentStory
    ? 5
    : currentStory.media_type === 'video'
      ? currentVideoPlaybackDuration && currentVideoPlaybackDuration.storyId === currentStory.id
        ? currentVideoPlaybackDuration.seconds
        : 120
      : currentStory.media_type === 'photo'
        ? 30
        : Math.max(1, Number(currentStory.duration_seconds) || 5);
  const currentStoryFilter = decodeStoryFilterKey((currentStory as { filter_key?: string } | null)?.filter_key);
  useEffect(() => {
    const originalStoryId = (currentStory as { original_story_id?: string } | null)?.original_story_id;
    if (!originalStoryId || !supabaseConfigured) {
      setOriginalStoryAuthor(null);
      return;
    }

    let active = true;
    setOriginalStoryAuthor(null);
    void supabase
      .from('stories')
      .select('author:profiles(id, username, full_name, avatar_url)')
      .eq('id', originalStoryId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setOriginalStoryAuthor((data?.author as StoryDmCardStory['author']) ?? null);
      });

    return () => {
      active = false;
    };
  }, [currentStory]);
  const currentStoryFilterOverlay = getStoryFilterOverlay(currentStoryFilter.id);
  const myStories = groupedStories[userId] || [];
  const hasMyStory = myStories.length > 0;
  const myStoryHasCloseFriends = myStories.some(story => story.is_close_friends);

  useEffect(() => {
    setReplyText('');
    setReplyFocused(false);
    setReplyKeyboardInset(0);
    setStoryViewsOpen(false);
    setStoryViewsLoading(false);
    setStoryViewsError(false);
    setStoryViewsCount(0);
    setStoryViewers([]);
    setIsPaused(false);
    storyViewsWasPausedRef.current = false;
    storyViewsRequestRef.current += 1;
  }, [currentStory?.id]);

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
      .from('story_views')
      .upsert(
        { story_id: currentStory.id, user_id: userId },
        { onConflict: 'story_id,user_id', ignoreDuplicates: true },
      )
      .then(({ error }) => {
        if (active && error) {
          console.error('[story views] تعذر تسجيل المشاهدة:', error);
          toast.error('تعذر تسجيل مشاهدة الستوري. تأكد من تطبيق ترحيل سجل المشاهدات.');
        }
      })
      .catch(error => {
        if (active) {
          console.error('[story views] تعذر تسجيل المشاهدة:', error);
          toast.error('تعذر تسجيل مشاهدة الستوري. تحقق من الاتصال وحاول مجدداً.');
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

  const handleOpenStoryViews = async () => {
    if (!currentStory || !isStoryOwner || !supabaseConfigured) return;

    const storyId = currentStory.id;
    const requestId = ++storyViewsRequestRef.current;
    storyViewsWasPausedRef.current = isPaused;
    storyVideoWasPlayingRef.current = Boolean(storyVideoRef.current && !storyVideoRef.current.paused);
    storyVideoRef.current?.pause();
    setIsPaused(true);
    setStoryViewsOpen(true);
    setStoryViewsLoading(true);
    setStoryViewsError(false);

    try {
      const { data, count, error } = await supabase
        .from('story_views')
        .select('user_id, viewed_at, viewer:profiles(id, username, full_name, avatar_url)', { count: 'exact' })
        .eq('story_id', storyId)
        .order('viewed_at', { ascending: false });
      if (error) throw error;
      if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;

      setStoryViewers((data || []) as typeof storyViewers);
      setStoryViewsCount(count ?? data?.length ?? 0);
    } catch (error) {
      if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;
      console.error('[story views] تعذر تحميل قائمة المشاهدين:', error);
      setStoryViewsError(true);
      setStoryViewers([]);
      setStoryViewsCount(0);
      toast.error('تعذر تحميل قائمة المشاهدات. تأكد من تطبيق ترحيل سجل المشاهدات.');
    } finally {
      if (requestId === storyViewsRequestRef.current) setStoryViewsLoading(false);
    }
  };

  const handleCloseStoryViews = () => {
    setStoryViewsOpen(false);
    setIsPaused(storyViewsWasPausedRef.current);
    if (storyVideoWasPlayingRef.current) {
      void storyVideoRef.current?.play().catch(error => {
        console.warn('[story viewer] تعذرت متابعة تشغيل الفيديو بعد إغلاق المشاهدات:', error);
      });
    }
    storyVideoWasPlayingRef.current = false;
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

  const handleUploadStory = async () => {
    if (!supabaseConfigured) return;
    if (!storyFile && !caption.trim()) return;

    setUploading(true);
    try {
      let publicUrl = '';
      let mediaType = 'text';

      if (storyFile) {
        const safeName = storyFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const filePath = `${userId}/story-${Date.now()}-${safeName}`;
        const { error: uploadErr } = await supabase.storage.from(storageBucket).upload(filePath, storyFile, { contentType: storyFile.type, upsert: true });
        if (uploadErr) throw uploadErr;
        publicUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
        mediaType = storyFile.type.startsWith('video') ? 'video' : 'photo';
      }

      const { error: insertError } = await supabase.from('stories').insert({
        user_id: userId,
        media_url: publicUrl || null,
        media_type: mediaType,
        caption: caption.trim() || null,
        is_close_friends: isCloseFriendsOnly,
        duration_seconds: uploadDuration,
        timed_texts: timedTexts
      });
      if (insertError) throw insertError;

      setStoryFile(null);
      setCaption('');
      setTimedTexts([]);
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
    const sourceStory = reshareStory;
    const storyCaption = caption.trim();
    const mentions = [...storyMentions];
    const durationSeconds = uploadDuration;
    const expirySeconds = customDurationSeconds;
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
          p_timed_texts: [],
          p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
          p_original_story_id: sourceStory?.id || null,
          p_share_type: sourceStory ? 'reshare' : 'original',
          p_expiry_seconds: expirySeconds,
        });

        if (insertError) throw insertError;
        if (typeof storyId === 'string' && mentions.length > 0) {
          void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', mentions);
        }

        setStoryFile(current => current === mediaFile ? null : current);
        setReshareStory(current => current?.id === sourceStory?.id ? null : current);
        setCaption(current => current.trim() === storyCaption ? '' : current);
        setStoryText('');
        setTimedTexts([]);
        setStoryMentions([]);
        setReshareScaledDown(false);
        setCustomDurationSeconds(null);
        setStoryExpiryOpen(false);
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
      const { error } = await supabase.from('stories').insert({
        user_id: userId,
        media_url: null,
        media_type: 'text',
        caption: text.trim(),
        is_close_friends: false,
        duration_seconds: 5,
        timed_texts: [],
      });

      if (error) throw error;

      await fetchStories();
      toast.success('نُشرت قصتك');
    } catch {
      toast.error('تعذر نشر القصة، حاول مرة أخرى');
    }
  };

  return (
    <div className="story-bar mb-4 w-full" dir="rtl">
      <div className="flex items-center gap-[18px] overflow-x-auto no-scrollbar px-1 pb-2 pt-1">
        {/* قصتك */}
        <div className="flex flex-col items-center gap-1.5 shrink-0">
          <div
            className={`relative flex h-16 w-16 cursor-pointer items-center justify-center rounded-full ${hasMyStory ? 'p-[2.5px]' : 'border-[1.5px] border-dashed border-zinc-600/70 p-[2px]'}`}
            style={hasMyStory ? {
              background: myStoryHasCloseFriends
                ? 'conic-gradient(from 0deg, #16a34a, #4ade80, #15803d, #16a34a)'
                : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
            } : undefined}
            onClick={() => {
              if (uploading) return;
              if (hasMyStory) {
                markStorySeen(userId);
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
          const isSeen = seenStories.includes(authorId);
          const hasCloseFriendsStory = groupedStories[authorId].some(story => story.is_close_friends);

          return (
            <div
              key={authorId}
              className="flex flex-col items-center gap-1.5 cursor-pointer shrink-0"
              onClick={() => {
                markStorySeen(authorId);
                setActiveUserGroup(authorId);
                setActiveStoryIndex(0);
                setProgress(0);
                setCurrentTimeSec(0);
              }}
            >
              <span
                className="flex h-16 w-16 items-center justify-center rounded-full p-[2.5px] transition-colors duration-200"
                style={{
                  background: hasCloseFriendsStory
                    ? 'conic-gradient(from 0deg, #16a34a, #4ade80, #15803d, #16a34a)'
                    : isSeen
                      ? '#3a3a42'
                      : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
                }}
              >
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-[#121212] bg-zinc-900">
                  <Avatar profile={firstStory.author} extraLarge />
                </span>
              </span>
              <span className="text-[11.5px] text-zinc-400 truncate w-16 text-center">
                {firstStory.author?.username || 'عضو'}
              </span>
            </div>
          );
        })}
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
          setReshareStory(null);
          setReshareScaledDown(false);
          setUploadDuration(files[0].type.startsWith('video') ? 120 : 30);
          setCustomDurationSeconds(null);
          setStoryExpiryOpen(false);
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
                  <Link href={`/profile/${currentStory.user_id}`} className="flex items-center gap-2">
                    <Avatar profile={currentStory.author} storyBorder={false} />
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="font-bold text-xs">{displayName(currentStory.author)}</span>
                        {currentStory.is_close_friends && (
                          <span className="bg-emerald-500 text-[9px] px-1.5 py-0.2 rounded-md font-semibold">أصدقاء مقربون</span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-300 block">{formatDate(currentStory.created_at)}</span>
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
                  <button onClick={() => setShowMenu(!showMenu)} className="p-1 hover:bg-white/20 rounded-full">
                    <MoreVertical size={18} />
                  </button>
                  <button onClick={() => setActiveUserGroup(null)} className="p-1 hover:bg-white/20 rounded-full">
                    <X size={20} />
                  </button>
                </div>
              </div>
            )}

            {showMenu && (
              <div className="absolute top-14 left-3 z-40 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl text-xs space-y-1">
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
                    onLoadedMetadata={event => {
                      const duration = Number(event.currentTarget.duration);
                      if (!Number.isFinite(duration) || duration <= 0) return;
                      setCurrentVideoPlaybackDuration({
                        storyId: currentStory.id,
                        seconds: Math.min(120, Math.max(1, Math.ceil(duration))),
                      });
                      setProgress(0);
                      setCurrentTimeSec(0);
                    }}
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

              {(currentStory.timed_texts || []).map((tt: any) => {
                if (currentTimeSec >= tt.startTime && currentTimeSec <= tt.endTime) {
                  return (
                    <div 
                      key={tt.id}
                      style={{ top: `${tt.y}%`, left: `${tt.x}%`, transform: 'translate(-50%, -50%)' }}
                      className="absolute bg-black/70 text-white font-bold px-3 py-1.5 rounded-xl text-xs border border-white/20 backdrop-blur-sm z-20"
                    >
                      {tt.text}
                    </div>
                  );
                }
                return null;
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
                className="absolute inset-x-0 bottom-0 z-[25] h-24 touch-none"
                aria-hidden="true"
                onTouchStart={event => {
                  storyViewSwipeStartRef.current = event.touches[0]?.clientY ?? null;
                }}
                onTouchEnd={event => {
                  const startY = storyViewSwipeStartRef.current;
                  const endY = event.changedTouches[0]?.clientY;
                  storyViewSwipeStartRef.current = null;
                  if (startY !== null && endY !== undefined && startY - endY > 48) {
                    void handleOpenStoryViews();
                  }
                }}
                onTouchCancel={() => {
                  storyViewSwipeStartRef.current = null;
                }}
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

                <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-zinc-700/70 bg-zinc-900/90 px-1.5 py-1">
                  {['😲', '😂', '😍'].map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      disabled={isSendingReply}
                      onClick={() => void handleSendReply(emoji)}
                      aria-label={`إرسال ${emoji}`}
                      className="text-sm transition hover:scale-125 disabled:opacity-50"
                    >
                      {emoji}
                    </button>
                  ))}
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
                  onClick={handleCloseStoryViews}
                />
                <section
                  className="absolute inset-x-0 bottom-0 z-[70] flex max-h-[70dvh] flex-col overflow-hidden rounded-t-3xl border-t border-white/10 bg-zinc-950/95 px-4 pt-2 shadow-2xl backdrop-blur-xl"
                  style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
                  role="dialog"
                  aria-modal="true"
                  aria-label="مشاهدات الستوري"
                  onClick={event => event.stopPropagation()}
                >
                  <div className="mx-auto mb-3 mt-1 h-1 w-10 rounded-full bg-white/30" />
                  <div className="mb-3 flex items-center justify-between">
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
                    {storyViewsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-400">
                        <Loader2 size={16} className="animate-spin" /> جارٍ تحميل المشاهدات...
                      </div>
                    ) : storyViewsError ? (
                      <p className="py-8 text-center text-xs text-red-300">تعذر تحميل المشاهدات. تحقق من إعداد قاعدة البيانات والاتصال.</p>
                    ) : storyViewers.length === 0 ? (
                      <p className="py-8 text-center text-xs text-zinc-400">لا توجد مشاهدات مسجلة بعد.</p>
                    ) : (
                      <ul className="space-y-2">
                        {storyViewers.map(item => (
                          <li key={`${currentStory.id}:${item.user_id}`} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                            <Avatar profile={item.viewer} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold text-white">
                                {item.viewer?.full_name || item.viewer?.username || 'مستخدم'}
                              </p>
                              <p className="truncate text-[10px] text-zinc-400" dir="ltr">
                                {item.viewer?.username ? `@${item.viewer.username}` : 'اسم المستخدم غير متاح'}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {showUploadModal && (
        <div className="aani-page-enter fixed inset-0 z-[130] overflow-hidden bg-black text-white" dir="rtl">
          {/* الوسيط يملأ الشاشة بالكامل، والنص داخل لوحة تُسحب وتُكبَّر كوحدة واحدة */}
          {editorMediaUrl ? (
            <div
              className="absolute inset-0 flex items-center justify-center"
              onTouchStart={handleStoryCanvasTouchStart}
              onTouchMove={handleStoryCanvasTouchMove}
              onTouchEnd={handleStoryCanvasTouchEnd}
              onTouchCancel={handleStoryCanvasTouchEnd}
              style={{ touchAction: 'none' }}
            >
              <div
                className={reshareStory
                  ? 'relative overflow-hidden rounded-[28px] transition-[width,height,border-radius] duration-300'
                  : 'absolute inset-0'}
                onClick={() => {
                  if (reshareStory && Date.now() - lastStoryTouchRef.current > 500) {
                    setReshareScaledDown(current => !current);
                  }
                }}
                style={reshareStory ? {
                  width: reshareScaledDown ? 'min(78vw, 360px)' : '100vw',
                  height: reshareScaledDown ? '76vh' : '100dvh',
                  transform: `translate3d(${storyCanvasOffset.x}px, ${storyCanvasOffset.y}px, 0) scale(${storyCanvasScale})`,
                } : {
                  transform: `translate3d(${storyCanvasOffset.x}px, ${storyCanvasOffset.y}px, 0) scale(${storyCanvasScale})`,
                }}
              >
                {/* الصورة: تُقفل الإيماءة عليها إذا بدأ اللمس منها */}
                {editorIsVideo ? (
                  <video
                    src={editorMediaUrl}
                    autoPlay
                    loop
                    playsInline
                    onLoadedMetadata={event => {
                      const duration = Number(event.currentTarget.duration);
                      if (Number.isFinite(duration) && duration > 0) {
                        setUploadDuration(Math.min(120, Math.max(1, Math.ceil(duration))));
                      }
                    }}
                    data-story-media="true"
                    className="h-full w-full object-cover"
                    style={{
                      touchAction: 'none',
                      filter: storyFilterValue,
                      transform: `translate(${storyMediaOffset.x}px, ${storyMediaOffset.y}px) scale(${storyMediaZoom}) rotate(${storyMediaRotate}deg)`,
                    }}
                  />
                ) : (
                  <img
                    src={editorMediaUrl}
                    alt=""
                    data-story-media="true"
                    className="h-full w-full object-cover"
                    style={{
                      touchAction: 'none',
                      filter: storyFilterValue,
                      transform: `translate(${storyMediaOffset.x}px, ${storyMediaOffset.y}px) scale(${storyMediaZoom}) rotate(${storyMediaRotate}deg)`,
                    }}
                  />
                )}

                {/* طبقة لون الفلتر */}
                {storyFilterOverlay && (
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background: storyFilterOverlay.color,
                      opacity: storyFilterOverlay.opacity,
                      mixBlendMode: storyFilterOverlay.blend as never,
                    }}
                  />
                )}

                {/* طبقة تعتيم متدرجة لإبراز الأدوات فوق الصورة */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.78) 100%)',
                  }}
                />

                {/* النص: نقرة للتحرير، سحب بإصبع للتحريك، إصبعان للتكبير والتدوير */}
                {storyText.trim() && !storyTextEditorOpen && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6" dir="rtl">
                    <div
                      key={`${storyTextAnimation}-${storyText}`}
                      className={storyTextAnimation === 'none' ? undefined : `aani-story-anim-${storyTextAnimation}`}
                    >
                      <p
                        data-story-text="true"
                        className="max-w-full cursor-grab whitespace-pre-wrap break-words font-bold active:cursor-grabbing"
                        style={{
                          pointerEvents: 'auto',
                          touchAction: 'none',
                          transform: `translate(${storyTextOffset.x}px, ${storyTextOffset.y}px) scale(${storyTextScale}) rotate(${storyTextRotation}deg)`,
                          fontFamily: storyFontFamily,
                          color: storyTextColor,
                          fontSize: 30,
                          textAlign: storyTextAlign,
                          lineHeight: 1.35,
                          display: storyHasBackground ? 'inline-block' : undefined,
                          width: storyHasBackground ? 'fit-content' : undefined,
                          padding: storyHasBackground ? '2px 10px' : undefined,
                          borderRadius: storyHasBackground ? 8 : undefined,
                          background: storyHasBackground ? storyBackgroundPreset.background : 'transparent',
                          textShadow: '0 2px 14px rgba(0,0,0,0.9)',
                        }}
                      >
                        {visibleStoryText}
                        {storyTextAnimation === 'typewriter' && visibleStoryText.length < storyText.length && (
                          <span className="aani-story-caret">|</span>
                        )}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-400">
              اختر وسيطاً من الاستوديو لعرضه هنا
            </div>
          )}

          {/* الشريط العلوي */}
          <div
            className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3"
            style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
          >
            <button
              type="button"
              onClick={() => {
                setShowUploadModal(false);
                if (reshareStory) {
                  setReshareStory(null);
                  setReshareScaledDown(false);
                  setCaption('');
                  setStoryText('');
                }
              }}
              aria-label="إغلاق"
              className="rounded-full p-1.5 text-white/90 transition hover:bg-white/10"
            >
              <X size={24} />
            </button>
            {reshareStory ? (
              <div className="flex min-w-0 flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 text-white">
                  <Avatar profile={currentProfile} />
                  <span className="max-w-[42vw] truncate text-[11px] font-bold">{displayName(currentProfile)}</span>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-white/85 backdrop-blur-sm">
                  {reshareStory.author?.avatar_url ? (
                    <img src={reshareStory.author.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[7px] font-bold">
                      {displayName(reshareStory.author).replace('@', '').charAt(0)}
                    </span>
                  )}
                  <span className="max-w-[48vw] truncate text-[9px]">
                    من قصة {displayName(reshareStory.author)}
                  </span>
                </div>
              </div>
            ) : (
              <span className="text-[13px] font-semibold text-white/85">معاينة القصة</span>
            )}
            <span className="w-9" />
          </div>

          {/* أدوات التحرير: عمود واحد على الجانب الأيمن فقط (أيقونات فقط) */}
          <div
            ref={storyToolsRef}
            className="absolute right-2.5 z-20 flex flex-col items-center gap-2.5"
            style={{ top: 'calc(3.75rem + env(safe-area-inset-top))' }}
          >
            {[
              { key: 'text', icon: Type, label: 'نص' },
              { key: 'music', icon: Music2, label: 'موسيقى' },
              { key: 'effects', icon: Sparkles, label: 'فلاتر' },
              { key: 'mention', icon: AtSign, label: 'إشارة' },
              { key: 'draw', icon: Pencil, label: 'رسم' },
            ].map(tool => {
              const Icon = tool.icon;

              return (
                <button
                  key={tool.key}
                  type="button"
                  title={tool.label}
                  aria-label={tool.label}
                  onClick={() => {
                    if (tool.key === 'text') {
                      setStoryFiltersOpen(false);
                      setStoryTextEditorOpen(true);
                    } else if (tool.key === 'mention') {
                      setStoryTextEditorOpen(false);
                      setStoryFiltersOpen(false);
                      setStoryMentionsOpen(true);
                    } else if (tool.key === 'music') {
                      setStoryTextEditorOpen(false);
                      setStoryMusicOpen(true);
                    } else if (tool.key === 'effects') {
                      setStoryTextEditorOpen(false);
                      setStoryFiltersOpen(open => !open);
                    } else {
                      toast.info('أداة الرسم ستُضاف قريبًا');
                    }
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
                >
                  <Icon size={17} />
                </button>
              );
            })}

            {/* الزر السابع: قائمة أدوات إضافية قابلة للتوسعة */}
            <div className="relative">
              <button
                type="button"
                aria-label="أدوات إضافية"
                aria-expanded={storyMoreOpen}
                onClick={() => {
                  const nextOpen = !storyMoreOpen;
                  setStoryMoreOpen(nextOpen);
                  if (!nextOpen) setStoryExpiryOpen(false);
                }}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white backdrop-blur-md transition active:scale-95"
              >
                <ChevronDown
                  size={17}
                  className={`transition-transform duration-200 ${storyMoreOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {storyMoreOpen && (
                <div
                  className="absolute right-full top-0 z-30 mr-2 w-48 max-w-[calc(100vw_-_4rem)] overflow-hidden rounded-xl border border-white/10 bg-[#101014]/95 p-1 shadow-2xl backdrop-blur-md"
                  dir="rtl"
                  role="menu"
                >
                  {storyExtraTools.length === 0 ? (
                    <p className="px-3 py-2 text-[10px] leading-4 text-zinc-500">
                      ستظهر الأدوات الإضافية هنا عند إضافتها لاحقًا
                    </p>
                  ) : (
                    storyExtraTools.map(item => {
                      const Icon = item.key === 'close-friends' ? Star : Clock;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          role="menuitem"
                          aria-label={item.label}
                          title={item.label}
                          onClick={() => {
                            if (item.key === 'expiry') {
                              item.action();
                              return;
                            }
                            item.action();
                          }}
                          className={`flex h-9 w-full items-center justify-start gap-2 rounded-lg px-3 text-[11px] transition hover:bg-white/10 ${item.key === 'close-friends' ? 'text-emerald-400' : 'text-white/80'}`}
                        >
                          <Icon size={16} fill={item.key === 'close-friends' ? 'currentColor' : 'none'} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })
                  )}
                  {storyExpiryOpen && (
                    <StoryExpirySlider
                      durationSeconds={customDurationSeconds}
                      onChange={setCustomDurationSeconds}
                    />
                  )}
                </div>
              )}
            </div>

          </div>


          {/* محرر النص الغني (خلفية شبه شفافة تُظهر القصة) */}
          {storyTextEditorOpen && (
            <div className="absolute inset-0 z-40 flex flex-col bg-black/70 backdrop-blur-sm" dir="rtl">
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
              >
                <span className="text-[12px] text-white/60">محرر النص</span>
                <button
                  type="button"
                  onClick={() => {
                    setCaption(storyText.trim());
                    setStoryTextEditorOpen(false);
                  }}
                  className="rounded-full bg-white px-4 py-1.5 text-[12px] font-bold text-[#121212]"
                >
                  تم
                </button>
              </div>

              <div className="flex min-h-[96px] flex-1 items-start justify-center px-6 pt-2">
                <div className="relative flex w-full max-w-md items-start justify-center">
                  {/* معاينة حيّة للنص بنفس خط/لون/خلفية/حركة القصة */}
                  {storyEditorPreviewMode && (
                    <p
                      key={`${storyTextAnimation}-${storyAnimationTick}`}
                      aria-hidden="true"
                      className={storyPreviewClassName}
                      style={{
                        fontFamily: storyFontFamily,
                        color: storyTextColor,
                        fontSize: 30,
                        textAlign: storyTextAlign,
                        lineHeight: 1.35,
                        padding: storyHasBackground ? '2px 10px' : undefined,
                        borderRadius: storyHasBackground ? 8 : undefined,
                        background: storyHasBackground ? storyBackgroundPreset.background : 'transparent',
                        textShadow: '0 2px 12px rgba(0,0,0,0.9)',
                      }}
                    >
                      <StoryTypedPreview
                        key={storyAnimationTick}
                        text={storyText}
                        animate={storyTextAnimation === 'typewriter'}
                      />
                    </p>
                  )}

                  <textarea
                    ref={storyTextAreaRef}
                    autoFocus
                    value={storyText}
                    onChange={event => setStoryText(event.target.value)}
                    placeholder="اكتب شيئاً..."
                    dir="rtl"
                    rows={3}
                    className="relative w-full max-w-md resize-none overflow-hidden bg-transparent font-bold outline-none placeholder:text-white/40"
                    style={{
                      fontFamily: storyFontFamily,
                      color: storyEditorPreviewMode ? 'transparent' : storyTextColor,
                      caretColor: storyTextColor,
                      WebkitTextFillColor: storyEditorPreviewMode ? 'transparent' : storyTextColor,
                      fontSize: 30,
                      textAlign: storyTextAlign,
                      lineHeight: 1.35,
                      padding: 0,
                      background: 'transparent',
                      textShadow: storyEditorPreviewMode ? 'none' : '0 2px 12px rgba(0,0,0,0.9)',
                    }}
                  />
                </div>
              </div>

              {/* شريط أدوات النص بنمط إنستغرام: الخيارات تنبثق فوقه مباشرة */}
              <div
                className="px-3"
                style={{ paddingBottom: `calc(0.8rem + env(safe-area-inset-bottom) + ${storyKeyboardInset}px)` }}
              >
                <StoryTextToolbar
                  fontFamily={storyFontFamily}
                  onFontFamilyChange={setStoryFontFamily}
                  textColor={storyTextColor}
                  onTextColorChange={setStoryTextColor}
                  align={storyTextAlign}
                  onCycleAlign={() => setStoryTextAlign(prev => nextStoryTextAlign(prev))}
                  backgroundLabel={storyBackgroundPreset.label}
                  backgroundSwatch={storyBackgroundPreset.background}
                  onCycleBackground={() =>
                    setStoryBackgroundIndex(prev => (prev + 1) % STORY_TEXT_BACKGROUNDS.length)
                  }
                  animation={storyTextAnimation}
                  onAnimationChange={value => {
                    setStoryTextAnimation(value);
                    setStoryAnimationTick(tick => tick + 1);
                  }}
                  onInteract={() => {
                    keepStoryEditorFocus();
                    // شبكة أمان لبعض المتصفحات التي تُزيل التركيز بعد لمسة قصيرة
                    window.setTimeout(keepStoryEditorFocus, 80);
                  }}
                />
              </div>
            </div>
          )}

          {/* أسفل الشاشة: قصتك (يمين) + الأصدقاء المقربون (يسار) */}
          <div
            className="absolute inset-x-0 bottom-0 z-20 px-4 pt-2"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
          >
            {storyFiltersOpen && (
              <StoryFilterBar
                previewUrl={editorMediaUrl}
                isVideo={editorIsVideo}
                activeId={storyFilterId}
                onSelect={setStoryFilterId}
                adjustments={storyFilterAdjustments}
                onAdjust={(key, value) => setStoryFilterAdjustments(prev => ({ ...prev, [key]: value }))}
                onReset={() => {
                  setStoryFilterId('original');
                  setStoryFilterAdjustments(DEFAULT_FILTER_ADJUSTMENTS);
                }}
                onClose={() => setStoryFiltersOpen(false)}
              />
            )}
            {storyMusicTrack && (
              <div className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[10px] text-white backdrop-blur-sm">
                <Music2 size={12} />
                <span className="max-w-[55vw] truncate">{storyMusicTrack.title}</span>
              </div>
            )}
            <div className="flex items-stretch gap-2.5">
              <button
                type="button"
                onClick={() => void handleQuickPublishStory(false)}
                disabled={uploading || (!storyFile && !reshareStory?.media_url)}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-white px-3 text-[12px] font-bold text-[#121212] shadow-lg transition hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40"
              >
                {currentProfile?.avatar_url ? (
                  <img src={currentProfile.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-white">
                    {displayName(currentProfile).replace('@', '').charAt(0)}
                  </span>
                )}
                {uploading ? 'جارٍ النشر...' : 'قصتك'}
              </button>
              <button
                type="button"
                onClick={() => void handleQuickPublishStory(true)}
                disabled={uploading || (!storyFile && !reshareStory?.media_url)}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/60 bg-black/40 px-3 text-[12px] font-bold text-white backdrop-blur-sm transition hover:bg-black/60 active:scale-[0.98] disabled:opacity-40"
              >
                <Star size={15} style={{ color: '#4CAF50' }} fill="#4CAF50" />
                الأصدقاء المقربون
              </button>
            </div>
          </div>

          {/* الموسيقى: نافذة «قادمة قريباً» أو واجهة الاختيار عند تفعيل المزوّد */}
          <StoryMusicSheet
            open={storyMusicOpen}
            onClose={() => setStoryMusicOpen(false)}
            onSelect={track => {
              setStoryMusicTrack({ id: track.id, title: track.title, artist: track.artist });
              setStoryMusicOpen(false);
              toast.success(`تم اختيار: ${track.title}`);
            }}
          />

          {/* الإشارة إلى أشخاص: تُخزَّن مع القصة دون ظهور أسمائهم على الصورة */}
          <StoryMentionPicker
            open={storyMentionsOpen}
            currentUserId={userId}
            onClose={() => setStoryMentionsOpen(false)}
            onConfirm={people => {
              setStoryMentions(people);
              setStoryMentionsOpen(false);
              if (people.length === 1) {
                toast.success(`تمت الإشارة إلى @${people[0].username}`);
              } else if (people.length > 1) {
                toast.success(`تمت الإشارة إلى ${people.length} أشخاص`);
              }
            }}
          />
          <CloseFriendsSheet
            open={closeFriendsOpen}
            currentUserId={userId}
            onClose={() => setCloseFriendsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

// --- كارت المنشور العصري بنمط (X / Twitter Carousel + Optimistic UI) ---
function PostCard({ post, currentUserId, onRefresh, onOpenComments }: { post: Post; currentUserId: string; onRefresh: () => void; onOpenComments?: (postId: string) => void }) {
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentsCount, setCommentsCount] = useState(post.comments_count || 0);
  const [repostsCount, setRepostsCount] = useState(post.reposts_count || 0);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editContent, setEditContent] = useState(post.content || '');
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const likeBusyRef = useRef(false);
  const repostBusyRef = useRef(false);

  // Optimistic UI states
  const [liked, setLiked] = useState(post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId));
  const [likesCount, setLikesCount] = useState(post.likes_count ?? post.likes?.length ?? 0);
  const [reposted, setReposted] = useState(post.reposted_by_me ?? false);
  const [bookmarked, setBookmarked] = useState(post.saved_by_me ?? false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  const urls = useMemo(() => {
    if (post.media_urls && post.media_urls.length > 0) return post.media_urls;
    if (post.media_url) return [post.media_url];
    return [];
  }, [post.media_urls, post.media_url]);

  // مزامنة أعلام التفاعل فقط عند تغيّرها فعليًا (وليس مع كل تحديث للعدّادات)
  useEffect(() => {
    setLiked(post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId));
    setReposted(post.reposted_by_me ?? false);
    setBookmarked(post.saved_by_me ?? false);
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.liked_by_me, post.reposted_by_me, post.saved_by_me, post.feedback_by_me, currentUserId]);

  // العدّادات من قاعدة البيانات، مع عدم إرباك ضغطة المستخدم أثناء تنفيذ الطلب
  useEffect(() => {
    if (!likeBusyRef.current) {
      setLikesCount(post.likes_count ?? post.likes?.length ?? 0);
    }
    if (!repostBusyRef.current) {
      setRepostsCount(post.reposts_count || 0);
    }
    setCommentsCount(post.comments_count || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.likes_count, post.reposts_count, post.comments_count]);

  // عدّاد التعليقات: تحديث فوري من نافذة التعليقات (Optimistic UI) دون إعادة تحميل
  useEffect(() => {
    const onCommentCount = (event: Event) => {
      const detail = (event as CustomEvent<{ postId?: string; count?: number }>).detail;
      if (!detail?.postId || detail.postId !== post.id) return;
      const next = Number(detail.count);
      if (Number.isFinite(next)) setCommentsCount(Math.max(0, next));
    };

    window.addEventListener('aani:comment-count', onCommentCount as EventListener);
    return () => window.removeEventListener('aani:comment-count', onCommentCount as EventListener);
  }, [post.id]);

  const handleScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(Math.abs(el.scrollLeft) / el.clientWidth);
    setCurrentImageIndex(Math.min(idx, urls.length - 1));
  }, [urls.length]);

  const goToImage = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: -i * el.clientWidth, behavior: 'smooth' });
  };

  const toggleLike = async () => {
    // حماية من الضغطات السريعة المتتالية (تمنع القفز من 0 إلى 3)
    if (likeBusyRef.current) return;

    const prevLiked = liked;
    const prevCount = likesCount;
    const nextLiked = !prevLiked;

    likeBusyRef.current = true;
    setLiked(nextLiked);
    setLikesCount(Math.max(0, prevCount + (nextLiked ? 1 : -1)));
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 450);

    if (!supabaseConfigured) {
      setLiked(prevLiked);
      setLikesCount(prevCount);
      likeBusyRef.current = false;
      return;
    }

    try {
      if (prevLiked) {
        const { error } = await supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        // لا يوجد صف إعجاب = الحالة المطلوبة أصلًا
        if (error && error.code !== 'PGRST116') throw error;
      } else {
        const { error } = await supabase.from('likes').insert({ post_id: post.id, user_id: currentUserId });
        // إعجاب مسجّل مسبقًا = الحالة المطلوبة أصلًا (لا تراجع عن الواجهة)
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    } finally {
      likeBusyRef.current = false;
    }
  };

  const toggleRepost = async () => {
    if (repostBusyRef.current) return;

    const prevReposted = reposted;
    const prevCount = repostsCount;
    const nextReposted = !prevReposted;

    repostBusyRef.current = true;
    setReposted(nextReposted);
    setRepostsCount(Math.max(0, prevCount + (nextReposted ? 1 : -1)));

    if (!supabaseConfigured) {
      setReposted(prevReposted);
      setRepostsCount(prevCount);
      repostBusyRef.current = false;
      return;
    }

    try {
      if (prevReposted) {
        const { error } = await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        if (error && error.code !== 'PGRST116') throw error;
      } else {
        const { error } = await supabase.from('reposts').insert({ post_id: post.id, user_id: currentUserId });
        // إعادة نشر مسجّلة مسبقًا = الحالة المطلوبة أصلًا
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      setReposted(prevReposted);
      setRepostsCount(prevCount);
    } finally {
      repostBusyRef.current = false;
    }
  };

  const toggleBookmark = async () => {
    const prevBookmarked = bookmarked;
    setBookmarked(!prevBookmarked);

    if (!supabaseConfigured) {
      setBookmarked(prevBookmarked);
      return;
    }
    try {
      if (prevBookmarked) {
        const { error } = await supabase.from('bookmarks').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('bookmarks').insert({ post_id: post.id, user_id: currentUserId });
        if (error) throw error;
      }
    } catch {
      setBookmarked(prevBookmarked);
    }
  };

  const loadComments = async () => {
    if (onOpenComments) {
      onOpenComments(post.id);
      return;
    }
    if (!supabaseConfigured) return;
    setBusy(true);
    const { data } = await supabase.from('comments').select('id,post_id,user_id,content,created_at,author:profiles(id,username,full_name,avatar_url)').eq('post_id', post.id).order('created_at', { ascending: true });
    setComments(data || []);
    setBusy(false);
  };

  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    const value = commentText.trim();
    if (!supabaseConfigured || !value || busy) return;

    // تحديث العداد فورًا (Optimistic UI) قبل انتظار الشبكة
    const previousCount = commentsCount;
    setCommentText('');
    setCommentsCount(previousCount + 1);

    setBusy(true);
    try {
      const { error } = await supabase.from('comments').insert({
        post_id: post.id,
        user_id: currentUserId,
        content: value,
      });
      if (error) throw error;
      await loadComments();
    } catch {
      setCommentsCount(previousCount);
      setCommentText(value);
      alert('تعذر نشر التعليق. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabaseConfigured || busy) return;
    const content = editContent.trim();
    if (post.type === 'text' && !content) {
      alert('لا يمكن أن يكون المنشور النصي فارغًا.');
      return;
    }

    setBusy(true);
    try {
      let mediaUrl = post.media_url;
      let mediaUrls = post.media_urls?.length ? post.media_urls : (post.media_url ? [post.media_url] : []);
      if (replacementFile) {
        const expectedType = post.type === 'photo' ? 'image/' : 'video/';
        if (!replacementFile.type.startsWith(expectedType)) {
          throw new Error(post.type === 'photo' ? 'اختر صورة بدلًا من الفيديو.' : 'اختر فيديو بدلًا من الصورة.');
        }
        const safeName = replacementFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const path = `${currentUserId}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from(storageBucket).upload(path, replacementFile, {
          upsert: true,
          contentType: replacementFile.type,
        });
        if (uploadError) throw uploadError;
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
        mediaUrls = [mediaUrl];
      }

      const { error } = await supabase.from('posts').update({
        content,
        media_url: post.type === 'text' ? null : mediaUrl,
        media_urls: post.type === 'text' ? null : mediaUrls,
      }).eq('id', post.id).eq('user_id', currentUserId);
      if (error) throw error;
      setShowEditModal(false);
      setReplacementFile(null);
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'تعذر تعديل المنشور. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const saveFeedback = async (value: 'interested' | 'not_interested') => {
    if (!supabaseConfigured) return;
    const previousFeedback = feedback;
    const nextFeedback = previousFeedback === value ? null : value;
    setFeedback(nextFeedback);
    try {
      const result = nextFeedback
        ? await supabase.from('post_feedback').upsert({ post_id: post.id, user_id: currentUserId, feedback: nextFeedback }, { onConflict: 'post_id,user_id' })
        : await supabase.from('post_feedback').delete().eq('post_id', post.id).eq('user_id', currentUserId);
      if (result.error) throw result.error;
    } catch {
      setFeedback(previousFeedback);
      alert('تعذر حفظ اختيارك. حاول مرة أخرى.');
    }
  };

  const reportPost = async () => {
    const reason = window.prompt('ما سبب الإبلاغ عن هذا المنشور؟');
    if (!reason?.trim() || !supabaseConfigured) return;
    const { error } = await supabase.from('post_reports').insert({
      post_id: post.id,
      reporter_id: currentUserId,
      reason: reason.trim(),
    });
    if (error) {
      alert(error.code === '23505' ? 'سبق أن أبلغت عن هذا المنشور.' : 'تعذر إرسال البلاغ. حاول مرة أخرى.');
      return;
    }
    alert('تم إرسال البلاغ للمراجعة.');
  };

  const handleDeletePost = async () => {
    if (!supabaseConfigured) return;
    if (confirm('هل أنت تأكد من رغبتك في حذف هذا المنشور؟')) {
      const { error } = await supabase.from('posts').delete().eq('id', post.id).eq('user_id', currentUserId);
      if (error) {
        alert('تعذر حذف المنشور. حاول مرة أخرى.');
        return;
      }
      onRefresh();
    }
  };

  return (
    <article className="post-card fade-up relative">
      {post.repost_attribution && (
        <div className="flex items-center gap-1.5 px-1 pt-2 text-[11px] text-zinc-500">
          <Repeat size={12} />
          <span>
            أعاد <strong className="font-bold text-zinc-400">{displayName(post.repost_attribution)}</strong> نشر هذا
          </span>
        </div>
      )}
      <header className="flex items-start gap-3 w-full">
        <Avatar profile={post.author} large />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link href={`/profile/${post.user_id}`} className="hover:underline">
              <strong className="text-white text-sm font-bold truncate block">{displayName(post.author)}</strong>
            </Link>
            <span className="text-zinc-500 text-xs truncate" dir="ltr">@{post.author?.username || 'user'}</span>
            <span className="text-zinc-600 text-xs">·</span>
            <time className="text-zinc-500 text-xs whitespace-nowrap">{formatDate(post.created_at)}</time>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="absolute left-3 top-3 p-1 text-zinc-500 transition hover:text-white" aria-label="خيارات المنشور">
              <MoreVertical size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {post.user_id === currentUserId ? (
              <>
                <DropdownMenuItem onSelect={() => { setEditContent(post.content || ''); setReplacementFile(null); setShowEditModal(true); }}>
                  <Pencil size={16} /> تعديل المنشور
                </DropdownMenuItem>
                <DropdownMenuItem className="text-red-400 focus:text-red-400" onSelect={() => void handleDeletePost()}>
                  <Trash2 size={16} /> حذف المنشور
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem className="text-red-400 focus:text-red-400" onSelect={() => void reportPost()}>
                  <Flag size={16} /> إبلاغ عن المنشور
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void saveFeedback('interested')}>
                  <ThumbsUp size={16} /> {feedback === 'interested' ? 'إلغاء مهتم' : 'مهتم'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void saveFeedback('not_interested')}>
                  <EyeOff size={16} /> {feedback === 'not_interested' ? 'إلغاء غير مهتم' : 'غير مهتم'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {post.content && (
        <p className="post-content text-sm text-zinc-200 mt-2.5 leading-relaxed">
          {post.content}
        </p>
      )}

      {/* معرض الصور التمريري (Carousel Slider) */}
      {urls.length > 0 && (
        <div className="relative mt-3 rounded-xl overflow-hidden border border-zinc-800">
          <div ref={trackRef} onScroll={handleScroll} className="carousel-track">
            {urls.map((url, i) => (
              <div key={i} className="carousel-slide">
                {post.type === 'reel' ? (
                  <video src={url} controls className="w-full max-h-[28rem] object-cover" />
                ) : (
                  <img src={url} alt="" className="w-full max-h-[28rem] object-cover select-none" />
                )}
              </div>
            ))}
          </div>

          {urls.length > 1 && (
            <>
              <div className="absolute bottom-2 inset-x-0 flex justify-center pointer-events-auto">
                <div className="dots bg-black/50 backdrop-blur px-2 py-1 rounded-full">
                  {urls.map((_, i) => (
                    <button key={i} onClick={() => goToImage(i)} className={`dot ${i === currentImageIndex ? 'active' : ''}`} />
                  ))}
                </div>
              </div>
              <div className="absolute top-2 left-2 text-[10px] bg-black/60 text-white px-2 py-0.5 rounded-full backdrop-blur">
                {currentImageIndex + 1}/{urls.length}
              </div>
            </>
          )}
        </div>
      )}

      {/* شريط الأزرار المتجمع جهة اليمين */}
      <footer className="border-t border-zinc-800/80 pt-2.5 mt-3">
        <div className="post-actions-right flex flex-nowrap items-center gap-4 justify-start w-full overflow-x-auto">
          {/* 1. الإعجاب */}
          <button
            type="button"
            className={`post-action-btn flex items-center gap-1.5 ${liked ? 'liked text-rose-500 font-bold' : 'text-zinc-400'}`}
            onClick={toggleLike}
            aria-pressed={liked}
            aria-label={liked ? 'إلغاء الإعجاب' : 'إعجاب'}
          >
            <Heart
              size={18}
              fill={liked ? 'currentColor' : 'none'}
              className={`transition-transform ${isAnimating ? 'animate-heart-pulse' : ''}`}
            />
            <span className="text-xs">{likesCount}</span>
          </button>

          {/* 2. التعليقات */}
          <button type="button" className="post-action-btn flex items-center gap-1.5 text-zinc-400 hover:text-blue-400 transition" onClick={loadComments}>
            <MessageSquare size={18} />
            <span className="text-xs">{commentsCount}</span>
          </button>

          {/* 3. إعادة النشر */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${reposted ? 'text-[#E53E3E] font-bold' : 'text-zinc-400 hover:text-[#E53E3E]'}`} onClick={toggleRepost} aria-pressed={reposted} aria-label={reposted ? 'إلغاء إعادة النشر' : 'إعادة النشر'}>
            <Repeat size={18} />
            <span className="text-xs">{repostsCount}</span>
          </button>

          {/* 4. المشاركة */}
          <button type="button" className="post-action-btn flex items-center gap-1.5 text-zinc-400 hover:text-purple-400 transition" onClick={() => setShowShareSheet(true)}>
            <Send size={18} />
          </button>

          {/* 5. الحفظ */}
          <button type="button" className={`post-action-btn flex items-center gap-1.5 transition ${bookmarked ? 'saved text-amber-400' : 'text-zinc-400 hover:text-amber-400'}`} onClick={toggleBookmark}>
            <Bookmark size={18} fill={bookmarked ? 'currentColor' : 'none'} />
          </button>

        </div>

        {comments && (
          <div className="comments-list mt-3 border-t border-zinc-800/40 pt-2 w-full">
            {busy && <p className="muted text-xs text-zinc-500">جاري تحميل التعليقات...</p>}
            {comments.map(c => (
              <p key={c.id} className="text-xs mb-1.5 text-zinc-300 break-words">
                <b className="text-white ml-1">{displayName(normalizeProfile(c.author))}:</b> {c.content}
              </p>
            ))}
            <form className="comment-form flex gap-1.5 mt-2 w-full" onSubmit={addComment}>
              <input className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-white w-full outline-none" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="إضافة تعليق..." />
              <button className="button-primary text-xs px-3 py-1 shrink-0" type="submit" disabled={busy || !commentText.trim()}>نشر</button>
            </form>
          </div>
        )}
      </footer>

      {showEditModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby={`edit-post-${post.id}`}>
          <form onSubmit={saveEdit} className="w-full max-w-lg space-y-4 rounded-xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 id={`edit-post-${post.id}`} className="text-base font-bold text-white">تعديل المنشور</h2>
              <button type="button" onClick={() => setShowEditModal(false)} className="p-1 text-zinc-400 hover:text-white" aria-label="إغلاق"><X size={18} /></button>
            </div>
            <textarea value={editContent} onChange={event => setEditContent(event.target.value)} maxLength={2000} rows={5} className="w-full resize-y rounded-lg border border-zinc-700 bg-black p-3 text-sm text-white outline-none focus:border-pink-500" placeholder="اكتب نص المنشور..." />
            {post.type !== 'text' && (
              <label className="block text-sm text-zinc-300">
                استبدال {post.type === 'photo' ? 'الصورة' : 'الفيديو'} بملف من النوع نفسه
                <input className="mt-2 block w-full text-xs text-zinc-400" type="file" accept={post.type === 'photo' ? 'image/*' : 'video/*'} onChange={event => setReplacementFile(event.target.files?.[0] || null)} />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="button-secondary text-xs" onClick={() => setShowEditModal(false)}>إلغاء</button>
              <button type="submit" className="button-primary px-4 text-xs" disabled={busy}>{busy ? 'جارٍ الحفظ...' : 'حفظ التعديلات'}</button>
            </div>
          </form>
        </div>
      )}

      {showShareSheet && (
        <ShareSheet
          post={post}
          currentUserId={currentUserId}
          reposted={reposted}
          onToggleRepost={toggleRepost}
          onRecordExternalShare={() => void recordShare(post, currentUserId)}
          onClose={() => setShowShareSheet(false)}
        />
      )}
    </article>
  );
}

// --- Hook الجلب الموحد ---
async function hydratePostInteractions(posts: Post[], currentUserId: string): Promise<Post[]> {
  if (!supabaseConfigured || posts.length === 0) return posts;

  const postIds = posts.map(post => post.id);
  const { data, error } = await supabase.rpc('get_post_interactions', { p_post_ids: postIds });
  if (error) {
    // فشل الـ RPC: نحسب جميع العدّادات مباشرة من الجداول
    // (تعليقات، إعادات نشر، مشاركات، إعجابات) حتى لا تبقى الأرقام صفرًا
    const [likesRes, commentsRes, repostsRes, sharesRes, feedbackRes] = await Promise.all([
      supabase.from('likes').select('post_id,user_id').in('post_id', postIds).limit(20000),
      supabase.from('comments').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('reposts').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_shares').select('post_id').in('post_id', postIds).limit(20000),
      supabase.from('post_feedback').select('post_id,feedback').eq('user_id', currentUserId).in('post_id', postIds),
    ]);

    const countByPostDirect = (rows: any[] | null): Map<string, number> => {
      const counts = new Map<string, number>();
      (rows || []).forEach(row => counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1));
      return counts;
    };

    const likeCounts = countByPostDirect(likesRes.data);
    const commentCounts = countByPostDirect(commentsRes.data);
    const repostCounts = countByPostDirect(repostsRes.data);
    const shareCounts = countByPostDirect(sharesRes.data);
    const likesRows = (likesRes.data || []) as Array<{ post_id: string; user_id: string }>;
    const feedbackByPost = new Map(((feedbackRes.data || []) as any[]).map(row => [row.post_id, row.feedback]));

    return posts.map(post => ({
      ...post,
      likes_count: likeCounts.get(post.id) ?? post.likes_count ?? 0,
      comments_count: commentCounts.get(post.id) ?? post.comments_count ?? 0,
      reposts_count: repostCounts.get(post.id) ?? post.reposts_count ?? 0,
      shares_count: shareCounts.get(post.id) ?? (post as any).shares_count ?? 0,
      liked_by_me: likesRows.some(l => l.post_id === post.id && l.user_id === currentUserId),
      reposted_by_me: Boolean(post.reposted_by_me),
      saved_by_me: Boolean(post.saved_by_me),
      feedback_by_me: (feedbackByPost.get(post.id) as Post['feedback_by_me']) || null,
    }));
  }
  const interactionRows = (data || []) as Array<{
    post_id: string;
    likes_count: number;
    comments_count: number;
    reposts_count: number;
    liked_by_me: boolean;
    reposted_by_me: boolean;
    saved_by_me: boolean;
    feedback_by_me: string | null;
  }>;
  const interactionByPost = new Map(interactionRows.map(row => [row.post_id, row]));

  return posts.map(post => {
    const interaction = interactionByPost.get(post.id);
    return {
      ...post,
      likes_count: Number(interaction?.likes_count || 0),
      comments_count: Number(interaction?.comments_count || 0),
      reposts_count: Number(interaction?.reposts_count || 0),
      liked_by_me: Boolean(interaction?.liked_by_me),
      reposted_by_me: Boolean(interaction?.reposted_by_me),
      saved_by_me: Boolean(interaction?.saved_by_me),
      feedback_by_me: (interaction?.feedback_by_me as Post['feedback_by_me']) || null,
    };
  });
}

function usePosts(query: 'feed' | 'reel' | 'profile', targetUserId?: string, currentUserId = '') {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) { setPosts([]); setLoading(false); return; }
    setLoading(true);
    try {
      if (query === 'feed') {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .in('type', ['text', 'photo'])
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        if (rawPosts && rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(p => p.user_id))];
          const { data: profs } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formatted = rawPosts.map(p => ({
            ...p,
            author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم آني' },
            likes: [],
            comments: []
          }));
          setPosts(await hydratePostInteractions(formatted as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'profile' && targetUserId) {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false });

        if (postsErr) throw postsErr;

        // جلب المنشورات التي أعاد المستخدم نشرها لعرضها في ملفه الشخصي
        const { data: repostRows } = await supabase
          .from('reposts')
          .select('post_id, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(50);

        const repostPostIds = (repostRows || []).map(r => r.post_id).filter((id: string) => !(rawPosts || []).some(p => p.id === id));

        let repostedRaw: any[] = [];
        const repostedAtById = new Map<string, string>();
        (repostRows || []).forEach(r => repostedAtById.set(r.post_id, r.created_at));

        if (repostPostIds.length > 0) {
          const { data: originalPosts } = await supabase
            .from('posts')
            .select('id, user_id, content, media_url, media_urls, type, created_at')
            .in('id', repostPostIds);
          repostedRaw = (originalPosts || []).map(p => ({ ...p, reposter_id: targetUserId }));
        }

        const allRaw = [...(rawPosts || []), ...repostedRaw];

        if (allRaw.length > 0) {
          const authorIds = [...new Set(allRaw.map(p => p.user_id))];
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .in('id', authorIds);
          const { data: reposterProf } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url')
            .eq('id', targetUserId)
            .maybeSingle();

          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formattedPosts = allRaw
            .map(p => ({
              ...p,
              author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم' },
              repost_attribution: p.reposter_id ? (reposterProf || { id: targetUserId, username: 'user', full_name: 'مستخدم' }) : null,
              likes: [],
              comments: []
            }))
            .sort((a, b) => {
              const aTime = repostedAtById.get(a.id) || a.created_at;
              const bTime = repostedAtById.get(b.id) || b.created_at;
              return new Date(bTime).getTime() - new Date(aTime).getTime();
            });

          setPosts(await hydratePostInteractions(formattedPosts as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'reel') {
        const { data: rawPosts, error: postsErr } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type, created_at')
          .eq('type', 'reel')
          .order('created_at', { ascending: false })
          .limit(50);

        if (postsErr) throw postsErr;

        if (rawPosts && rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(p => p.user_id))];
          const { data: profs } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', uIds);
          const profMap = new Map((profs || []).map(p => [p.id, p]));

          const formatted = rawPosts.map(p => ({
            ...p,
            author: profMap.get(p.user_id) || { id: p.user_id, username: 'user', full_name: 'مستخدم آني' },
            likes: [],
            comments: []
          }));
          setPosts(await hydratePostInteractions(formatted as unknown as Post[], currentUserId));
        } else {
          setPosts([]);
        }
      }
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [query, targetUserId, currentUserId]);

  useEffect(() => {
    void refresh();
    const onPostCreated = () => void refresh();
    window.addEventListener('aani:post-created', onPostCreated);
    return () => window.removeEventListener('aani:post-created', onPostCreated);
  }, [refresh]);

  // مزامنة العدّادات في الوقت الفعلي — تُقرأ من الصفوف الحقيقية (RPC) لا من أعمدة قد تتأخر
  useEffect(() => {
    if (!supabaseConfigured) return;

    const timers = new Map<string, number>();

    const reconcileCounters = async (postId: string) => {
      try {
        const { data, error } = await supabase.rpc('get_post_interactions', { p_post_ids: [postId] });
        if (error) return;

        const row = (data || [])[0] as
          | { likes_count?: number | string; comments_count?: number | string; reposts_count?: number | string }
          | undefined;
        if (!row) return;

        setPosts(current =>
          current.map(post =>
            post.id === postId
              ? {
                  ...post,
                  likes_count: Number(row.likes_count ?? post.likes_count ?? 0),
                  comments_count: Number(row.comments_count ?? post.comments_count ?? 0),
                  reposts_count: Number(row.reposts_count ?? post.reposts_count ?? 0),
                }
              : post,
          ),
        );
      } catch {
        /* تعذر الاتصال: نُبقي القيم الحالية دون إرباك الواجهة */
      }
    };

    const channel = supabase
      .channel('aani-post-counters')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts' },
        payload => {
          const row = payload.new as { id?: string };
          if (!row?.id) return;

          const existing = timers.get(row.id);
          if (existing) window.clearTimeout(existing);

          timers.set(
            row.id,
            window.setTimeout(() => {
              timers.delete(row.id);
              void reconcileCounters(row.id as string);
            }, 350),
          );
        },
      )
      .subscribe();

    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      timers.clear();
      void supabase.removeChannel(channel);
    };
  }, []);

  return { posts, loading, refresh };
}

// --- الصفحة الرئيسية ---
function FeedPage({
  userId,
  profile,
  onOpenComments,
  pendingStoryReshare,
  onStoryReshareHandled,
  pendingProfileStoryOwnerId,
  onProfileStoryHandled,
}: {
  userId: string;
  profile: Profile | null;
  onOpenComments: (postId: string) => void;
  pendingStoryReshare: StoryDmCardStory | null;
  onStoryReshareHandled: () => void;
  pendingProfileStoryOwnerId: string | null;
  onProfileStoryHandled: () => void;
}) {
  const { posts, loading, refresh } = usePosts('feed', undefined, userId);

  return (
    <section className="new-view w-full max-w-lg mx-auto">
      <div className="story-strip">
        <StoriesBar
          userId={userId}
          currentProfile={profile}
          pendingReshare={pendingStoryReshare}
          onReshareHandled={onStoryReshareHandled}
          pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
          onProfileStoryHandled={onProfileStoryHandled}
        />
      </div>

      {loading && <div className="loading-grid">{[1, 2].map(n => <div className="post-skeleton card" key={n}><i className="skeleton skeleton-avatar" /><div className="skeleton-copy"><i className="skeleton skeleton-line short" /></div></div>)}</div>}

      {!loading && posts.length === 0 && (
        <div className="empty-state card text-center p-8 border border-zinc-800 rounded-2xl bg-zinc-900/50">
          <div className="w-12 h-12 bg-pink-500/10 text-pink-500 rounded-full flex items-center justify-center mx-auto mb-3">
            <MessageCircle size={22} />
          </div>
          <h2 className="text-white font-bold text-base mb-1">لا يوجد محتوى منشور حالياً</h2>
          <p className="text-zinc-400 text-xs">انقر على علامة (+) في الأعلى لنشر أول منشور لك!</p>
        </div>
      )}

      {!loading && posts.length > 0 && <div className="posts-list space-y-3">{posts.map(post => <PostCard key={post.id} post={post} currentUserId={userId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />)}</div>}
    </section>
  );
}

function PostDetailPage({ postId, currentUserId, onOpenComments }: { postId: string; currentUserId: string; onOpenComments: (postId: string) => void }) {
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) {
      setPost(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.from('posts')
        .select('id, user_id, content, media_url, media_urls, type, created_at')
        .eq('id', postId)
        .maybeSingle();
      if (error || !data) {
        setPost(null);
        return;
      }
      const { data: author } = await supabase.from('profiles')
        .select('id, username, full_name, avatar_url')
        .eq('id', data.user_id)
        .maybeSingle();
      const hydrated = await hydratePostInteractions([{
        ...data,
        author: author || { id: data.user_id, username: 'user', full_name: 'مستخدم آني' },
      } as unknown as Post], currentUserId);
      setPost(hydrated[0] || null);
    } catch {
      setPost(null);
    } finally {
      setLoading(false);
    }
  }, [postId, currentUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="new-view mx-auto w-full max-w-lg">
      {loading && <p className="py-8 text-center text-sm text-zinc-400">جارٍ تحميل المنشور...</p>}
      {!loading && !post && <p className="py-8 text-center text-sm text-zinc-400">هذا المنشور غير متاح.</p>}
      {post && <PostCard post={post} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />}
    </section>
  );
}

// --- صفحة البحث ---
function SearchPage({ userId }: { userId: string }) {
  const [term, setTerm] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  const historyKey = `aani_search_history_${userId}`;

  useEffect(() => {
    const saved = localStorage.getItem(historyKey);
    if (saved) {
      try { setSearchHistory(JSON.parse(saved)); } catch {}
    }
  }, [historyKey]);

  const saveHistory = (newHistory: string[]) => {
    setSearchHistory(newHistory);
    localStorage.setItem(historyKey, JSON.stringify(newHistory));
  };

  const handleSearch = async (queryTerm: string) => {
    if (!supabaseConfigured || !queryTerm.trim()) return;
    setLoading(true);
    const { data } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_url, bio')
      .or(`username.ilike.%${queryTerm.trim()}%,full_name.ilike.%${queryTerm.trim()}%`)
      .limit(30);

    setProfiles((data || []) as Profile[]);
    setLoading(false);

    if (!searchHistory.includes(queryTerm.trim())) {
      saveHistory([queryTerm.trim(), ...searchHistory.slice(0, 9)]);
    }
  };

  const deleteHistoryItem = (itemToDelete: string) => {
    saveHistory(searchHistory.filter(item => item !== itemToDelete));
  };

  const clearAllHistory = () => {
    saveHistory([]);
  };

  return (
    <section className="new-view space-y-4 max-w-lg mx-auto">
      <form className="toolbar flex gap-2" onSubmit={e => { e.preventDefault(); handleSearch(term); }}>
        <label className="searchbox flex-1 bg-zinc-950 border border-zinc-700/80 rounded-2xl px-4 py-3 flex items-center gap-3 shadow-inner">
          <Search size={20} className="text-pink-500" />
          <input 
            value={term} 
            onChange={e => setTerm(e.target.value)} 
            placeholder="ابحث عن الاسم واسم المستخدم (@username)..." 
            className="w-full bg-transparent outline-none text-sm text-white placeholder-zinc-500 font-medium"
          />
        </label>
        <button className="button-primary text-xs px-5 py-3 rounded-2xl font-bold" type="submit">بحث</button>
      </form>

      {!term && searchHistory.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 p-3 rounded-2xl space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-400 font-semibold">عمليات البحث الأخيرة</span>
            <button onClick={clearAllHistory} className="text-pink-400 hover:underline">مسح الكل</button>
          </div>
          <div className="space-y-1">
            {searchHistory.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800/60 text-xs">
                <span onClick={() => { setTerm(item); handleSearch(item); }} className="text-zinc-200 cursor-pointer flex-1 font-medium">
                  🔍 {item}
                </span>
                <button onClick={() => deleteHistoryItem(item)} className="text-zinc-500 hover:text-red-400 p-1">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="status-box">جاري البحث عن الحسابات...</div>}

      {!loading && profiles.length > 0 && (
        <div className="card space-y-2">
          {profiles.map(p => (
            <Link key={p.id} href={`/profile/${p.id}`} className="flex items-center justify-between p-2.5 rounded-xl hover:bg-zinc-800/50">
              <div className="flex items-center gap-3">
                <Avatar profile={p} large />
                <div>
                  <strong className="text-xs text-white block font-bold">{displayName(p)}</strong>
                  <span className="text-[11px] text-zinc-400" dir="ltr">@{p.username}</span>
                </div>
              </div>
              <ArrowUpLeft size={16} className="text-zinc-500" />
            </Link>
          ))}
        </div>
      )}

      {!loading && term.trim() && profiles.length === 0 && (
        <div className="empty-state card">
          <h2>لا توجد نتائج مطابقة</h2>
          <p className="text-xs text-zinc-400">تأكد من كتابة اسم المستخدم أو الاسم الصحيح.</p>
        </div>
      )}
    </section>
  );
}

// --- معاينة منشور مشارَك داخل الرسائل (بطاقة مدمجة تفتح المنشور الأصلي) ---
function SharedPostPreview({ content, postId }: { content?: string | null; postId?: string | null }) {
  const match = (content || '').match(/^\[post:(\S+)\]([\s\S]*)$/);
  const resolvedId = postId || match?.[1] || '';
  const caption = (match?.[2] || '').trim();
  const [info, setInfo] = useState<{ author: Profile | null; media: string; text: string; type: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(true);
  const [, navigateToPost] = useLocation();

  useEffect(() => {
    let active = true;

    if (!supabaseConfigured || !resolvedId) {
      setLoading(false);
      return;
    }

    setLoading(true);

    void (async () => {
      try {
        const { data: p } = await supabase
          .from('posts')
          .select('id, user_id, content, media_url, media_urls, type')
          .eq('id', resolvedId)
          .maybeSingle();

        if (!active) return;

        if (!p) {
          setInfo({ author: null, media: '', text: '', type: 'text' });
          return;
        }

        const { data: a } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .eq('id', p.user_id)
          .maybeSingle();

        if (!active) return;

        const raw = p as { media_urls?: string[] | null; media_url?: string | null; content?: string; type?: string };
        const media = (raw.media_urls?.length ? raw.media_urls[0] : raw.media_url) || '';

        setInfo({
          author: (a || null) as Profile | null,
          media,
          text: String(raw.content || ''),
          type: String(raw.type || 'text'),
        });
      } catch {
        if (active) setInfo({ author: null, media: '', text: '', type: 'text' });
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [resolvedId]);

  if (!resolvedId) return null;

  const shareLink = async () => {
    const url = postShareUrl(resolvedId);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'منشور على آني', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success('تم نسخ رابط المنشور');
    } catch {
      /* ألغى المستخدم المشاركة */
    }
  };

  const isVideo = info?.type === 'reel';

  return (
    <div className="flex w-full items-center gap-2" dir="rtl">
      {/* صورة الناشر خارج الفقاعة يميناً، بمحاذاة وسط كرت الوسائط */}
      <span className="flex h-full shrink-0 items-center">
        {info?.author?.avatar_url ? (
          <img src={info.author.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-[10px] font-bold text-white">
            {info?.author ? displayName(info.author).replace('@', '').charAt(0) : 'آ'}
          </span>
        )}
      </span>

      {/* فقاعة الرسالة: عرض 62% وحدود منقطة رمادية فاتحة */}
      <div
        role="link"
        tabIndex={0}
        onClick={() => navigateToPost(`/post/${resolvedId}`)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            navigateToPost(`/post/${resolvedId}`);
          }
        }}
        className="w-[62%] min-w-0 shrink-0 cursor-pointer overflow-hidden rounded-2xl border-[1.5px] border-dashed border-zinc-300/60 bg-zinc-900/75 transition hover:border-pink-500/60"
      >
        <div className="relative aspect-[4/5] w-full overflow-hidden bg-black">
          {loading ? (
            <div className="h-full w-full animate-pulse bg-zinc-800/80" />
          ) : isVideo && info?.media ? (
            <video
              src={info.media}
              muted={muted}
              autoPlay
              loop
              playsInline
              className="h-full w-full object-cover"
            />
          ) : info?.media ? (
            <img src={info.media} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-pink-600/25 to-violet-600/25 p-3">
              <p className="line-clamp-5 text-center text-[11px] leading-5 text-zinc-100">
                {info?.text || 'منشور على آني'}
              </p>
            </div>
          )}

          {/* شعار/أيقونة أعلى الزاوية */}
          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white backdrop-blur">
            <Repeat size={10} /> آني
          </span>

          {/* زر التشغيل في منتصف الوسائط */}
          {isVideo && !loading && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
                <Play size={16} fill="currentColor" />
              </span>
            </span>
          )}

          {/* زر كتم الصوت أسفل اليسار (للريلز) */}
          {isVideo && !loading && (
            <button
              type="button"
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                setMuted(current => !current);
              }}
              aria-label={muted ? 'إلغاء الكتم' : 'كتم الصوت'}
              className="absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/75"
            >
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          )}
        </div>

        {(info?.text || caption) && !loading && (
          <div className="space-y-0.5 px-2 py-1.5">
            {info?.text && (
              <p className="line-clamp-2 text-right text-[11px] leading-4 text-zinc-300">{info.text}</p>
            )}
            {caption && (
              <p className="line-clamp-1 text-right text-[10px] text-zinc-500">{caption}</p>
            )}
          </div>
        )}

        {!loading && !info && (
          <p className="px-2 py-1.5 text-right text-[11px] text-zinc-400">هذا المنشور لم يعد متاحاً.</p>
        )}
      </div>

      {/* أيقونة المشاركة خارج الفقاعة على اليسار */}
      <button
        type="button"
        onClick={() => void shareLink()}
        aria-label="مشاركة المنشور"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-zinc-300 transition hover:border-pink-500/60 hover:text-white"
      >
        <SendHorizontal size={14} className="rotate-180" />
      </button>
    </div>
  );
}

// --- صفحة الرسائل ---
function MessagesPage({
  currentUserId,
  selectedId,
  onReshareStory,
}: {
  currentUserId: string;
  selectedId?: string;
  onReshareStory: (story: StoryDmCardStory) => void;
}) {
  const [, setLocation] = useLocation();
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [target, setTarget] = useState<Profile | null>(null);
  const [thread, setThread] = useState<any[]>([]);
  const [text, setText] = useState('');

  const loadThread = useCallback(async () => {
    if (!supabaseConfigured || !selectedId) return;

    const threadFilter = `and(sender_id.eq.${currentUserId},recipient_id.eq.${selectedId}),and(sender_id.eq.${selectedId},recipient_id.eq.${currentUserId})`;

    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, recipient_id, content, post_id, story_id, created_at')
      .or(threadFilter)
      .order('created_at', { ascending: true });

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '42703' || /post_id|story_id/i.test(error.message || '')) {
        // أعمدة المراجع غير مطبّقة في القاعدة بعد: نجلب المحادثة بدونها
        const { data: fallback } = await supabase
          .from('messages')
          .select('id, sender_id, recipient_id, content, created_at')
          .or(threadFilter)
          .order('created_at', { ascending: true });
        setThread(fallback || []);
        return;
      }
      console.error('[messages] تعذر جلب المحادثة:', error);
      setThread([]);
      return;
    }

    setThread(data || []);
  }, [currentUserId, selectedId]);

  useEffect(() => {
    if (!supabaseConfigured) return;
    const loadContacts = async () => {
      const { data: msgs } = await supabase
        .from('messages')
        .select('sender_id, recipient_id')
        .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
        .order('created_at', { ascending: false });

      const ids = [...new Set((msgs || []).flatMap(m => [m.sender_id, m.recipient_id]).filter(id => id !== currentUserId))];
      if (selectedId && !ids.includes(selectedId)) ids.unshift(selectedId);

      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, username, full_name, avatar_url').in('id', ids);
        setContacts((profs || []) as Profile[]);
      } else {
        setContacts([]);
      }
    };
    void loadContacts();
  }, [currentUserId, selectedId]);

  useEffect(() => {
    if (!selectedId || !supabaseConfigured) return;
    setTarget(contacts.find(c => c.id === selectedId) || null);
    void loadThread();

    const channel = supabase.channel(`realtime-msgs-${selectedId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => void loadThread())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, contacts, loadThread]);

  const sendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabaseConfigured || !selectedId || !text.trim()) return;
    await supabase.from('messages').insert({ sender_id: currentUserId, recipient_id: selectedId, content: text.trim() });
    setText('');
    await loadThread();
  };

  return (
    <section className="new-view max-w-lg mx-auto">
      <div className="page-heading mb-3"><div><span className="eyebrow">محادثات مباشرة</span><h1 className="text-white text-base font-bold">الرسائل</h1></div></div>

      {!selectedId ? (
        contacts.length > 0 ? (
          <div className="card space-y-2">
            {contacts.map(c => (
              <Link key={c.id} href={`/messages/${c.id}`} className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800/50">
                <div className="flex items-center gap-2">
                  <Avatar profile={c} />
                  <div>
                    <strong className="text-xs text-white block">{displayName(c)}</strong>
                    <span className="text-[10px] text-zinc-400" dir="ltr">@{c.username}</span>
                  </div>
                </div>
                <ArrowUpLeft size={16} className="text-zinc-500" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state card"><h2>لا توجد محادثات بعد</h2><p className="text-xs text-zinc-400">ابدأ محادثة مع أصدقائك عبر بروفايلهم!</p></div>
        )
      ) : (
        <div className="card flex flex-col h-[70vh]">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2 mb-2">
            <button onClick={() => setLocation('/messages')} className="text-xs text-pink-500 flex items-center gap-1"><ArrowUpLeft size={14} /> كل الرسائل</button>
            {target && <strong className="text-xs text-white">{displayName(target)}</strong>}
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 p-2">
            {thread.map(m => {
              const isMine = m.sender_id === currentUserId;
              const isSharedPost = Boolean(m.post_id) || (typeof m.content === 'string' && m.content.trim().startsWith('[post:'));
              const storyFromColumn = m.story_id ? String(m.story_id) : null;
              const storyFromContent =
                typeof m.content === 'string' && m.content.trim().startsWith('[story:')
                  ? m.content.trim().slice(7).split(']')[0]
                  : null;
              const sharedStoryId = storyFromColumn || storyFromContent;
              const isStoryReply = Boolean(m.story_id) && typeof m.content === 'string' && m.content.startsWith('[story-reply]');
              const isSharedStory = Boolean(sharedStoryId) && !isSharedPost && !isStoryReply;
              return (
                <div key={m.id} className={`flex flex-col ${isSharedPost || isSharedStory ? 'w-full' : 'max-w-[85%]'} ${isMine ? 'items-end mr-auto' : 'items-start ml-auto'}`}>
                  {!isMine && target && (
                    <span className="mb-0.5 text-[10px] text-zinc-500">{displayName(target)}</span>
                  )}
                  {isSharedPost ? (
                    <div className="w-full">
                      <SharedPostPreview postId={m.post_id} content={m.content} />
                    </div>
                  ) : isSharedStory ? (
                    <div className={`w-full ${isMine ? 'flex justify-end' : 'flex justify-start'}`}>
                      <StoryDmCard
                        storyId={String(sharedStoryId)}
                        currentUserId={currentUserId}
                        senderName={target ? displayName(target) : undefined}
                        onAddToStory={story => {
                          onReshareStory(story);
                          setLocation('/feed');
                        }}
                      />
                    </div>
                  ) : (
                    <div className={`p-2 rounded-xl text-xs ${isMine ? 'bg-pink-600 text-white' : 'bg-zinc-800 text-zinc-200'}`}>
                      {isStoryReply ? (
                        <>
                          <span className="mb-1 block text-[9px] text-white/65">رد على الستوري</span>
                          <span>{String(m.content).slice('[story-reply]'.length).trim()}</span>
                        </>
                      ) : typeof m.content === 'string' && m.content.trim().startsWith('[story:')
                        ? 'أرسل لك قصة'
                        : m.content}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <form className="flex gap-2 pt-2 border-t border-zinc-800" onSubmit={sendMessage}>
            <input value={text} onChange={e => setText(e.target.value)} placeholder="اكتب رسالة..." className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl p-2 text-xs text-white outline-none" />
            <button type="submit" className="button-primary text-xs px-3"><Send size={14} /></button>
          </form>
        </div>
      )}
    </section>
  );
}

// --- الملف الشخصي ---
function ProfilePage({
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

  const { posts, loading, refresh } = usePosts('profile', activeUserId, currentUserId);

  useEffect(() => {
    if (!supabaseConfigured || !activeUserId) return;
    let active = true;
    const loadProfileData = async () => {
      const now = new Date();
      const [{ data: prof }, { count: fCount }, { count: fingCount }, { count: pCount }, { data: checkFollow }, { data: checkRequest }, { data: activeStories }, { data: incomingRequests }] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', activeUserId).maybeSingle(),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', activeUserId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', activeUserId),
        supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', activeUserId),
        own ? Promise.resolve({ data: null }) : supabase.from('follows').select('*').eq('follower_id', currentUserId).eq('following_id', activeUserId).maybeSingle(),
        own ? Promise.resolve({ data: null }) : supabase.from('follow_requests').select('requester_id').eq('requester_id', currentUserId).eq('recipient_id', activeUserId).maybeSingle(),
        supabase.from('stories').select('id, is_close_friends').eq('user_id', activeUserId)
          .gte('created_at', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
          .gt('expires_at', now.toISOString()).limit(50),
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
      <div className="profile-banner card flex items-center gap-4 p-4 border border-zinc-800 rounded-2xl bg-zinc-900/80">
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
        <div className="flex-1">
          <strong dir="ltr" className="text-white text-sm block font-bold">@{person.username}</strong>
          <p className="text-xs text-zinc-400 my-1">{person.bio || 'لا توجد نبذة شخصية'}</p>

          <div className="flex gap-4 my-2 text-xs text-zinc-300">
            <span><b className="text-white">{postCount}</b> منشور</span>
            <span><b className="text-white">{followers}</b> متابِع</span>
            <span><b className="text-white">{following}</b> يتابع</span>
          </div>

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
            <div key={request.profile.id} className="flex items-center gap-2 rounded-xl bg-black/20 p-2">
              <Avatar profile={request.profile} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white">
                {request.profile.full_name || `@${request.profile.username}`}
              </span>
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
      {!loading && posts.length === 0 && <div className="empty-state card text-center p-6 text-zinc-400 text-xs">لا يوجد محتوى منشور حالياً لهذا المستخدم</div>}

      {!loading && posts.length > 0 && (
        <div className="posts-list space-y-3">
          {posts.map(post => (
            <PostCard key={post.id} post={post} currentUserId={currentUserId} onRefresh={() => void refresh()} onOpenComments={onOpenComments} />
          ))}
        </div>
      )}
    </section>
  );
}

// --- شريحة ريل مع أزرار عائمة مرتفعة ومتحركة مع كل فيديو ---
function ReelSlide({ post, currentUserId }: { post: Post; currentUserId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const likeBusyRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [liked, setLiked] = useState(post.liked_by_me ?? (post.likes || []).some(l => l.user_id === currentUserId));
  const [likesCount, setLikesCount] = useState(post.likes_count ?? post.likes?.length ?? 0);
  const [saved, setSaved] = useState(post.saved_by_me ?? false);
  const [reposted, setReposted] = useState(post.reposted_by_me ?? false);
  const [feedback, setFeedback] = useState<Post['feedback_by_me']>(post.feedback_by_me || null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  // مزامنة أعلام التفاعل فقط عند تغيّرها فعليًا (وليس مع كل تحديث للعدّادات)
  useEffect(() => {
    setLiked(post.liked_by_me ?? (post.likes || []).some(like => like.user_id === currentUserId));
    setSaved(post.saved_by_me ?? false);
    setReposted(post.reposted_by_me ?? false);
    setFeedback(post.feedback_by_me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.liked_by_me, post.reposted_by_me, post.saved_by_me, post.feedback_by_me, currentUserId]);

  // عدّاد الإعجاب من قاعدة البيانات، مع عدم إرباك الضغطة أثناء تنفيذ الطلب
  useEffect(() => {
    if (!likeBusyRef.current) {
      setLikesCount(post.likes_count ?? post.likes?.length ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.likes_count]);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          } else {
            video.pause();
            setPlaying(false);
          }
        });
      },
      { threshold: 0.6 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const toggleLike = async () => {
    // حماية من الضغطات السريعة المتتالية
    if (likeBusyRef.current) return;

    const prevLiked = liked;
    const prevCount = likesCount;
    likeBusyRef.current = true;
    setLiked(!prevLiked);
    setLikesCount(Math.max(0, prevLiked ? prevCount - 1 : prevCount + 1));

    if (!supabaseConfigured) {
      likeBusyRef.current = false;
      return;
    }

    try {
      if (prevLiked) {
        const { error } = await supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', currentUserId);
        // لا يوجد صف إعجاب = الحالة المطلوبة أصلًا
        if (error && error.code !== 'PGRST116') throw error;
      } else {
        const { error } = await supabase.from('likes').insert({ post_id: post.id, user_id: currentUserId });
        // إعجاب مسجّل مسبقًا = الحالة المطلوبة أصلًا (لا تراجع عن الواجهة)
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    } finally {
      likeBusyRef.current = false;
    }
  };

  const toggleBookmark = async () => {
    const prevSaved = saved;
    setSaved(!prevSaved);

    if (!supabaseConfigured) return;
    try {
      if (prevSaved) {
        await supabase.from('bookmarks').delete().eq('post_id', post.id).eq('user_id', currentUserId);
      } else {
        await supabase.from('bookmarks').insert({ post_id: post.id, user_id: currentUserId });
      }
    } catch {
      setSaved(prevSaved);
    }
  };

  const toggleRepost = async () => {
    const prevReposted = reposted;
    setReposted(!prevReposted);

    if (!supabaseConfigured) return;
    try {
      if (prevReposted) {
        await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', currentUserId);
      } else {
        await supabase.from('reposts').insert({ post_id: post.id, user_id: currentUserId });
      }
    } catch {
      setReposted(prevReposted);
    }
  };

  const saveFeedback = async (value: 'interested' | 'not_interested') => {
    if (!supabaseConfigured) return;
    const previousFeedback = feedback;
    const nextFeedback = previousFeedback === value ? null : value;
    setFeedback(nextFeedback);
    try {
      const result = nextFeedback
        ? await supabase.from('post_feedback').upsert({ post_id: post.id, user_id: currentUserId, feedback: nextFeedback }, { onConflict: 'post_id,user_id' })
        : await supabase.from('post_feedback').delete().eq('post_id', post.id).eq('user_id', currentUserId);
      if (result.error) throw result.error;
    } catch {
      setFeedback(previousFeedback);
      alert('تعذر حفظ اختيارك. تأكد من تطبيق ترحيل تفاعلات المنشورات في Supabase.');
    }
  };

  const reportPost = async () => {
    const reason = window.prompt('ما سبب الإبلاغ عن هذا الريل؟');
    if (!reason?.trim() || !supabaseConfigured) return;
    const { error } = await supabase.from('post_reports').insert({
      post_id: post.id,
      reporter_id: currentUserId,
      reason: reason.trim(),
    });
    if (error) {
      alert(error.code === '23505' ? 'سبق أن أبلغت عن هذا الريل.' : 'تعذر إرسال البلاغ. تأكد من تطبيق ترحيل التفاعلات في Supabase.');
      return;
    }
    alert('تم إرسال البلاغ للمراجعة.');
  };

  return (
    <section ref={containerRef} className="reel-slide relative w-full h-screen overflow-hidden bg-black">
      <video
        ref={videoRef}
        src={post.media_url || ''}
        loop
        playsInline
        onClick={togglePlay}
        className="w-full h-full object-cover cursor-pointer"
      />

      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-black/50 rounded-full p-5 backdrop-blur-md text-white">
            <Play size={36} fill="currentColor" />
          </div>
        </div>
      )}

      {/* تفاصيل الريل أسفل الشاشة */}
      <div className="absolute inset-x-0 bottom-0 pt-24 pb-12 px-4 reel-gradient-bottom z-20 pointer-events-none">
        <div className="flex items-end justify-between gap-4">
          <div className="flex-1 min-w-0 text-white pointer-events-auto">
            <div className="flex items-center gap-2 mb-2">
              <Avatar profile={post.author} />
              <span className="font-bold text-sm truncate">{displayName(post.author)}</span>
            </div>
            {post.content && <p className="text-sm leading-snug line-clamp-3">{post.content}</p>}
          </div>
        </div>
      </div>

      {/* الأزرار العائمة المرتفعة عن شريط التنقل والمتحركة مع كل فيديو */}
      <div className="absolute right-4 bottom-28 z-30 flex flex-col items-center gap-4">
        {/* 1. الإعجاب */}
        <button onClick={toggleLike} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${liked ? 'text-pink-500' : ''}`}>
            <Heart size={22} fill={liked ? 'currentColor' : 'none'} />
          </span>
          <span className="text-[11px] font-semibold">{likesCount}</span>
        </button>

        {/* 2. التعليقات */}
        <button className="flex flex-col items-center gap-1 text-white">
          <span className="p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md">
            <MessageSquare size={22} />
          </span>
          <span className="text-[11px] font-bold">
            {post.comments_count ?? post.comments?.length ?? 0}
          </span>
        </button>

        {/* 3. إعادة النشر */}
        <button onClick={toggleRepost} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${reposted ? 'text-[#E53E3E]' : ''}`}>
            <Repeat size={22} />
          </span>
        </button>

        {/* 4. المشاركة */}
        <button onClick={() => setShowShareSheet(true)} className="flex flex-col items-center gap-1 text-white">
          <span className="p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md">
            <Send size={22} />
          </span>
        </button>

        {/* 5. الحفظ */}
        <button onClick={toggleBookmark} className="flex flex-col items-center gap-1 text-white">
          <span className={`p-2.5 rounded-full bg-black/40 border border-white/20 backdrop-blur-md transition ${saved ? 'text-amber-400' : ''}`}>
            <Bookmark size={22} fill={saved ? 'currentColor' : 'none'} />
          </span>
        </button>

        {/* 6. النقاط الثلاثة خيارات إضافية */}
        <div className="relative">
          <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 rounded-full bg-black/40 border border-white/20 backdrop-blur-md text-white">
            <MoreVertical size={18} />
          </button>

          {menuOpen && (
            <div className="absolute right-10 bottom-0 bg-zinc-900 border border-zinc-800 rounded-xl p-2 w-48 text-xs text-white shadow-2xl z-40">
              <button onClick={() => { void reportPost(); setMenuOpen(false); }} className="flex items-center gap-2 w-full text-red-400 p-2 hover:bg-zinc-800 rounded-lg">
                <Flag size={14} /> إبلاغ عن الريل
              </button>
              <button onClick={() => { void saveFeedback('interested'); setMenuOpen(false); }} className={`flex items-center gap-2 w-full p-2 hover:bg-zinc-800 rounded-lg ${feedback === 'interested' ? 'text-cyan-300' : 'text-zinc-300'}`}>
                <ThumbsUp size={14} /> {feedback === 'interested' ? 'إلغاء مهتم' : 'مهتم'}
              </button>
              <button onClick={() => { void saveFeedback('not_interested'); setMenuOpen(false); }} className={`flex items-center gap-2 w-full p-2 hover:bg-zinc-800 rounded-lg ${feedback === 'not_interested' ? 'text-zinc-100' : 'text-zinc-300'}`}>
                <EyeOff size={14} /> {feedback === 'not_interested' ? 'إلغاء غير مهتم' : 'غير مهتم'}
              </button>
            </div>
          )}
        </div>
      </div>

      {showShareSheet && (
        <ShareSheet
          post={post}
          currentUserId={currentUserId}
          reposted={reposted}
          onToggleRepost={toggleRepost}
          onRecordExternalShare={() => void recordShare(post, currentUserId)}
          onClose={() => setShowShareSheet(false)}
        />
      )}
    </section>
  );
}

// --- صفحة Reels ---
function ReelsPage({ userId }: { userId: string }) {
  const { posts, loading } = usePosts('reel', undefined, userId);

  return (
    <div className="reels-container">
      {loading && <div className="status-box text-white pt-20">جاري تحميل الريلز...</div>}
      {!loading && !posts.length && (
        <div className="empty-state text-center py-24 text-white">
          <Film size={36} className="mx-auto text-pink-500 mb-2" />
          <h2 className="font-bold text-lg">لا يوجد ريلز منشور حالياً</h2>
        </div>
      )}
      {!loading && posts.map(post => <ReelSlide key={post.id} post={post} currentUserId={userId} />)}
    </div>
  );
}

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: Profile | null;
  onSignOut: () => void;
};

// --- نافذة الإعدادات ---
function SettingsModal({ isOpen, onClose, currentProfile, onSignOut }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'main' | 'mulhim'>('main');
  const [mode, setMode] = useState<'gemini' | 'chatgpt' | 'coanalysis'>('coanalysis');
  const [messages, setMessages] = useState<Array<{ id: string; sender: 'user' | 'mulhim'; text: string }>>([
    { id: 'init', sender: 'mulhim', text: 'أهلاً بك في مركز "مُلهِم آني"! أنا جاهز لتلقي أوامرك وتعديل كود المشروع المباشر فوراً.' }
  ]);
  const [inputMsg, setInputMsg] = useState('');
  const [aiThinking, setAiThinking] = useState(false);

  if (!isOpen) return null;

  const handleSendAi = (e: FormEvent) => {
    e.preventDefault();
    if (!inputMsg.trim() || aiThinking) return;

    const userText = inputMsg.trim();
    const userMsgObj = { id: Math.random().toString(), sender: 'user' as const, text: userText };
    setMessages(prev => [...prev, userMsgObj]);
    setInputMsg('');
    setAiThinking(true);

    setTimeout(() => {
      let replyText = `[وضع ${mode.toUpperCase()}]: أهلاً بك! إجابة سريعة على "${userText}": التطبيق جاهز ومربوط مع خادم التعديل المباشر.`;
      setMessages(prev => [...prev, { id: Math.random().toString(), sender: 'mulhim', text: replyText }]);
      setAiThinking(false);
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <section
        className="w-full max-w-sm rounded-3xl border border-zinc-800 bg-zinc-900 p-4 text-white shadow-2xl flex flex-col h-[80vh]"
        role="dialog"
        aria-modal="true"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2">
            <Settings size={18} />
            <h2 className="text-sm font-bold">إعدادات الحساب</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-2 border-b border-zinc-800 py-2 text-xs font-semibold">
          <button onClick={() => setActiveTab('main')} className={`px-3 py-1.5 rounded-xl transition ${activeTab === 'main' ? 'bg-pink-600 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}>
            الحساب
          </button>
          <button onClick={() => setActiveTab('mulhim')} className={`px-3 py-1.5 rounded-xl flex items-center gap-1.5 transition ${activeTab === 'mulhim' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold' : 'text-zinc-400 hover:bg-zinc-800'}`}>
            <Sparkles size={14} className="text-pink-300" /> مُلهِم الذكي
          </button>
        </div>

        {activeTab === 'main' ? (
          <div className="space-y-4 pt-3 flex-1">
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <Avatar profile={currentProfile} large />
              <div className="min-w-0">
                <strong className="block truncate text-sm">{displayName(currentProfile)}</strong>
                {currentProfile?.username && <span className="text-xs text-zinc-400" dir="ltr">@{currentProfile.username}</span>}
              </div>
            </div>
            <p className="text-xs leading-6 text-zinc-400">إدارة جلسة تسجيل الدخول وإعدادات حسابك في آني.</p>
            <button type="button" onClick={onSignOut} className="w-full rounded-xl bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-300 hover:bg-red-500/20">
              تسجيل الخروج
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden pt-2">
            <div className="flex justify-between items-center bg-zinc-950 p-1.5 rounded-xl border border-zinc-800 mb-2 text-[10px]">
              <span className="text-zinc-400 font-semibold px-1">الوضع:</span>
              <div className="flex gap-1">
                <button onClick={() => setMode('gemini')} className={`px-2 py-0.5 rounded-md ${mode === 'gemini' ? 'bg-purple-600 text-white font-bold' : 'text-zinc-400'}`}>Gemini</button>
                <button onClick={() => setMode('chatgpt')} className={`px-2 py-0.5 rounded-md ${mode === 'chatgpt' ? 'bg-emerald-600 text-white font-bold' : 'text-zinc-400'}`}>ChatGPT</button>
                <button onClick={() => setMode('coanalysis')} className={`px-2 py-0.5 rounded-md ${mode === 'coanalysis' ? 'bg-pink-600 text-white font-bold' : 'text-zinc-400'}`}>مشترك</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5 p-1 text-xs no-scrollbar">
              {messages.map(m => (
                <div key={m.id} className={`p-3 rounded-2xl max-w-[85%] whitespace-pre-wrap leading-relaxed ${m.sender === 'user' ? 'bg-pink-600 text-white mr-auto rounded-bl-none' : 'bg-zinc-800 text-zinc-200 ml-auto rounded-br-none border border-zinc-700/60'}`}>
                  {m.sender === 'mulhim' && <span className="font-bold text-[10px] text-pink-400 block mb-1">✨ مُلهِم آني</span>}
                  {m.text}
                </div>
              ))}
              {aiThinking && <p className="text-[10px] text-zinc-500 animate-pulse px-2">مُلهِم يكتب الآن...</p>}
            </div>

            <form onSubmit={handleSendAi} className="flex gap-1.5 pt-2 border-t border-zinc-800 mt-1">
              <input 
                value={inputMsg} 
                onChange={e => setInputMsg(e.target.value)} 
                placeholder="اسأل مُلهِم شيئاً..." 
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none"
              />
              <button type="submit" disabled={aiThinking || !inputMsg.trim()} className="bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white p-2 rounded-xl">
                <SendHorizontal size={15} />
              </button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}

type NotificationItem = {
  id: string;
  content: string;
  type: string;
  is_read: boolean;
  created_at: string;
  actor_id?: string | null;
  entity_id?: string | null;
  actor?: Profile | null;
};

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

// --- الهيكل الرئيسي لتطبيق آني (Shell) ---
/**
 * يحدد إن كانت اللمسة بدأت داخل عنصر يملك إيماءة أفقية خاصة (معرض صور،
 * نافذة، حقل إدخال، فيديو...) حتى لا تُختطف من التنقل بالسحب.
 */
function isHorizontalGestureArea(target: EventTarget | null): boolean {
  let node = target as HTMLElement | null;

  while (node && node !== document.body) {
    const tag = node.tagName;

    // نحمي حقول الإدخال فقط أثناء الكتابة فيها حتى لا يتعطّل التنقل في بقية الصفحة
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement === node) {
      return true;
    }

    if (tag === 'VIDEO') return true;

    const role = node.getAttribute('role');
    if (role === 'dialog' || role === 'listbox') return true;

    const overflowX = window.getComputedStyle(node).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 4) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

function Shell({ children, profile, userId, onSignOut, onOpenComments }: { children: ReactNode; profile: Profile | null; userId: string; onSignOut: () => void; onOpenComments: (postId: string) => void }) {
  const [path, setLocation] = useLocation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showNotifsModal, setShowNotifsModal] = useState(false);
  const [showAssistantModal, setShowAssistantModal] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // إخفاء/إظهار الشريطين: يعتمد على اتجاه حركة الإصبع مباشرة
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeHiddenRef = useRef(false);
  const prevChromeHiddenRef = useRef(false);
  const storyRevealTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const setHidden = (hidden: boolean) => {
      if (chromeHiddenRef.current === hidden) return;
      chromeHiddenRef.current = hidden;
      setChromeHidden(hidden);
    };

    let lastTouchY = 0;
    let lastDirection: 0 | 1 | -1 = 0;
    let touching = false;
    let lastTouchMoveAt = 0;
    let lastScrollY = window.scrollY || document.documentElement.scrollTop || 0;

    // 1 = إظهار (إصبع نازل / تمرير للأعلى)، -1 = إخفاء — استجابة فورية بلا عتبة
    const applyDirection = (direction: 1 | -1) => {
      if (direction === lastDirection) return;

      lastDirection = direction;
      setHidden(direction === -1);
    };

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;

      touching = true;
      lastTouchMoveAt = performance.now();
      lastTouchY = touch.clientY;
      lastDirection = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      // لا تعمل حركة إخفاء/إظهار الأشرطة داخل شاشات القصص والواجهات المغطاة
      if (document.body.classList.contains('aani-immersive')) return;

      const touch = event.touches[0];
      if (!touch) return;

      lastTouchMoveAt = performance.now();

      // لا نتدخل أثناء النوافذ والقوائم المفتوحة
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="listbox"]')) return;

      const step = touch.clientY - lastTouchY;
      lastTouchY = touch.clientY;

      // أي حركة نزول — مهما كانت صغيرة أو مائلة — تُظهر، وأي صعود يُخفي
      if (step > 0) applyDirection(1);
      else if (step < 0) applyDirection(-1);
    };

    const onTouchEnd = () => {
      touching = false;
      lastScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    };

    // احتياط: بعض المتصفحات لا تُطلق أحداث اللمس أثناء التمرير، فنستخدم اتجاه التمرير
    let lastScrollToggleAt = 0;
    const onScroll = () => {
      const now = performance.now();

      if (document.body.classList.contains('aani-immersive')) return;
      if (touching && now - lastTouchMoveAt < 120) return;

      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const delta = y - lastScrollY;
      lastScrollY = y;

      // عتبة صغيرة تمنع ارتجاف الارتداد عند حواف الصفحة
      if (Math.abs(delta) < 4) return;
      if (now - lastScrollToggleAt < 90) return;

      lastScrollToggleAt = now;

      if (delta > 0) applyDirection(-1);
      else applyDirection(1);
    };

    // بديل لسطح المكتب: عجلة الفأرة
    const onWheel = (event: WheelEvent) => {
      if (document.body.classList.contains('aani-immersive')) return;
      if (!event.deltaY) return;
      applyDirection(event.deltaY > 0 ? -1 : 1);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  // تمرير حالة الإخفاء إلى شريط القصص عبر كلاس على الصفحة (بدون تغيير منطقها)
  useEffect(() => {
    const wasHidden = prevChromeHiddenRef.current;
    prevChromeHiddenRef.current = chromeHidden;

    document.body.classList.toggle('aani-chrome-hidden', chromeHidden);

    // سلسلة الظهور: الشريط العلوي أولًا، ثم ينبثق شريط القصص من خلفه إلى مكانه
    if (wasHidden && !chromeHidden) {
      document.body.classList.remove('aani-chrome-revealed');
      // إعادة تشغيل الأنيميشن من البداية
      void document.body.offsetWidth;
      document.body.classList.add('aani-chrome-revealed');

      if (storyRevealTimerRef.current) window.clearTimeout(storyRevealTimerRef.current);
      storyRevealTimerRef.current = window.setTimeout(() => {
        document.body.classList.remove('aani-chrome-revealed');
      }, 1000);
    }

    return () => {
      document.body.classList.remove('aani-chrome-hidden');
    };
  }, [chromeHidden]);

  // السحب الأفقي للتنقل بين الصفحات الرئيسية (حركة بصرية فقط)
  const [swipeDirection, setSwipeDirection] = useState<'forward' | 'backward' | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y'; dx: number } | null>(null);
  const swipeTimerRef = useRef<number | null>(null);

  // ترتيب صفحات التنقل بالسحب (نفس مسارات أزرار الشريط السفلي)
  const swipeRoutes = useMemo(() => ['/feed', '/reels', '/search', '/messages', '/profile'], []);

  const getRouteIndex = useCallback(
    (target: string) => {
      const normalized = target === '/' ? '/feed' : target;

      return swipeRoutes.findIndex(route => {
        if (normalized === route) return true;

        // المسارات الفرعية تُحسب ضمن تبويبها (مثل /messages/:id و /profile/:id)
        if (route !== '/feed' && normalized.startsWith(`${route}/`)) return true;

        return false;
      });
    },
    [swipeRoutes],
  );

  const setMainOffset = (offset: number, animated: boolean) => {
    const node = mainRef.current;
    if (!node) return;

    node.style.transition = animated
      ? 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)'
      : 'none';
    node.style.transform = offset === 0 ? '' : `translate3d(${offset}px, 0, 0)`;
  };

  const handleSwipeStart = (event: React.TouchEvent) => {
    // التنقل بالسحب مخصص لتبويبات الشريط السفلي فقط، ولا يعمل داخل شاشات القصص
    if (document.body.classList.contains('aani-immersive')) {
      swipeStartRef.current = null;
      return;
    }

    const target = event.target as HTMLElement | null;

    // لا نلتقط السحب داخل العناصر التي تملك إيماءة أفقية أو حقول الإدخال
    if (isHorizontalGestureArea(target)) {
      swipeStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;

    setMainOffset(0, false);
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY, axis: 'none', dx: 0 };
  };

  const handleSwipeMove = (event: React.TouchEvent) => {
    const start = swipeStartRef.current;
    if (!start || start.axis === 'y') return;

    const touch = event.touches[0];
    if (!touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

    // تحديد نوع الحركة عند أول 6 بكسل، مع إمكانية التصحيح إذا تغيّر الاتجاه
    if (start.axis === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    } else if (start.axis === 'y' && Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 14) {
      start.axis = 'x';
    }

    if (start.axis !== 'x') return;

    start.dx = dx;

    // مقاومة عند حدود البداية والنهاية (السحب من اليسار لليمين = للأمام)
    const index = getRouteIndex(path);
    const atForwardLimit = index >= swipeRoutes.length - 1 && dx > 0;
    const atBackwardLimit = index <= 0 && dx < 0;

    setMainOffset(atForwardLimit || atBackwardLimit ? dx * 0.25 : dx, false);
  };

  const handleSwipeEnd = () => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    const width = window.innerWidth || 360;
    const threshold = Math.max(56, width * 0.18);

    const horizontalSwipe = Boolean(start && start.axis === 'x');
    const shouldNavigate = Boolean(start && start.axis === 'x' && Math.abs(start.dx) >= threshold);
    let navigated = false;

    if (shouldNavigate && start) {
      const index = getRouteIndex(path);

      if (index >= 0) {
        // السحب من اليسار إلى اليمين (dx > 0) يقدّم للأمام، ومن اليمين لليسار يرجع
        const goingForward = start.dx > 0;
        const nextIndex = goingForward ? index + 1 : index - 1;

        if (nextIndex >= 0 && nextIndex < swipeRoutes.length) {
          navigated = true;
          setSwipeDirection(goingForward ? 'forward' : 'backward');
          setLocation(swipeRoutes[nextIndex]);

          // بداية الصفحة الجديدة من الأعلى لتبدو الحركة انتقالًا حقيقيًا
          window.scrollTo({ top: 0, behavior: 'auto' });

          if (swipeTimerRef.current) window.clearTimeout(swipeTimerRef.current);
          swipeTimerRef.current = window.setTimeout(() => setSwipeDirection(null), 420);
        }
      }
    }

    if (navigated) {
      // إزالة التحريك اللحظي فورًا حتى لا يتعارض مع حركة دخول الصفحة الجديدة
      const node = mainRef.current;
      if (node) {
        node.style.transition = 'none';
        node.style.transform = '';
      }
    } else if (horizontalSwipe) {
      // ارتداد ناعم إلى الموضع الأصلي عند عدم بلوغ العتبة
      setMainOffset(0, true);
    }
  };

  const [postText, setPostText] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileType, setFileType] = useState<'image' | 'video' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  // معاينات الملفات: إنشاء الروابط مرة واحدة لكل ملف مع تنظيفها بعد الاستخدام
  const filePreviews = useMemo(
    () => selectedFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [selectedFiles]
  );

  useEffect(() => {
    if (filePreviews.length === 0) return;
    return () => filePreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [filePreviews]);

  useEffect(() => {
    if (!supabaseConfigured || !userId) return;
    void supabase.from('notifications').select('id', { count: 'exact' }).eq('user_id', userId).eq('is_read', false).then(({ count }) => {
      setUnreadCount(count || 0);
    });
  }, [userId, showNotifsModal]);

  const handlePublish = async () => {
    if (!supabaseConfigured) {
      setCreateError('إعدادات الاتصال بقاعدة البيانات غير مكتملة في Secrets.');
      return;
    }

    const content = postText.trim();
    if (!content && selectedFiles.length === 0) return;

    setIsSubmitting(true);
    setCreateError('');
    try {
      const uploadedUrls: string[] = [];
      let type: 'text' | 'photo' | 'reel' = 'text';

      if (selectedFiles.length > 0 && fileType) {
        for (const file of selectedFiles) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
          const uploadedPath = `${userId}/${Date.now()}-${safeName}`;

          const { error: uploadError } = await supabase.storage
            .from(storageBucket)
            .upload(uploadedPath, file, { upsert: true, contentType: file.type });

          if (uploadError) throw new Error(`فشل رفع الملف: ${uploadError.message}`);

          const publicData = supabase.storage.from(storageBucket).getPublicUrl(uploadedPath);
          const publicUrl = publicData?.data?.publicUrl;
          if (publicUrl) uploadedUrls.push(publicUrl);
        }
        type = fileType === 'image' ? 'photo' : 'reel';
      }

      const { error: postError } = await supabase.from('posts').insert({
        user_id: userId,
        content: content || null,
        media_url: uploadedUrls[0] || null,
        media_urls: uploadedUrls.length > 0 ? uploadedUrls : null,
        type,
      });

      if (postError) throw new Error(`فشل حفظ المنشور: ${postError.message}`);

      setPostText('');
      setSelectedFiles([]);
      setFileType(null);
      setShowCreateModal(false);
      window.dispatchEvent(new Event('aani:post-created'));

      if (type === 'reel') {
        setLocation('/reels');
      } else {
        setLocation('/feed');
      }
    } catch (err: any) {
      setCreateError(err.message || 'حدث خطأ غير متوقع أثناء النشر.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const nav = [
    ['/feed', Home, 'الرئيسية', 'feed'],
    ['/reels', Film, 'ريلز', 'reels'],
    ['/search', Search, 'البحث', 'search'],
    ['/messages', MessageCircle, 'الرسائل', 'messages'],
    ['/profile', UserRound, 'ملفي', 'profile'],
  ] as const;

  return (
    <div className="app-frame min-h-screen bg-black text-white">
      <header
        className={`topbar fixed inset-x-0 top-0 z-40 grid grid-cols-3 items-center overflow-hidden border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-md will-change-[transform,opacity] ${
          chromeHidden ? 'is-hidden' : ''
        }`}
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: '0.625rem',
          paddingLeft: '1rem',
          paddingRight: '1rem',
        }}
      >
        <div className="flex items-center justify-start">
          <button className="relative p-2 rounded-full hover:bg-zinc-800 text-zinc-300" onClick={() => setShowNotifsModal(true)}>
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 bg-pink-600 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center justify-center">
          <Link href="/feed" className="brand font-bold text-lg text-white flex items-center gap-1">
            <span className="brand-mark bg-gradient-to-r from-pink-500 to-purple-600 text-white px-2 py-0.5 rounded-lg text-sm">آ</span>
            <span>آني <small className="text-[10px] text-zinc-400 font-normal">Aani</small></span>
          </Link>
        </div>

        <div className="flex items-center justify-end gap-2">
          {path.startsWith('/profile') && (
            <button className="icon-button text-zinc-300" onClick={() => setShowSettingsModal(true)}>
              <Settings size={20} />
            </button>
          )}
          <button className="icon-button bg-pink-600 text-white p-1.5 rounded-full shadow" onClick={() => setShowCreateModal(true)}>
            <Plus size={20} />
          </button>
        </div>
      </header>

      {/* مساحة تعويضية ثابتة للشريط العلوي (بصري فقط) */}
      <div aria-hidden="true" style={{ height: 'calc(3.5rem + env(safe-area-inset-top))' }} />

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <h3 className="font-semibold text-white text-sm">منشور جديد</h3>
              <button className="text-zinc-400" onClick={() => setShowCreateModal(false)}><X size={18} /></button>
            </div>

            <textarea 
              value={postText}
              onChange={(e) => setPostText(e.target.value)}
              placeholder="اكتب شرحاً للمنشور..." 
              className="w-full p-3 border rounded-xl resize-none outline-none bg-zinc-950 border-zinc-800 text-white text-xs" 
              rows={3} 
            />

            {filePreviews.length > 0 && (
              <div className="flex gap-2 overflow-x-auto py-2 no-scrollbar">
                {filePreviews.map((preview, i) => (
                  <div key={preview.url} className="relative w-20 h-20 rounded-xl overflow-hidden border border-zinc-800 shrink-0 bg-black">
                    {fileType === 'image' ? (
                      <img src={preview.url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <video src={preview.url} className="w-full h-full object-cover" />
                    )}
                    <button type="button" onClick={() => setSelectedFiles(files => files.filter((_, idx) => idx !== i))} className="absolute top-1 right-1 bg-black/70 text-white rounded-full p-0.5">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input type="file" id="image-upload" multiple accept="image/*" className="hidden" onChange={(e) => { if (e.target.files) { setSelectedFiles(Array.from(e.target.files)); setFileType('image'); } }} />
            <input type="file" id="video-upload" accept="video/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) { setSelectedFiles([e.target.files[0]]); setFileType('video'); } }} />

            <div className="flex items-center justify-between pt-2 border-t border-zinc-800 text-xs">
              <div className="flex gap-2">
                <label htmlFor="image-upload" className="flex items-center gap-1 px-3 py-2 text-pink-400 bg-pink-950/40 rounded-xl cursor-pointer">
                  <ImagePlus size={15} /> صور
                </label>
                <label htmlFor="video-upload" className="flex items-center gap-1 px-3 py-2 text-purple-400 bg-purple-950/40 rounded-xl cursor-pointer">
                  <Video size={15} /> فيديو
                </label>
              </div>

              <button 
                type="button"
                onClick={() => void handlePublish()}
                disabled={isSubmitting || (!postText.trim() && selectedFiles.length === 0)}
                className="px-5 py-2 bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold"
              >
                {isSubmitting ? 'جاري النشر...' : 'نشر'}
              </button>
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
          </div>
        </div>
      )}

      <SettingsModal isOpen={showSettingsModal} onClose={() => setShowSettingsModal(false)} currentProfile={profile} onSignOut={onSignOut} />
      <NotificationsModal isOpen={showNotifsModal} onClose={() => setShowNotifsModal(false)} currentUserId={userId} />

      {/* زر المساعد الذكي العائم */}
      <button
        onClick={() => setShowAssistantModal(true)}
        className="fixed bottom-20 left-6 z-50 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white p-3.5 rounded-full shadow-2xl flex items-center justify-center transition-transform hover:scale-110 active:scale-95 border border-white/20"
        title="فتح المساعد الذكي"
      >
        <Bot className="w-6 h-6" />
      </button>

      <AIAssistantModal open={showAssistantModal} onClose={() => setShowAssistantModal(false)} />

      <div className="content-shell" style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
        <main
          ref={mainRef}
          className={`main-content ${
            swipeDirection === 'forward'
              ? 'page-slide-forward'
              : swipeDirection === 'backward'
                ? 'page-slide-backward'
                : ''
          }`}
          style={{ touchAction: 'pan-y' }}
          onTouchStart={handleSwipeStart}
          onTouchMove={handleSwipeMove}
          onTouchEnd={handleSwipeEnd}
          onTouchCancel={handleSwipeEnd}
        >
          {children}
        </main>
        <nav
          className={`mobile-nav fixed inset-x-0 bottom-0 z-40 mx-auto flex items-center justify-around gap-1 rounded-full border border-white/10 bg-zinc-900/95 px-3 pt-2 shadow-2xl backdrop-blur-md will-change-[transform,opacity] ${
            chromeHidden ? 'is-hidden' : ''
          }`}
          style={{
            width: 'min(92vw, 26rem)',
            paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))',
          }}
        >
          {nav.map(([href, Icon, label, id]) => {
            const active = path === href || (id === 'profile' && path.startsWith('/profile'));

            return (
              <Link
                key={id}
                href={href}
                className={`flex flex-col items-center gap-1 text-[10px] transition ${active ? 'text-pink-500 font-bold' : 'text-zinc-400'}`}
              >
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
                    active ? 'bg-zinc-200 text-zinc-900' : 'bg-transparent'
                  }`}
                >
                  <Icon size={19} />
                </span>
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
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
          <Shell userId={user.id} profile={profile} onSignOut={() => void signOut()} onOpenComments={(id) => setSelectedPostForComments(id)}>
            <Switch>
              <Route path="/feed"><FeedPage
                userId={user.id}
                profile={profile}
                onOpenComments={(id) => setSelectedPostForComments(id)}
                pendingStoryReshare={pendingStoryReshare}
                onStoryReshareHandled={clearPendingStoryReshare}
                pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                onProfileStoryHandled={clearPendingProfileStory}
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
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}

export default App;
