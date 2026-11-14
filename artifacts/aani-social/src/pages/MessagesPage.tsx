import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'wouter';
import { Archive, ArrowLeft, ArrowRight, Ban, BellOff, Camera, Check, CheckCheck, ChevronDown, ChevronUp, Clock, Copy, Eye, FileText, Flag, Image as ImageIcon, MapPin, Menu, MessageCircle, Mic, MoreVertical, Pause, Pencil, Phone, Pin, Play, Plus, Reply, Search, Send, Smile, Trash2, Video, X } from 'lucide-react';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import { openCallPicker, startCallNow, type CallLogEventDetail, type CallLogOutcome, type CallMode } from '@/components/CallManager';
import ChatImageMessage, { CHAT_MEDIA_MESSAGE_PREFIX, hasViewedOnce, openedChatMediaContent, parseChatMediaMessage } from '@/components/ChatImageMessage';
import ChatMediaPicker, { type PendingChatMediaMessage } from '@/components/ChatMediaPicker';
import MessageAttachmentSheet, { CHAT_DOCUMENT_MESSAGE_PREFIX, CHAT_LOCATION_MESSAGE_PREFIX, parseChatDocumentMessage, parseChatLocationMessage } from '@/components/MessageAttachmentSheet';
import ChatStickerMessage, { CHAT_STICKER_MESSAGE_PREFIX, parseChatStickerMessage, type ChatStickerPayload } from '@/components/ChatStickerMessage';
import ChatStickerPanel from '@/components/ChatStickerPanel';
import EmojiText from '@/components/TwemojiText';
import MessageSwipeReply from '@/components/MessageSwipeReply';
import SharedPostPreview from '@/components/SharedPostPreview';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import StoryReplyCard from '@/components/stories/StoryReplyCard';
import UserIdentity from '@/components/UserIdentity';
import { MessagesSkeleton, ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { storageBucket, supabase, supabaseConfigured, supabaseUrl } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { readSeenStoryIds, SEEN_STORY_IDS_CHANGED_EVENT } from '@/lib/seenStories';
import { displayName, type Profile } from '@/lib/types';

type MessageSendState = 'pending' | 'sent' | 'failed';

interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  post_id: string | null;
  story_id: string | null;
  /** حقول بطاقة رد الستوري المحفوظة مع الرسالة (تظل بعد انتهاء صلاحية الستوري). */
  story_media_url?: string | null;
  story_thumbnail_url?: string | null;
  story_media_type?: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  reply_to_message_id?: string | null;
  sendState?: MessageSendState;
}

interface MessageReaction {
  user_id: string;
  emoji: string;
}

type VoiceRecordingStatus = 'idle' | 'requesting' | 'recording';

interface VoiceMessagePayload {
  url: string;
  durationMs: number;
}

interface VoiceRecordingSession {
  pointerId: number;
  startX: number;
  userId: string;
  recipientId: string;
  replyToMessageId: string | null;
  cancelled: boolean;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number | null;
}

const CHAT_VOICE_MESSAGE_PREFIX = '[aani-audio:v1]';
const CHAT_CALL_MESSAGE_PREFIX = '[aani-call:v1]';

type CallLogMessagePayload = Pick<CallLogEventDetail, 'callId' | 'mode' | 'outcome' | 'durationSeconds'>;

function isCallLogOutcome(value: unknown): value is CallLogOutcome {
  return value === 'completed' || value === 'declined' || value === 'missed' || value === 'busy';
}

function parseCallLogMessage(content: string): CallLogMessagePayload | null {
  if (!content.startsWith(CHAT_CALL_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(CHAT_CALL_MESSAGE_PREFIX.length));
    if (!isRecord(parsed)
      || typeof parsed.callId !== 'string'
      || !parsed.callId.trim()
      || parsed.callId.length > 160
      || (parsed.mode !== 'audio' && parsed.mode !== 'video')
      || !isCallLogOutcome(parsed.outcome)
      || typeof parsed.durationSeconds !== 'number'
      || !Number.isSafeInteger(parsed.durationSeconds)
      || parsed.durationSeconds < 0) return null;
    return {
      callId: parsed.callId,
      mode: parsed.mode,
      outcome: parsed.outcome,
      durationSeconds: parsed.durationSeconds,
    };
  } catch {
    return null;
  }
}

function callLogMessageContent(payload: CallLogMessagePayload): string {
  return `${CHAT_CALL_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

function callLogModeLabel(mode: CallMode): string {
  return mode === 'video' ? 'فيديو' : 'صوتية';
}

function callLogOutcomeLabel(outcome: CallLogOutcome): string {
  if (outcome === 'completed') return 'مكالمة مكتملة';
  if (outcome === 'declined') return 'تم رفض المكالمة';
  if (outcome === 'busy') return 'خط مشغول';
  return 'مكالمة فائتة';
}

function parseVoiceMessage(content: string): VoiceMessagePayload | null {
  if (!content.startsWith(CHAT_VOICE_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(CHAT_VOICE_MESSAGE_PREFIX.length));
    if (!isRecord(parsed) || typeof parsed.url !== 'string' || typeof parsed.durationMs !== 'number' || !Number.isFinite(parsed.durationMs)) return null;
    const url = new URL(parsed.url);
    if (url.protocol === 'blob:') {
      return { url: url.toString(), durationMs: Math.max(0, parsed.durationMs) };
    }
    const storageUrl = new URL(supabaseUrl);
    const storagePath = `/storage/v1/object/public/${storageBucket}/`;
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.origin !== storageUrl.origin
      || !url.pathname.startsWith(storagePath)) return null;
    return { url: url.toString(), durationMs: Math.max(0, parsed.durationMs) };
  } catch {
    return null;
  }
}

function voiceMessageContent(url: string, durationMs: number): string {
  return `${CHAT_VOICE_MESSAGE_PREFIX}${JSON.stringify({ url, durationMs: Math.max(0, Math.round(durationMs)) })}`;
}

function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeVoiceMimeType(value: string): { mimeType: 'audio/mp4' | 'audio/webm'; extension: 'm4a' | 'webm' } | null {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType === 'audio/mp4') return { mimeType, extension: 'm4a' };
  if (mimeType === 'audio/webm') return { mimeType, extension: 'webm' };
  return null;
}

function isMicrophonePermissionDenied(error: unknown): boolean {
  const name = error instanceof Error
    ? error.name
    : isRecord(error) && typeof error.name === 'string'
      ? error.name
      : '';
  const message = error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : '';
  return /^(?:NotAllowedError|PermissionDeniedError|SecurityError)$/i.test(name)
    || /not allowed|permission (?:was )?denied|user denied|dismiss(?:ed|al)?/i.test(message);
}

function VoiceMessagePlayer({ url, durationMs }: VoiceMessagePayload) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const loadingTimeoutRef = useRef<number | null>(null);
  const totalDurationMs = mediaDurationMs || durationMs;

  const clearLoadingTimeout = () => {
    if (loadingTimeoutRef.current !== null) window.clearTimeout(loadingTimeoutRef.current);
    loadingTimeoutRef.current = null;
  };

  const startLoadingTimeout = () => {
    clearLoadingTimeout();
    loadingTimeoutRef.current = window.setTimeout(() => {
      audioRef.current?.pause();
      setIsLoading(false);
      setHasError(true);
      loadingTimeoutRef.current = null;
    }, 15_000);
  };

  useEffect(() => () => {
    if (loadingTimeoutRef.current !== null) window.clearTimeout(loadingTimeoutRef.current);
    // إيقاف الصوت وتفريغ المصدر عند مغادرة الرسالة حتى لا يستمر
    // تشغيل الرسالة الصوتية بعد الخروج من المحادثة.
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* العنصر قد يكون أفلت مرجعه بالفعل */
    }
  }, []);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setHasError(false);
    if (audio.paused) {
      if (hasError) {
        audio.load();
        setCurrentTimeMs(0);
      }
      setIsLoading(true);
      startLoadingTimeout();
      try {
        await audio.play();
      } catch (error) {
        clearLoadingTimeout();
        console.warn('[messages] تعذر تشغيل الرسالة الصوتية:', error);
        setIsLoading(false);
        setIsPlaying(false);
        setHasError(true);
      }
    } else {
      audio.pause();
      clearLoadingTimeout();
      setIsLoading(false);
    }
  };

  const seekPlayback = (value: string) => {
    const nextTimeMs = Number(value);
    if (!Number.isFinite(nextTimeMs)) return;
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration)) {
      try {
        audio.currentTime = nextTimeMs / 1000;
      } catch {
        /* metadata may not be ready yet */
      }
    }
    setCurrentTimeMs(nextTimeMs);
  };

  return (
    <>
      <button
        type="button"
        className={`messages-voice-play${hasError ? ' is-error' : ''}`}
        aria-label={hasError ? 'تعذر تشغيل الرسالة الصوتية، حاول مرة أخرى' : isPlaying ? 'إيقاف الرسالة الصوتية' : 'تشغيل الرسالة الصوتية'}
        onClick={() => { void togglePlayback(); }}
      >
        {isLoading ? <span className="messages-voice-spinner" aria-hidden="true" /> : isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <div className="messages-voice-timeline">
        <time className="messages-voice-elapsed" dir="ltr">{formatVoiceDuration(currentTimeMs)}</time>
        <input
          className="messages-voice-progress"
          type="range"
          min={0}
          max={Math.max(1, totalDurationMs)}
          step={100}
          value={Math.min(currentTimeMs, totalDurationMs)}
          disabled={!mediaDurationMs || hasError}
          aria-label="موضع الرسالة الصوتية"
          aria-valuetext={`${formatVoiceDuration(currentTimeMs)} من ${formatVoiceDuration(totalDurationMs)}`}
          onChange={event => seekPlayback(event.target.value)}
        />
        <time className="messages-voice-duration" dir="ltr">{formatVoiceDuration(totalDurationMs)}</time>
      </div>
      <audio
        ref={audioRef}
        className="messages-voice-hidden-audio"
        preload="none"
        src={url}
        aria-hidden="true"
        tabIndex={-1}
        onPlay={() => { setIsPlaying(true); setHasError(false); }}
        onPlaying={() => { clearLoadingTimeout(); setIsLoading(false); }}
        onWaiting={() => { setIsLoading(true); startLoadingTimeout(); }}
        onCanPlay={() => { clearLoadingTimeout(); setIsLoading(false); }}
        onPause={() => { clearLoadingTimeout(); setIsPlaying(false); setIsLoading(false); }}
        onTimeUpdate={event => setCurrentTimeMs(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={event => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) setMediaDurationMs(duration * 1000);
        }}
        onDurationChange={event => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) setMediaDurationMs(duration * 1000);
        }}
        onEnded={() => { clearLoadingTimeout(); setIsPlaying(false); setIsLoading(false); setCurrentTimeMs(0); }}
        onError={() => { clearLoadingTimeout(); setIsPlaying(false); setIsLoading(false); setHasError(true); }}
      />
    </>
  );
}

interface MessageActionState {
  message: MessageRow;
  mode: 'actions' | 'delete';
  rect: { top: number; left: number; width: number; height: number };
  rowMarkup: string;
  menuTop: number;
  menuLeft: number;
  reactionsTop: number;
  reactionsLeft: number;
}

type MessageRequestStatus = 'pending' | 'accepted' | 'declined';

interface ConversationSummary {
  profile: Profile;
  lastMessage: MessageRow | null;
  hasStory: boolean;
  hasUnseenStory: boolean;
  isRequest: boolean;
  requestRecipientId: string | null;
  requestStatus: MessageRequestStatus | null;
}

function isConversationRequestLocked(conversation: ConversationSummary | null | undefined): boolean {
  return Boolean(conversation && (
    conversation.isRequest
    || (conversation.requestStatus !== null && conversation.requestStatus !== 'accepted')
  ));
}

type InboxTab = 'messages' | 'requests';

type ConversationPreferences = {
  pinnedIds: string[];
  archivedIds: string[];
  mutedIds: string[];
};

type ConversationPreferenceKey = keyof ConversationPreferences;

type ConversationContextState = {
  conversation: ConversationSummary;
  rect: { top: number; left: number; width: number; height: number };
  menuTop: number;
  menuRight: number;
};

type ConversationSheetView = 'menu' | 'timer';
type ConversationGalleryView = 'media' | 'shares';
type ConversationGalleryPreview =
  | { kind: 'media'; messageId: string; url: string; caption: string }
  | { kind: 'post'; messageId: string; postId: string; content: string };

const MESSAGE_EXPIRATION_OPTIONS: Array<{ seconds: number | null; label: string }> = [
  { seconds: 3600, label: '1 ساعة' },
  { seconds: 5 * 3600, label: '5 ساعات' },
  { seconds: 10 * 3600, label: '10 ساعات' },
  { seconds: 24 * 3600, label: '24 ساعة' },
  { seconds: 7 * 24 * 3600, label: '7 أيام' },
  { seconds: null, label: 'إيقاف المؤقت' },
];
const GLOBAL_MESSAGE_EXPIRATION_OPTIONS: Array<{ seconds: number | null; label: string }> = [
  { seconds: null, label: 'إيقاف التشغيل' },
  { seconds: 24 * 3600, label: '24 ساعة' },
  { seconds: 7 * 24 * 3600, label: '7 أيام' },
  { seconds: 90 * 24 * 3600, label: '90 يوماً' },
];

const PROFILE_FIELDS = 'id, username, full_name, display_name, avatar_url';
const EMPTY_CONVERSATION_PREFERENCES: ConversationPreferences = {
  pinnedIds: [],
  archivedIds: [],
  mutedIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConversationPreferences(userId: string): ConversationPreferences {
  if (typeof window === 'undefined') return EMPTY_CONVERSATION_PREFERENCES;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`aani_message_preferences_${userId}`) || '{}');
    if (!isRecord(stored)) return EMPTY_CONVERSATION_PREFERENCES;
    const readIds = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    return {
      pinnedIds: readIds(stored.pinnedIds),
      archivedIds: readIds(stored.archivedIds),
      mutedIds: readIds(stored.mutedIds),
    };
  } catch {
    return EMPTY_CONVERSATION_PREFERENCES;
  }
}

function writeConversationPreferences(userId: string, preferences: ConversationPreferences): void {
  try {
    localStorage.setItem(`aani_message_preferences_${userId}`, JSON.stringify(preferences));
  } catch {
    /* التخزين المحلي غير متاح */
  }
}

function updatePreferenceList(
  preferences: ConversationPreferences,
  key: ConversationPreferenceKey,
  contactId: string,
  enabled: boolean,
): ConversationPreferences {
  const ids = new Set(preferences[key]);
  if (enabled) ids.add(contactId);
  else ids.delete(contactId);
  return { ...preferences, [key]: [...ids] };
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : '';
  return error instanceof TypeError || /load failed|failed to fetch|network error|network request failed|connection (?:reset|closed|refused)|timed? out|timeout/i.test(message);
}

async function retrySupabaseQuery<T>(query: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await query();
      const error = isRecord(result) && 'error' in result ? result.error : null;
      if (!isTransientNetworkError(error) || attempt === maxAttempts - 1) return result;
    } catch (error) {
      if (!isTransientNetworkError(error) || attempt === maxAttempts - 1) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('تعذر الاتصال بالخادم.');
}

async function loadHiddenMessageIds(userId: string): Promise<Set<string>> {
  const { data, error } = await retrySupabaseQuery(async () => await supabase
    .from('message_hides')
    .select('message_id')
    .eq('user_id', userId));
  if (error) {
    console.warn('[messages] تعذر جلب الرسائل المخفية:', error);
    return new Set();
  }
  return new Set((data || []).flatMap(row => typeof row.message_id === 'string' ? [row.message_id] : []));
}

function normalizeMessageRows(value: unknown): MessageRow[] {
  if (!Array.isArray(value)) return [];

  return (value as unknown[]).flatMap((item: unknown) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.sender_id !== 'string'
      || typeof item.recipient_id !== 'string') {
      return [];
    }

    return [{
      id: item.id,
      sender_id: item.sender_id,
      recipient_id: item.recipient_id,
      content: typeof item.content === 'string' ? item.content : '',
      post_id: typeof item.post_id === 'string' ? item.post_id : null,
      story_id: typeof item.story_id === 'string' ? item.story_id : null,
      story_media_url: typeof item.story_media_url === 'string' ? item.story_media_url : null,
      story_thumbnail_url: typeof item.story_thumbnail_url === 'string' ? item.story_thumbnail_url : null,
      story_media_type: typeof item.story_media_type === 'string' ? item.story_media_type : null,
      created_at: typeof item.created_at === 'string' ? item.created_at : '',
      delivered_at: typeof item.delivered_at === 'string' ? item.delivered_at : null,
      read_at: typeof item.read_at === 'string' ? item.read_at : null,
      reply_to_message_id: typeof item.reply_to_message_id === 'string' ? item.reply_to_message_id : null,
    }];
  });
}

interface CachedMessageThread {
  messages: MessageRow[];
  reactionsByMessage: Record<string, MessageReaction[]>;
}

const conversationCacheKey = (userId: string) => `aani_messages_conversations_v1_${userId}`;
const threadCacheKey = (userId: string, contactId: string) => `aani_messages_thread_v1_${userId}_${contactId}`;
const MESSAGE_THREAD_CACHE_LIMIT = 300;

function readConversationCache(userId: string): ConversationSummary[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(conversationCacheKey(userId));
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return null;
    return stored.flatMap((item): ConversationSummary[] => {
      if (!isRecord(item) || !isRecord(item.profile) || typeof item.profile.id !== 'string') return [];
      const lastMessage = item.lastMessage === null ? null : normalizeMessageRows([item.lastMessage])[0] || null;
      return [{
        profile: item.profile as unknown as Profile,
        lastMessage,
        hasStory: item.hasStory === true,
        hasUnseenStory: item.hasUnseenStory === true,
        isRequest: item.isRequest === true,
        requestRecipientId: typeof item.requestRecipientId === 'string' ? item.requestRecipientId : null,
        requestStatus: item.requestStatus === 'pending' || item.requestStatus === 'accepted' || item.requestStatus === 'declined'
          ? item.requestStatus
          : null,
      }];
    });
  } catch {
    return null;
  }
}

function readThreadCache(userId: string, contactId: string): CachedMessageThread | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(threadCacheKey(userId, contactId));
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored) || !Array.isArray(stored.messages)) return null;
    const messages = normalizeMessageRows(stored.messages).slice(-MESSAGE_THREAD_CACHE_LIMIT);
    const messageIds = new Set(messages.map(message => message.id));
    const reactionsByMessage: Record<string, MessageReaction[]> = {};
    if (Array.isArray(stored.reactions)) {
      stored.reactions.forEach((item: unknown) => {
        if (!isRecord(item)
          || typeof item.message_id !== 'string'
          || typeof item.user_id !== 'string'
          || typeof item.emoji !== 'string'
          || !messageIds.has(item.message_id)) return;
        (reactionsByMessage[item.message_id] ||= []).push({ user_id: item.user_id, emoji: item.emoji });
      });
    }
    return { messages, reactionsByMessage };
  } catch {
    return null;
  }
}

function writeConversationCache(userId: string, conversations: ConversationSummary[]): void {
  try {
    localStorage.setItem(conversationCacheKey(userId), JSON.stringify(conversations));
  } catch {
    /* التخزين المحلي غير متاح أو ممتلئ */
  }
}

function writeThreadCache(
  userId: string,
  contactId: string,
  messages: MessageRow[],
  reactionsByMessage: Record<string, MessageReaction[]>,
): void {
  const cachedMessages = messages
    .filter(message => message.sendState !== 'pending' && message.sendState !== 'failed')
    .slice(-MESSAGE_THREAD_CACHE_LIMIT);
  const messageIds = new Set(cachedMessages.map(message => message.id));
  const reactions = Object.entries(reactionsByMessage).flatMap(([messageId, rows]) => (
    messageIds.has(messageId)
      ? rows.map(reaction => ({ message_id: messageId, user_id: reaction.user_id, emoji: reaction.emoji }))
      : []
  ));
  try {
    localStorage.setItem(threadCacheKey(userId, contactId), JSON.stringify({ messages: cachedMessages, reactions }));
  } catch {
    /* التخزين المحلي غير متاح أو ممتلئ */
  }
}

function messageDeliveryErrorText(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : '';
}

async function queryMessageRows(
  filter: string,
  ascending: boolean,
  includeMetadata = false,
): Promise<{ data: unknown; error: unknown | null }> {
  let includeDeliveryColumns = true;
  let includeMessageMetadata = includeMetadata;
  let includeReplyMetadata = includeMetadata;
  let includeStoryReplyMedia = includeMetadata;

  // الحد الأقصى للمحاولات يغطي إسقاط كل مجموعة أعمدة اختيارية بالتتابع.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const fields = `id, sender_id, recipient_id, content${includeMessageMetadata ? ', post_id, story_id' : ''}${includeStoryReplyMedia ? ', story_media_url, story_thumbnail_url, story_media_type' : ''}${includeReplyMetadata ? ', reply_to_message_id' : ''}, created_at${includeDeliveryColumns ? ', delivered_at, read_at' : ''}`;
    const result = await retrySupabaseQuery(async () => await supabase
      .from('messages')
      .select(fields)
      .or(filter)
      .order('created_at', { ascending }));
    if (!result.error) return { data: result.data, error: null };

    const errorText = messageDeliveryErrorText(result.error);
    if (includeDeliveryColumns && /delivered_at|read_at/i.test(errorText)) {
      includeDeliveryColumns = false;
      continue;
    }
    if (includeStoryReplyMedia && /story_media_url|story_thumbnail_url|story_media_type/i.test(errorText)) {
      includeStoryReplyMedia = false;
      continue;
    }
    if (includeReplyMetadata && /reply_to_message_id/i.test(errorText)) {
      includeReplyMetadata = false;
      continue;
    }
    if (includeMessageMetadata && /post_id|story_id/i.test(errorText)) {
      includeMessageMetadata = false;
      continue;
    }
    return { data: null, error: result.error };
  }

  return { data: null, error: new Error('تعذر تحميل الرسائل.') };
}

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function mergeThreadRows(existing: MessageRow[], incoming: MessageRow[]): MessageRow[] {
  const messages = new Map(existing.map(message => [message.id, message]));
  incoming.forEach(message => messages.set(message.id, message));
  return [...messages.values()].sort((left, right) => (
    (Date.parse(left.created_at) || 0) - (Date.parse(right.created_at) || 0)
  ));
}

function isEditableTextMessage(message: MessageRow): boolean {
  const content = message.content.trim();
  return Boolean(content)
    && !message.post_id
    && !message.story_id
    && !message.story_media_url
    && !message.story_thumbnail_url
    && !message.story_media_type
    && !parseVoiceMessage(content)
    && !parseChatMediaMessage(content)
    && !parseChatStickerMessage(content)
    && !parseChatDocumentMessage(content)
    && !parseChatLocationMessage(content)
    && !content.startsWith(CHAT_VOICE_MESSAGE_PREFIX)
    && !content.startsWith(CHAT_STICKER_MESSAGE_PREFIX)
    && !content.startsWith(CHAT_DOCUMENT_MESSAGE_PREFIX)
    && !content.startsWith(CHAT_LOCATION_MESSAGE_PREFIX)
    && !content.startsWith(CHAT_CALL_MESSAGE_PREFIX)
    && !content.startsWith('[story:')
    && !content.startsWith('[story-reply]')
    && !content.startsWith('[post:');
}

function MessageDeliveryStatus({ message }: { message: MessageRow }) {
  if (message.sendState === 'pending') {
    return <span className="messages-delivery-status is-pending" role="img" aria-label="قيد الإرسال" title="قيد الإرسال"><Clock /></span>;
  }
  if (message.sendState === 'failed') {
    return <span className="messages-delivery-status is-failed" role="img" aria-label="تعذر الإرسال" title="تعذر الإرسال"><X /></span>;
  }
  if (message.read_at) {
    return <span className="messages-delivery-status is-read" role="img" aria-label="تمت القراءة" title="تمت القراءة"><CheckCheck /></span>;
  }
  if (message.delivered_at) {
    return <span className="messages-delivery-status" role="img" aria-label="تم التوصيل" title="تم التوصيل"><CheckCheck /></span>;
  }
  return <span className="messages-delivery-status" role="img" aria-label="تم الإرسال" title="تم الإرسال"><Check /></span>;
}

function readConversationReadTimes(userId: string): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`aani_message_read_at_${userId}`) || '{}');
    if (!isRecord(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function readRequestTabReadAt(userId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(`aani_message_requests_read_at_${userId}`);
  } catch {
    return null;
  }
}

const LEGACY_STORY_REPLY_PREFIX = '[story-reply]';

function isLegacyStoryReplyContent(content: string): boolean {
  return content.trimStart().startsWith(LEGACY_STORY_REPLY_PREFIX);
}

function hasStoredStoryReplyMedia(message: MessageRow): boolean {
  return Boolean(message.story_media_url || message.story_thumbnail_url || message.story_media_type);
}

/** نص الرد وحده، دون الوسم القديم [story-reply]. */
function storyReplyText(message: MessageRow): string {
  const content = message.content.trim();
  return isLegacyStoryReplyContent(content)
    ? content.slice(LEGACY_STORY_REPLY_PREFIX.length).trim()
    : content;
}

/**
 * رد ستوري حقيقي: الوسم القديم، أو حقول معاينة ستوري محفوظة مع الرسالة
 * (البيانات الموثوقة). مشاركة الستوري العادية [story:...] ليست رداً.
 */
function isStoryReplyMessage(message: MessageRow): boolean {
  if (message.post_id) return false;
  const content = message.content.trim();
  if (isLegacyStoryReplyContent(content)) return true;
  if (content.startsWith('[story:')) return false;
  return hasStoredStoryReplyMedia(message);
}

function messagePreview(message: MessageRow | null, currentUserId: string): string {
  if (!message) return 'ابدأ محادثة جديدة';
  const content = message.content.trim();
  const mediaMessage = parseChatMediaMessage(content);
  const stickerMessage = parseChatStickerMessage(content);
  const voiceMessage = parseVoiceMessage(content);
  const callLog = parseCallLogMessage(content);
  const documentMessage = parseChatDocumentMessage(content);
  const locationMessage = parseChatLocationMessage(content);
  let preview = content;
  if (stickerMessage) preview = 'ملصق';
  else if (voiceMessage) preview = 'رسالة صوتية';
  else if (callLog) preview = callLog.outcome === 'completed'
    ? `مكالمة ${callLogModeLabel(callLog.mode)} · ${formatVoiceDuration(callLog.durationSeconds * 1000)}`
    : `${callLogOutcomeLabel(callLog.outcome)} · ${callLogModeLabel(callLog.mode)}`;
  else if (content.startsWith(CHAT_CALL_MESSAGE_PREFIX)) preview = 'سجل مكالمة';
  else if (documentMessage) preview = `مستند: ${documentMessage.name}`;
  else if (locationMessage) preview = locationMessage.note ? `موقع: ${locationMessage.note}` : 'موقع';
  else if (mediaMessage) {
    const hasOpened = mediaMessage.opened || hasViewedOnce(currentUserId, message.id);
    preview = mediaMessage.viewOnce
      ? (hasOpened ? 'صورة مؤقتة · تم الفتح' : 'صورة مؤقتة')
      : mediaMessage.caption || (mediaMessage.urls.length > 1 ? 'صور' : 'صورة');
  } else if (message.post_id || content.startsWith('[post:')) preview = 'مشاركة منشور';
  else if (isStoryReplyMessage(message)) preview = storyReplyText(message) || 'رد على قصة';
  else if (content.startsWith('[story:')) preview = 'أرسل قصة';
  else if (!preview) preview = 'رسالة';
  return message.sender_id === currentUserId ? `أنت: ${preview}` : preview;
}

function replyMessagePreview(message: MessageRow): string {
  const content = message.content.trim();
  const mediaMessage = parseChatMediaMessage(content);
  const stickerMessage = parseChatStickerMessage(content);
  const voiceMessage = parseVoiceMessage(content);
  const callLog = parseCallLogMessage(content);
  const documentMessage = parseChatDocumentMessage(content);
  const locationMessage = parseChatLocationMessage(content);
  let preview = content;
  if (stickerMessage) preview = 'ملصق';
  else if (voiceMessage) preview = 'رسالة صوتية';
  else if (callLog) preview = callLog.outcome === 'completed'
    ? `مكالمة ${callLogModeLabel(callLog.mode)} · ${formatVoiceDuration(callLog.durationSeconds * 1000)}`
    : `${callLogOutcomeLabel(callLog.outcome)} · ${callLogModeLabel(callLog.mode)}`;
  else if (content.startsWith(CHAT_CALL_MESSAGE_PREFIX)) preview = 'سجل مكالمة';
  else if (documentMessage) preview = `مستند: ${documentMessage.name}`;
  else if (locationMessage) preview = locationMessage.note ? `موقع: ${locationMessage.note}` : 'موقع';
  else if (mediaMessage) {
    preview = mediaMessage.viewOnce
      ? 'صورة مؤقتة'
      : mediaMessage.caption || (mediaMessage.urls.length > 1 ? 'صور' : 'صورة');
  } else if (message.post_id || content.startsWith('[post:')) preview = 'مشاركة منشور';
  else if (isStoryReplyMessage(message)) preview = storyReplyText(message) || 'رد على قصة';
  else if (content.startsWith('[story:')) preview = 'أرسل قصة';
  else if (!preview) preview = 'رسالة';
  return preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
}

function isVideoMediaUrl(url: string): boolean {
  try {
    return /\.(?:mp4|mov|webm|m4v)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function chatMediaStoragePath(url: string): string | null {
  try {
    const objectUrl = new URL(url);
    const pathPrefix = `/storage/v1/object/public/${storageBucket}/`;
    if (!objectUrl.pathname.startsWith(pathPrefix)) return null;
    return decodeURIComponent(objectUrl.pathname.slice(pathPrefix.length));
  } catch {
    return null;
  }
}

function formatConversationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'الآن';
  if (elapsedMinutes < 60) return `${elapsedMinutes}د`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}س`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}ي`;
  return new Intl.DateTimeFormat('ar', { month: 'numeric', day: 'numeric' }).format(date);
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميغابايت`;
}

export default function MessagesPage({
  currentUserId,
  selectedId,
  onReshareStory,
  onOpenStories,
}: {
  currentUserId: string;
  selectedId?: string;
  onReshareStory: (story: StoryDmCardStory) => void;
  onOpenStories: (profileId: string) => void;
}) {
  const [, setLocation] = useLocation();
  const [initialConversationCache] = useState(() => readConversationCache(currentUserId));
  const [initialThreadCache] = useState(() => selectedId ? readThreadCache(currentUserId, selectedId) : null);
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>(() => initialConversationCache || []);
  const [conversationCacheReady, setConversationCacheReady] = useState(initialConversationCache !== null);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [thread, setThread] = useState<MessageRow[]>(() => initialThreadCache?.messages || []);
  const [threadCacheReady, setThreadCacheReady] = useState(Boolean(initialThreadCache));
  const [replyMessage, setReplyMessage] = useState<MessageRow | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageRow | null>(null);
  const [pendingMediaMessage, setPendingMediaMessage] = useState<PendingChatMediaMessage | null>(null);
  const [voiceRecordingStatus, setVoiceRecordingStatus] = useState<VoiceRecordingStatus>('idle');
  const [voiceRecordingElapsedMs, setVoiceRecordingElapsedMs] = useState(0);
  const [reactionsByMessage, setReactionsByMessage] = useState<Record<string, MessageReaction[]>>(() => initialThreadCache?.reactionsByMessage || {});
  const [messageAction, setMessageAction] = useState<MessageActionState | null>(null);
  const [emojiTargetMessage, setEmojiTargetMessage] = useState<MessageRow | null>(null);
  const [messageDeleteBusy, setMessageDeleteBusy] = useState(false);
  const [messageModerationBusy, setMessageModerationBusy] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiPickerClosing, setEmojiPickerClosing] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [threadOptionsOpen, setThreadOptionsOpen] = useState(false);
  const [threadOptionsView, setThreadOptionsView] = useState<ConversationSheetView>('menu');
  const [galleryView, setGalleryView] = useState<ConversationGalleryView | null>(null);
  const [galleryPreview, setGalleryPreview] = useState<ConversationGalleryPreview | null>(null);
  const [galleryForwardOpen, setGalleryForwardOpen] = useState(false);
  const [forwardRecipientId, setForwardRecipientId] = useState('');
  const [forwardBusy, setForwardBusy] = useState(false);
  const [messageExpirationSeconds, setMessageExpirationSeconds] = useState<number | null>(null);
  const [expirationSaving, setExpirationSaving] = useState(false);
  const [globalExpirationSeconds, setGlobalExpirationSeconds] = useState<number | null>(null);
  const [globalExpirationLoading, setGlobalExpirationLoading] = useState(false);
  const [globalExpirationSaving, setGlobalExpirationSaving] = useState(false);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [threadSearchIndex, setThreadSearchIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<InboxTab>('messages');
  const [searchTerm, setSearchTerm] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [globalMenuOpen, setGlobalMenuOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastSelectedIds, setBroadcastSelectedIds] = useState<Set<string>>(() => new Set());
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [mutualFollowers, setMutualFollowers] = useState<Profile[]>([]);
  const [mutualFollowersLoading, setMutualFollowersLoading] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [globalTimerOpen, setGlobalTimerOpen] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());
  const [readAtByContact, setReadAtByContact] = useState<Record<string, string>>(() => readConversationReadTimes(currentUserId));
  const [requestUnreadByContact, setRequestUnreadByContact] = useState<Record<string, number>>({});
  const [requestActionBusy, setRequestActionBusy] = useState(false);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [newMessageSearch, setNewMessageSearch] = useState('');
  const [newMessageProfiles, setNewMessageProfiles] = useState<Profile[]>([]);
  const [newMessageLoading, setNewMessageLoading] = useState(false);
  const [newMessageError, setNewMessageError] = useState<string | null>(null);
  const [conversationPreferences, setConversationPreferences] = useState<ConversationPreferences>(() => readConversationPreferences(currentUserId));
  const [conversationContext, setConversationContext] = useState<ConversationContextState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [moderationBusy, setModerationBusy] = useState(false);
  const threadRequestRef = useRef(0);
  const contactsRequestRef = useRef(0);
  // معرّفات القصص النشطة لكل جهة اتصال: تُستخدم لتحديث حلقة «غير مشاهد»
  // فور مشاهدة القصص في شريط القصص دون إعادة تحميل قائمة المحادثات.
  const storyIdsByContactRef = useRef<Record<string, string[]>>({});
  const requestTabReadAtRef = useRef(readRequestTabReadAt(currentUserId));
  const readAtByContactRef = useRef(readAtByContact);
  readAtByContactRef.current = readAtByContact;
  const selectedIdRef = useRef(selectedId);
  const messagesViewRef = useRef<HTMLElement>(null);
  const threadListRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const sheetDragStartYRef = useRef<number | null>(null);
  const editingMessageRef = useRef(editingMessage);
  editingMessageRef.current = editingMessage;
  const messageComposerRef = useRef<HTMLFormElement>(null);
  const voiceCancelButtonRef = useRef<HTMLButtonElement>(null);
  const voiceRecordingSessionRef = useRef<VoiceRecordingSession | null>(null);
  const voiceRecordingTimerRef = useRef<number | null>(null);
  const voiceObjectUrlsRef = useRef(new Set<string>());
  const voiceScrollLockRef = useRef(new Set<string>());
  const voiceScrollConfirmedRef = useRef(new Set<string>());
  const deletedMessageIdsRef = useRef(new Set<string>());
  const threadScrollTouchOriginRef = useRef<{ x: number; y: number } | null>(null);
  const emojiPickerCloseTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextConversationClickRef = useRef(false);
  const reactionsByMessageRef = useRef(reactionsByMessage);
  const reactionMutationVersionRef = useRef(new Map<string, number>());
  const pendingReactionByMessageRef = useRef(new Map<string, { version: number; emoji: string | null }>());
  const reactionWriteQueueRef = useRef(new Map<string, Promise<void>>());
  const messageActionOpenedAtRef = useRef(0);
  const commitReactionsByMessage = useCallback((next: Record<string, MessageReaction[]>) => {
    reactionsByMessageRef.current = next;
    setReactionsByMessage(next);
  }, []);

  useLayoutEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { setAttachmentOpen(false); }, [selectedId]);

  useEffect(() => () => {
    if (emojiPickerCloseTimerRef.current !== null) window.clearTimeout(emojiPickerCloseTimerRef.current);
    if (voiceRecordingTimerRef.current !== null) window.clearInterval(voiceRecordingTimerRef.current);
    const session = voiceRecordingSessionRef.current;
    if (session) {
      session.cancelled = true;
      try {
        if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
      } catch {
        /* recorder already stopped */
      }
      session.stream?.getTracks().forEach(track => track.stop());
      voiceRecordingSessionRef.current = null;
    }
    voiceObjectUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    voiceObjectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!messageAction) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMessageAction(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [messageAction]);

  useEffect(() => {
    if (!threadOptionsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThreadOptionsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [threadOptionsOpen]);

  useEffect(() => {
    if (!globalMenuOpen && !broadcastOpen && !archivedOpen && !globalTimerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setGlobalMenuOpen(false);
      setBroadcastOpen(false);
      setArchivedOpen(false);
      setGlobalTimerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [archivedOpen, broadcastOpen, globalMenuOpen, globalTimerOpen]);

  useEffect(() => {
    if (!galleryView) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [galleryView]);

  useEffect(() => {
    if (!galleryView) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (galleryForwardOpen) {
        setGalleryForwardOpen(false);
        setForwardRecipientId('');
      } else if (galleryPreview) setGalleryPreview(null);
      else setGalleryView(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [galleryForwardOpen, galleryPreview, galleryView]);

  useEffect(() => {
    if (!threadSearchOpen) return;
    window.requestAnimationFrame(() => threadSearchInputRef.current?.focus());
  }, [threadSearchOpen]);

  useEffect(() => {
    setConversationPreferences(readConversationPreferences(currentUserId));
  }, [currentUserId]);

  useEffect(() => {
    if (!conversationCacheReady) return;
    writeConversationCache(currentUserId, conversations);
  }, [conversationCacheReady, conversations, currentUserId]);

  useEffect(() => {
    const handleMediaCaptionUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ caption?: string }>).detail;
      setText(typeof detail?.caption === 'string' ? detail.caption : '');
    };
    window.addEventListener('aani-chat-media-caption-update', handleMediaCaptionUpdate);
    return () => window.removeEventListener('aani-chat-media-caption-update', handleMediaCaptionUpdate);
  }, []);

  const markConversationRead = useCallback((contactId: string) => {
    const readAt = new Date().toISOString();
    const nextReadTimes = { ...readAtByContactRef.current, [contactId]: readAt };
    readAtByContactRef.current = nextReadTimes;
    setReadAtByContact(nextReadTimes);
    try {
      localStorage.setItem(`aani_message_read_at_${currentUserId}`, JSON.stringify(nextReadTimes));
    } catch {
      /* التخزين المحلي غير متاح */
    }
    setRequestUnreadByContact(current => {
      if (!(contactId in current)) return current;
      const next = { ...current };
      delete next[contactId];
      return next;
    });
    if (supabaseConfigured) {
      void (async () => {
        try {
          const { error } = await supabase.rpc('aani_mark_conversation_read', { p_sender_id: contactId });
          if (error) console.warn('[messages] تعذر تحديث حالة القراءة:', error);
        } catch (error) {
          console.warn('[messages] تعذر تحديث حالة القراءة:', error);
        }
      })();
    }
  }, [currentUserId]);

  const markRequestsTabSeen = () => {
    const readAt = new Date().toISOString();
    requestTabReadAtRef.current = readAt;
    setRequestUnreadByContact({});
    try {
      localStorage.setItem(`aani_message_requests_read_at_${currentUserId}`, readAt);
    } catch {
      /* التخزين المحلي غير متاح */
    }
  };

  const purgeExpiredMessages = useCallback(async () => {
    if (!supabaseConfigured) return;
    try {
      const { data, error } = await supabase.rpc('aani_purge_expired_messages');
      if (error) {
        console.warn('[messages] تعذر تنظيف الرسائل المؤقتة المنتهية:', error);
        return;
      }
      const expiredIds = Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : [];
      if (expiredIds.length) {
        expiredIds.forEach(id => deletedMessageIdsRef.current.add(id));
        const expiredIdSet = new Set(expiredIds);
        setThread(current => current.filter(message => !expiredIdSet.has(message.id)));
      }
    } catch (error) {
      console.warn('[messages] تعذر تنظيف الرسائل المؤقتة المنتهية:', error);
    }
  }, []);

  const markMessagesDelivered = useCallback(async (messageIds: string[]) => {
    if (!supabaseConfigured || messageIds.length === 0) return;
    for (let offset = 0; offset < messageIds.length; offset += 200) {
      try {
        const { error } = await supabase.rpc('aani_mark_messages_delivered', {
          p_message_ids: messageIds.slice(offset, offset + 200),
        });
        if (error) console.warn('[messages] تعذر تحديث حالة التوصيل:', error);
      } catch (error) {
        console.warn('[messages] تعذر تحديث حالة التوصيل:', error);
      }
    }
  }, []);

  useLayoutEffect(() => {
    const input = messageInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    input.scrollTop = input.scrollHeight;
  }, [text, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const viewport = window.visualViewport;
    const syncVisualViewport = () => {
      const view = messagesViewRef.current;
      if (!view) return;
      view.style.setProperty('--messages-visual-viewport-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`);
      view.style.setProperty('--messages-visual-viewport-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
    };

    syncVisualViewport();
    viewport?.addEventListener('resize', syncVisualViewport);
    viewport?.addEventListener('scroll', syncVisualViewport);
    window.addEventListener('resize', syncVisualViewport);
    return () => {
      viewport?.removeEventListener('resize', syncVisualViewport);
      viewport?.removeEventListener('scroll', syncVisualViewport);
      window.removeEventListener('resize', syncVisualViewport);
    };
  }, [selectedId]);

  const loadConversationList = useCallback(async () => {
    const requestId = ++contactsRequestRef.current;
    if (!supabaseConfigured) {
      setCurrentProfile(null);
      setConversations([]);
      setMutualFollowers([]);
      setMutualFollowersLoading(false);
      return;
    }

    setContactsError(null);
    setMutualFollowersLoading(true);
    try {
      await purgeExpiredMessages();
      const [profileResult, messagesResult, followsResult, hiddenMessageIds, requestStatesResult] = await Promise.all([
        retrySupabaseQuery(async () => await supabase.from('profiles').select(PROFILE_FIELDS).eq('id', currentUserId).maybeSingle()),
        queryMessageRows(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`, false),
        retrySupabaseQuery(async () => await supabase
          .from('follows')
          .select('follower_id, following_id')
          .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`)),
        loadHiddenMessageIds(currentUserId),
        retrySupabaseQuery(async () => await supabase
          .from('message_conversation_requests')
          .select('participant_one_id, participant_two_id, recipient_id, status')
          .or(`participant_one_id.eq.${currentUserId},participant_two_id.eq.${currentUserId}`)),
      ]);

      if (requestId !== contactsRequestRef.current) return;
      if (profileResult.error) throw profileResult.error;
      if (messagesResult.error) throw messagesResult.error;
      if (followsResult.error) throw followsResult.error;
      setCurrentProfile((profileResult.data || null) as Profile | null);

      const latestByContact = new Map<string, MessageRow>();
      const conversationMessages = normalizeMessageRows(messagesResult.data)
        .filter(message => !hiddenMessageIds.has(message.id));
      void markMessagesDelivered(conversationMessages
        .filter(message => message.recipient_id === currentUserId && !message.delivered_at)
        .map(message => message.id));
      conversationMessages.forEach(message => {
        const contactId = message.sender_id === currentUserId ? message.recipient_id : message.sender_id;
        const mediaMessage = parseChatMediaMessage(message.content);
        const safeMessage = mediaMessage?.viewOnce && (mediaMessage.opened || hasViewedOnce(currentUserId, message.id))
          ? { ...message, content: openedChatMediaContent(message.content) }
          : message;
        if (!latestByContact.has(contactId)) latestByContact.set(contactId, safeMessage);
      });
      const contactIds = [...latestByContact.keys()];
      if (selectedId && !contactIds.includes(selectedId)) contactIds.push(selectedId);

      const followingIds = new Set<string>();
      const followerIds = new Set<string>();
      (followsResult.data || []).forEach(follow => {
        if (follow.follower_id === currentUserId) followingIds.add(follow.following_id);
        if (follow.following_id === currentUserId) followerIds.add(follow.follower_id);
      });
      const mutualIds = [...followingIds].filter(id => followerIds.has(id) && id !== currentUserId);
      const profileIds = [...new Set([...contactIds, ...mutualIds])];
      const profilesResult = profileIds.length
        ? await retrySupabaseQuery(async () => await supabase.from('profiles').select(PROFILE_FIELDS).in('id', profileIds))
        : { data: [], error: null };
      if (requestId !== contactsRequestRef.current) return;
      if (profilesResult.error) throw profilesResult.error;

      const storiesResult = contactIds.length
        ? await retrySupabaseQuery(async () => await supabase.from('stories').select('id, user_id').in('user_id', contactIds).gt('expires_at', new Date().toISOString()))
        : { data: [], error: null };
      if (requestId !== contactsRequestRef.current) return;
      if (requestStatesResult.error) {
        console.warn('[messages] تعذر تحميل حالات طلبات المراسلة:', requestStatesResult.error);
      }
      const requestStateByContact = new Map<string, { recipientId: string; status: MessageRequestStatus }>();
      (requestStatesResult.data || []).forEach(row => {
        const participantOneId = typeof row.participant_one_id === 'string' ? row.participant_one_id : '';
        const participantTwoId = typeof row.participant_two_id === 'string' ? row.participant_two_id : '';
        const recipientId = typeof row.recipient_id === 'string' ? row.recipient_id : '';
        const status = row.status;
        if (!participantOneId || !participantTwoId || !recipientId
          || (status !== 'pending' && status !== 'accepted' && status !== 'declined')) return;
        const otherId = participantOneId === currentUserId ? participantTwoId : participantOneId;
        if (otherId !== currentUserId) requestStateByContact.set(otherId, { recipientId, status });
      });
      const storyRows = (storiesResult.data || []) as Array<{ id: string; user_id: string }>;
      const storyRowsByUser = new Map<string, Array<{ id: string; user_id: string }>>();
      storyRows.forEach(story => {
        const userStories = storyRowsByUser.get(story.user_id) || [];
        userStories.push(story);
        storyRowsByUser.set(story.user_id, userStories);
      });
      storyIdsByContactRef.current = Object.fromEntries(
        [...storyRowsByUser.entries()].map(([ownerId, stories]) => [ownerId, stories.map(story => story.id)]),
      );
      const seenStoryIds = readSeenStoryIds(currentUserId);
      const mutualIdSet = new Set(mutualIds);
      const profileById = new Map<string, Profile>(((profilesResult.data || []) as Profile[]).map(profile => [profile.id, profile] as [string, Profile]));
      setMutualFollowers(mutualIds.flatMap(id => {
        const profile = profileById.get(id);
        return profile ? [profile] : [];
      }));
      setMutualFollowersLoading(false);

      const nextConversations = contactIds.flatMap(contactId => {
        const profile = profileById.get(contactId);
        if (!profile) return [];
        const lastMessage = latestByContact.get(contactId) || null;
        const requestState = requestStateByContact.get(contactId);
        const storedIncomingRequest = Boolean(requestState?.recipientId === currentUserId && requestState.status !== 'accepted');
        const inferredIncomingRequest = Boolean(!requestState && lastMessage?.recipient_id === currentUserId && !mutualIdSet.has(contactId));
        const isRequest = storedIncomingRequest || inferredIncomingRequest;
        const contactStories = storyRowsByUser.get(contactId) || [];
        return [{
          profile,
          lastMessage,
          hasStory: contactStories.length > 0,
          hasUnseenStory: contactStories.some(story => !seenStoryIds.has(story.id)),
          isRequest,
          requestRecipientId: requestState?.recipientId || (inferredIncomingRequest ? currentUserId : null),
          requestStatus: requestState?.status || null,
        }];
      });
      const requestContactIds = new Set(nextConversations.filter(conversation => conversation.isRequest).map(conversation => conversation.profile.id));
      const requestUnreadCounts: Record<string, number> = {};
      const requestTabReadAt = Date.parse(requestTabReadAtRef.current || '') || 0;
      conversationMessages.forEach(message => {
        if (message.recipient_id !== currentUserId || message.read_at || !requestContactIds.has(message.sender_id)) return;
        const messageTime = Date.parse(message.created_at) || 0;
        const conversationReadAt = Date.parse(readAtByContactRef.current[message.sender_id] || '') || 0;
        if (messageTime <= Math.max(requestTabReadAt, conversationReadAt)) return;
        requestUnreadCounts[message.sender_id] = (requestUnreadCounts[message.sender_id] || 0) + 1;
      });
      setRequestUnreadByContact(requestUnreadCounts);
      setConversations(nextConversations);
      setConversationCacheReady(true);
    } catch (error) {
      if (requestId !== contactsRequestRef.current) return;
      console.error('[messages] تعذر تحميل قائمة المحادثات:', error);
      setContactsError('تعذر تحميل المحادثات الآن. حاول مرة أخرى.');
      setMutualFollowersLoading(false);
    }
  }, [currentUserId, markMessagesDelivered, purgeExpiredMessages, selectedId]);

  // حلقة القصص حول صور المحادثات: تنطفئ فور مشاهدة القصص في شريط القصص،
  // دون إعادة تحميل قائمة المحادثات من الشبكة.
  useEffect(() => {
    const syncStoryRings = () => {
      const seenStoryIds = readSeenStoryIds(currentUserId);
      const idsByContact = storyIdsByContactRef.current;
      setConversations(current => current.map(conversation => {
        const storyIds = idsByContact[conversation.profile.id] || [];
        if (!storyIds.length) return conversation;
        const hasUnseenStory = storyIds.some(storyId => !seenStoryIds.has(storyId));
        return conversation.hasUnseenStory === hasUnseenStory
          ? conversation
          : { ...conversation, hasUnseenStory };
      }));
    };

    window.addEventListener(SEEN_STORY_IDS_CHANGED_EVENT, syncStoryRings);
    return () => window.removeEventListener(SEEN_STORY_IDS_CHANGED_EVENT, syncStoryRings);
  }, [currentUserId]);

  const loadThread = useCallback(async () => {
    if (!supabaseConfigured || !selectedId) return;
    const requestId = ++threadRequestRef.current;
    const reactionVersionsAtRequestStart = new Map(reactionMutationVersionRef.current);
    const threadFilter = `and(sender_id.eq.${currentUserId},recipient_id.eq.${selectedId}),and(sender_id.eq.${selectedId},recipient_id.eq.${currentUserId})`;

    try {
      await purgeExpiredMessages();
      const { data, error } = await queryMessageRows(threadFilter, true, true);
      const hiddenMessageIds = await loadHiddenMessageIds(currentUserId);
      if (error) throw error;
      const visibleMessages = normalizeMessageRows(data)
        .filter(message => !hiddenMessageIds.has(message.id) && !deletedMessageIdsRef.current.has(message.id))
        .map(message => {
          const mediaMessage = parseChatMediaMessage(message.content);
          return mediaMessage?.viewOnce && (mediaMessage.opened || hasViewedOnce(currentUserId, message.id))
            ? { ...message, content: openedChatMediaContent(message.content) }
            : message;
        });
      const reactionResult = visibleMessages.length
        ? await retrySupabaseQuery(async () => await supabase.from('message_reactions').select('message_id, user_id, emoji').in('message_id', visibleMessages.map(message => message.id)))
        : { data: [], error: null };
      const nextReactions: Record<string, MessageReaction[]> = {};
      if (reactionResult.error) {
        console.warn('[messages] تعذر جلب تفاعلات الرسائل:', reactionResult.error);
        const visibleMessageIds = new Set(visibleMessages.map(message => message.id));
        Object.entries(reactionsByMessageRef.current).forEach(([messageId, rows]) => {
          if (visibleMessageIds.has(messageId)) nextReactions[messageId] = rows;
        });
      } else {
        (reactionResult.data || []).forEach(row => {
          if (typeof row.message_id !== 'string' || typeof row.user_id !== 'string' || typeof row.emoji !== 'string') return;
          (nextReactions[row.message_id] ||= []).push({ user_id: row.user_id, emoji: row.emoji });
        });
      }

      reactionMutationVersionRef.current.forEach((version, messageId) => {
        if (version <= (reactionVersionsAtRequestStart.get(messageId) || 0)) return;
        const localReaction = reactionsByMessageRef.current[messageId]?.find(reaction => reaction.user_id === currentUserId);
        const rows = (nextReactions[messageId] || []).filter(reaction => reaction.user_id !== currentUserId);
        if (localReaction) rows.push(localReaction);
        if (rows.length) nextReactions[messageId] = rows;
        else delete nextReactions[messageId];
      });

      const visibleMessageIds = new Set(visibleMessages.map(message => message.id));
      pendingReactionByMessageRef.current.forEach(({ emoji }, messageId) => {
        if (!visibleMessageIds.has(messageId)) return;
        const rows = (nextReactions[messageId] || []).filter(reaction => reaction.user_id !== currentUserId);
        if (emoji) rows.push({ user_id: currentUserId, emoji });
        if (rows.length) nextReactions[messageId] = rows;
        else delete nextReactions[messageId];
      });

      if (requestId === threadRequestRef.current) {
        visibleMessages.forEach(message => {
          if (voiceScrollLockRef.current.has(message.id)) voiceScrollConfirmedRef.current.add(message.id);
        });
        setThread(current => mergeThreadRows(
          current.filter(message => !hiddenMessageIds.has(message.id) && !deletedMessageIdsRef.current.has(message.id)),
          visibleMessages,
        ));
        setThreadCacheReady(true);
        commitReactionsByMessage(nextReactions);
        void markMessagesDelivered(visibleMessages
          .filter(message => message.recipient_id === currentUserId && !message.delivered_at)
          .map(message => message.id));
      }
    } catch (error) {
      if (requestId !== threadRequestRef.current) return;
      console.error('[messages] تعذر جلب المحادثة:', error);
    }
  }, [commitReactionsByMessage, currentUserId, markMessagesDelivered, purgeExpiredMessages, selectedId]);

  const markViewOnceMessageOpened = useCallback(async (messageId: string, urls: string[]) => {
    const targetMessage = thread.find(message => message.id === messageId);
    const targetMedia = targetMessage ? parseChatMediaMessage(targetMessage.content) : null;
    if (targetMessage?.recipient_id !== currentUserId || !targetMedia?.viewOnce || targetMedia.opened) return;

    setThread(current => current.map(message => message.id === messageId
      ? { ...message, content: openedChatMediaContent(message.content) }
      : message));
    setConversations(current => current.map(conversation => {
      const lastMessage = conversation.lastMessage;
      if (!lastMessage || lastMessage.id !== messageId) return conversation;
      return {
        ...conversation,
        lastMessage: {
          ...lastMessage,
          content: openedChatMediaContent(lastMessage.content),
        },
      };
    }));

    const objectPaths = [...new Set(urls.flatMap(url => {
      const path = chatMediaStoragePath(url);
      return path ? [path] : [];
    }))];
    if (objectPaths.length) {
      try {
        const { error: storageError } = await supabase.storage.from(storageBucket).remove(objectPaths);
        if (storageError) console.warn('[messages] تعذر حذف ملفات الصورة المؤقتة:', storageError);
      } catch (error) {
        console.warn('[messages] تعذر حذف ملفات الصورة المؤقتة:', error);
      }
    }

    try {
      const { error } = await supabase.rpc('aani_consume_view_once_message', { p_message_id: messageId });
      if (error) throw error;
    } catch (error) {
      console.warn('[messages] تعذر تحديث حالة الصورة المؤقتة على الخادم:', error);
    }
  }, [currentUserId, thread]);

  const realtimeRefreshTimerRef = useRef<number | null>(null);
  const realtimeRefreshThreadRef = useRef(false);
  const scheduleMessageRefresh = useCallback((includeThread: boolean) => {
    realtimeRefreshThreadRef.current = realtimeRefreshThreadRef.current || includeThread;
    if (realtimeRefreshTimerRef.current !== null) window.clearTimeout(realtimeRefreshTimerRef.current);
    realtimeRefreshTimerRef.current = window.setTimeout(() => {
      realtimeRefreshTimerRef.current = null;
      const refreshThread = realtimeRefreshThreadRef.current;
      realtimeRefreshThreadRef.current = false;
      void loadConversationList();
      if (refreshThread) void loadThread();
    }, 120);
  }, [loadConversationList, loadThread]);
  const clearScheduledMessageRefresh = useCallback(() => {
    if (realtimeRefreshTimerRef.current !== null) window.clearTimeout(realtimeRefreshTimerRef.current);
    realtimeRefreshTimerRef.current = null;
    realtimeRefreshThreadRef.current = false;
  }, []);

  useEffect(() => {
    void loadConversationList();
    if (!supabaseConfigured) return;
    const channel = supabase.channel(`messages-inbox-${currentUserId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `recipient_id=eq.${currentUserId}`,
      }, payload => {
        const messageId = (payload.new as { id?: unknown } | null)?.id;
        if (typeof messageId === 'string') void markMessagesDelivered([messageId]);
        scheduleMessageRefresh(false);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'message_hides',
        filter: `user_id=eq.${currentUserId}`,
      }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'message_conversation_requests',
      }, () => scheduleMessageRefresh(false))
      .subscribe();
    return () => {
      contactsRequestRef.current += 1;
      clearScheduledMessageRefresh();
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, loadConversationList, markMessagesDelivered, scheduleMessageRefresh, clearScheduledMessageRefresh]);

  useEffect(() => {
    if (!supabaseConfigured) return;
    const channel = supabase.channel('aani-online-presence', { config: { presence: { key: currentUserId } } });
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState() as Record<string, Array<{ user_id?: string }>>;
      const ids = new Set<string>();
      Object.values(state).forEach(entries => entries.forEach(entry => {
        if (typeof entry.user_id === 'string') ids.add(entry.user_id);
      }));
      setOnlineUserIds(ids);
    });
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        void channel.track({ user_id: currentUserId, online_at: new Date().toISOString() });
      }
    });
    return () => { void supabase.removeChannel(channel); };
  }, [currentUserId]);

  useLayoutEffect(() => {
    setReplyMessage(null);
    if (editingMessageRef.current) setText('');
    editingMessageRef.current = null;
    setEditingMessage(null);
    setMessageAction(null);
    setEmojiTargetMessage(null);
    setThreadOptionsOpen(false);
    setThreadOptionsView('menu');
    setThreadSearchOpen(false);
    setThreadSearch('');
    setThreadSearchIndex(0);
    setMessageExpirationSeconds(null);
    const cachedThread = selectedId ? readThreadCache(currentUserId, selectedId) : null;
    setThread(cachedThread?.messages || []);
    setThreadCacheReady(Boolean(cachedThread));
    commitReactionsByMessage(cachedThread?.reactionsByMessage || {});
  }, [commitReactionsByMessage, currentUserId, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      threadRequestRef.current += 1;
      setThread([]);
      return;
    }

    void loadThread();
    if (!supabaseConfigured) return;
    const channel = supabase.channel(`realtime-msgs-${currentUserId}-${selectedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, payload => {
        if (payload.eventType === 'DELETE') {
          const messageId = (payload.old as { id?: unknown } | null)?.id;
          if (typeof messageId === 'string') {
            deletedMessageIdsRef.current.add(messageId);
            setThread(current => current.filter(message => message.id !== messageId));
          }
        }
        scheduleMessageRefresh(true);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, () => scheduleMessageRefresh(true))
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'message_hides',
        filter: `user_id=eq.${currentUserId}`,
      }, () => scheduleMessageRefresh(true))
      .subscribe();
    return () => {
      threadRequestRef.current += 1;
      clearScheduledMessageRefresh();
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, selectedId, loadConversationList, loadThread, scheduleMessageRefresh, clearScheduledMessageRefresh]);

  useEffect(() => {
    if (!selectedId || !threadCacheReady) return;
    writeThreadCache(currentUserId, selectedId, thread, reactionsByMessage);
  }, [currentUserId, reactionsByMessage, selectedId, thread, threadCacheReady]);

  const lastThreadMessageId = thread[thread.length - 1]?.id;
  useEffect(() => {
    if (selectedId) markConversationRead(selectedId);
  }, [selectedId, lastThreadMessageId, markConversationRead]);

  const scrollThreadToBottom = useCallback(() => {
    const threadList = threadListRef.current;
    if (!threadList) return;
    threadList.scrollTop = threadList.scrollHeight;
  }, []);

  const scheduleVoiceThreadBottom = useCallback((recipientId: string, messageId: string) => {
    const keepBottom = () => {
      if (selectedIdRef.current === recipientId && voiceScrollLockRef.current.has(messageId)) {
        scrollThreadToBottom();
      }
    };
    window.requestAnimationFrame(() => {
      keepBottom();
      window.requestAnimationFrame(() => {
        keepBottom();
        voiceScrollLockRef.current.delete(messageId);
        voiceScrollConfirmedRef.current.delete(messageId);
      });
    });
  }, [scrollThreadToBottom]);

  useLayoutEffect(() => {
    scrollThreadToBottom();
  }, [thread.length, lastThreadMessageId, pendingMediaMessage?.id, selectedId, scrollThreadToBottom]);

  useLayoutEffect(() => {
    if (!pendingMediaMessage || pendingMediaMessage.recipientId !== selectedId) return;
    scrollThreadToBottom();
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollThreadToBottom();
      secondFrame = window.requestAnimationFrame(scrollThreadToBottom);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [pendingMediaMessage?.id, pendingMediaMessage?.recipientId, selectedId, scrollThreadToBottom]);

  useLayoutEffect(() => {
    const hasPendingVoiceMessage = () => thread.some(message => voiceScrollLockRef.current.has(message.id));
    if (!hasPendingVoiceMessage()) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      if (hasPendingVoiceMessage()) scrollThreadToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (hasPendingVoiceMessage()) scrollThreadToBottom();
        voiceScrollConfirmedRef.current.forEach(messageId => {
          voiceScrollConfirmedRef.current.delete(messageId);
          voiceScrollLockRef.current.delete(messageId);
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [thread, scrollThreadToBottom]);

  useEffect(() => {
    if (!selectedId) return;
    const viewport = window.visualViewport;
    let animationFrame = 0;
    const keepLatestMessageVisible = () => {
      scrollThreadToBottom();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(scrollThreadToBottom);
    };

    viewport?.addEventListener('resize', keepLatestMessageVisible);
    window.addEventListener('resize', keepLatestMessageVisible);
    return () => {
      viewport?.removeEventListener('resize', keepLatestMessageVisible);
      window.removeEventListener('resize', keepLatestMessageVisible);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [selectedId, scrollThreadToBottom]);

  useEffect(() => {
    if (!newMessageOpen || !supabaseConfigured) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setNewMessageLoading(true);
        setNewMessageError(null);
        try {
          const query = newMessageSearch.trim();
          let rows: Profile[] = [];
          if (query) {
            const pattern = `%${query}%`;
            const [usernameResult, fullNameResult, displayNameResult] = await Promise.all([
              retrySupabaseQuery(async () => await supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('username', pattern).limit(12)),
              retrySupabaseQuery(async () => await supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('full_name', pattern).limit(12)),
              retrySupabaseQuery(async () => await supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('display_name', pattern).limit(12)),
            ]);
            const error = usernameResult.error || fullNameResult.error || displayNameResult.error;
            if (error) throw error;
            rows = [
              ...((usernameResult.data || []) as Profile[]),
              ...((fullNameResult.data || []) as Profile[]),
              ...((displayNameResult.data || []) as Profile[]),
            ];
          } else {
            const { data, error } = await retrySupabaseQuery(async () => await supabase
              .from('profiles')
              .select(PROFILE_FIELDS)
              .neq('id', currentUserId)
              .order('username', { ascending: true })
              .limit(20));
            if (error) throw error;
            rows = (data || []) as Profile[];
          }

          const uniqueProfiles = [...new Map(rows.map(profile => [profile.id, profile])).values()].slice(0, 20);
          if (active) setNewMessageProfiles(uniqueProfiles);
        } catch (error) {
          if (!active) return;
          console.error('[messages] تعذر البحث عن حسابات للمراسلة:', error);
          setNewMessageProfiles([]);
          setNewMessageError('تعذر البحث عن الحسابات الآن.');
        } finally {
          if (active) setNewMessageLoading(false);
        }
      })();
    }, newMessageSearch.trim() ? 220 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [currentUserId, newMessageOpen, newMessageSearch]);

  const closeEmojiPicker = () => {
    if (!emojiPickerOpen) return;
    if (emojiPickerCloseTimerRef.current !== null) window.clearTimeout(emojiPickerCloseTimerRef.current);
    setEmojiPickerClosing(true);
    emojiPickerCloseTimerRef.current = window.setTimeout(() => {
      setEmojiPickerOpen(false);
      setEmojiPickerClosing(false);
      emojiPickerCloseTimerRef.current = null;
    }, 220);
  };

  const openEmojiPicker = () => {
    if (emojiPickerCloseTimerRef.current !== null) window.clearTimeout(emojiPickerCloseTimerRef.current);
    emojiPickerCloseTimerRef.current = null;
    setEmojiPickerClosing(false);
    setEmojiPickerOpen(true);
  };

  const insertComposerSymbol = (symbol: string) => {
    messageInputRef.current?.blur();
    setText(value => `${value}${symbol}`);
  };

  const openChatMediaPicker = () => {
    if (!selectedId || conversations.some(conversation => conversation.profile.id === selectedId && isConversationRequestLocked(conversation))) return;
    window.dispatchEvent(new CustomEvent('aani-open-chat-media-picker', { detail: { caption: text, recipientId: selectedId } }));
  };

  const cancelVoiceRecording = useCallback((session = voiceRecordingSessionRef.current) => {
    if (!session) return;
    session.cancelled = true;
    const isCurrentSession = voiceRecordingSessionRef.current === session;
    if (isCurrentSession) {
      voiceRecordingSessionRef.current = null;
      if (voiceRecordingTimerRef.current !== null) window.clearInterval(voiceRecordingTimerRef.current);
      voiceRecordingTimerRef.current = null;
      setVoiceRecordingStatus('idle');
      setVoiceRecordingElapsedMs(0);
    }
    try {
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    } catch {
      /* recorder already stopped */
    }
    session.stream?.getTracks().forEach(track => track.stop());
    session.stream = null;
  }, []);

  const uploadRecordedVoice = async (session: VoiceRecordingSession, blob: Blob, durationMs: number) => {
    if (conversations.some(conversation => conversation.profile.id === session.recipientId && isConversationRequestLocked(conversation))) return;
    const format = normalizeVoiceMimeType(blob.type);
    if (!format) {
      toast.error('صيغة التسجيل الصوتي غير مدعومة على هذا الجهاز.');
      return;
    }
    const messageId = createMessageId();
    const localUrl = URL.createObjectURL(blob);
    voiceObjectUrlsRef.current.add(localUrl);
    const localContent = voiceMessageContent(localUrl, durationMs);
    const createdAt = new Date().toISOString();
    const optimisticMessage: MessageRow = {
      id: messageId,
      sender_id: session.userId,
      recipient_id: session.recipientId,
      content: localContent,
      post_id: null,
      story_id: null,
      created_at: createdAt,
      delivered_at: null,
      read_at: null,
      reply_to_message_id: session.replyToMessageId,
      sendState: 'pending',
    };
    const isConversationOpen = selectedIdRef.current === session.recipientId;
    if (isConversationOpen) {
      voiceScrollLockRef.current.add(messageId);
      setThread(current => current.some(message => message.id === messageId)
        ? current
        : [...current, optimisticMessage]);
      setThreadCacheReady(true);
      scrollThreadToBottom();
      window.requestAnimationFrame(() => {
        scrollThreadToBottom();
        window.requestAnimationFrame(scrollThreadToBottom);
      });
    }

    const path = `${session.userId}/messages/${messageId}.${format.extension}`;
    let uploadedPath = '';
    let preserveUploadedFile = false;
    try {
      const uploadBlob = new Blob([blob], { type: format.mimeType });
      const file = new File([uploadBlob], `voice-${messageId}.${format.extension}`, { type: format.mimeType });
      await uploadMedia({ file, path, preset: 'voiceMessage' });
      uploadedPath = path;
      const audioUrl = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
      const content = voiceMessageContent(audioUrl, durationMs);
      if (content.length > 4000) throw new Error('بيانات الرسالة الصوتية كبيرة جداً.');
      const { error } = await supabase.from('messages').insert({
        id: messageId,
        sender_id: session.userId,
        recipient_id: session.recipientId,
        content,
        ...(session.replyToMessageId ? { reply_to_message_id: session.replyToMessageId } : {}),
      });
      if (error) {
        preserveUploadedFile = isTransientNetworkError(error);
        throw error;
      }
      if (selectedIdRef.current === session.recipientId) {
        setThread(current => current.map(message => message.id === messageId
          ? { ...message, content, sendState: 'sent' }
          : message));
      }
      URL.revokeObjectURL(localUrl);
      voiceObjectUrlsRef.current.delete(localUrl);
      if (selectedIdRef.current === session.recipientId) void loadThread();
      void loadConversationList();
    } catch (error) {
      if (uploadedPath && isTransientNetworkError(error)) preserveUploadedFile = true;
      if (uploadedPath && !preserveUploadedFile) {
        try {
          const { error: cleanupError } = await supabase.storage.from(storageBucket).remove([uploadedPath]);
          if (cleanupError) console.warn('[messages] تعذر تنظيف التسجيل الصوتي غير المرسل:', cleanupError);
        } catch (cleanupError) {
          console.warn('[messages] تعذر تنظيف التسجيل الصوتي غير المرسل:', cleanupError);
        }
      }
      if (selectedIdRef.current === session.recipientId) {
        setThread(current => current.map(message => message.id === messageId && message.sendState === 'pending'
          ? { ...message, sendState: 'failed' }
          : message));
      }
      if (isConversationOpen) scheduleVoiceThreadBottom(session.recipientId, messageId);
      console.error('[messages] تعذر إرسال الرسالة الصوتية:', error);
      toast.error('تعذر إرسال الرسالة الصوتية. تحقق من الاتصال وحاول مرة أخرى.');
    }
  };

  const beginVoiceRecording = async (session: VoiceRecordingSession) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('تسجيل الصوت غير مدعوم في هذا المتصفح.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session.cancelled || voiceRecordingSessionRef.current !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      session.stream = stream;
      const preferredMimeTypes = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      let recorder: MediaRecorder | null = null;
      let requestedMimeType = '';
      for (const mimeType of preferredMimeTypes) {
        try {
          if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mimeType)) continue;
          recorder = new MediaRecorder(stream, { mimeType });
          requestedMimeType = mimeType;
          break;
        } catch {
          /* try the next browser-supported recording format */
        }
      }
      const activeRecorder = recorder || new MediaRecorder(stream);
      session.recorder = activeRecorder;
      activeRecorder.ondataavailable = event => {
        if (event.data.size > 0) session.chunks.push(event.data);
      };
      activeRecorder.onerror = () => {
        if (voiceRecordingSessionRef.current !== session) return;
        cancelVoiceRecording(session);
        toast.error('تعذر تسجيل الصوت. تحقق من إذن الميكروفون.');
      };
      activeRecorder.onstop = () => {
        session.stream?.getTracks().forEach(track => track.stop());
        session.stream = null;
        if (session.cancelled || voiceRecordingSessionRef.current !== session) return;
        voiceRecordingSessionRef.current = null;
        if (voiceRecordingTimerRef.current !== null) window.clearInterval(voiceRecordingTimerRef.current);
        voiceRecordingTimerRef.current = null;
        const durationMs = session.startedAt === null ? 0 : Date.now() - session.startedAt;
        setVoiceRecordingElapsedMs(durationMs);
        setVoiceRecordingStatus('idle');
        setReplyMessage(null);
        const mimeType = activeRecorder.mimeType || session.chunks.find(chunk => chunk.type)?.type || requestedMimeType;
        const recordingFormat = normalizeVoiceMimeType(mimeType);
        if (!recordingFormat) {
          toast.error('صيغة التسجيل الصوتي غير مدعومة على هذا الجهاز.');
          return;
        }
        const blob = new Blob(session.chunks, { type: recordingFormat.mimeType });
        if (!blob.size) {
          toast.info('لم يتم تسجيل صوت. اضغط مطولاً على الميكروفون ثم حاول مرة أخرى.');
          return;
        }
        void uploadRecordedVoice(session, blob, durationMs);
      };
      activeRecorder.start(180);
      session.startedAt = Date.now();
      setVoiceRecordingStatus('recording');
      voiceRecordingTimerRef.current = window.setInterval(() => {
        if (session.startedAt !== null) setVoiceRecordingElapsedMs(Date.now() - session.startedAt);
      }, 120);
    } catch (error) {
      const isCurrentSession = voiceRecordingSessionRef.current === session;
      cancelVoiceRecording(session);
      if (isCurrentSession) console.warn('[messages] تعذر بدء التسجيل الصوتي:', error);
      if (isMicrophonePermissionDenied(error)) {
        toast.info('يرجى السماح بالوصول إلى الميكروفون من إعدادات المتصفح لإرسال البصمة الصوتية');
      } else if (isCurrentSession && error instanceof Error && /غير مدعوم/.test(error.message)) {
        toast.info(error.message);
      } else if (isCurrentSession) {
        toast.error('تعذر بدء التسجيل الصوتي. حاول مرة أخرى وتحقق من إعدادات المتصفح.');
      }
    }
  };

  const startVoiceRecording = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || voiceRecordingSessionRef.current) return;
    if (!supabaseConfigured || !selectedId || conversations.some(conversation => conversation.profile.id === selectedId && isConversationRequestLocked(conversation))) {
      toast.error('افتح محادثة مقبولة واتصل بالإنترنت لتسجيل رسالة صوتية.');
      return;
    }
    event.preventDefault();
    messageInputRef.current?.blur();
    const session: VoiceRecordingSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      userId: currentUserId,
      recipientId: selectedId,
      replyToMessageId: replyMessage?.id || null,
      cancelled: false,
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: null,
    };
    voiceRecordingSessionRef.current = session;
    try {
      messageComposerRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is not available in every browser */
    }
    if (emojiPickerCloseTimerRef.current !== null) window.clearTimeout(emojiPickerCloseTimerRef.current);
    emojiPickerCloseTimerRef.current = null;
    setEmojiPickerOpen(false);
    setEmojiPickerClosing(false);
    setEmojiTargetMessage(null);
    setReplyMessage(null);
    setVoiceRecordingElapsedMs(0);
    setVoiceRecordingStatus('requesting');
    void beginVoiceRecording(session);
  };

  const handleVoicePointerMove = (event: ReactPointerEvent<HTMLFormElement>) => {
    const session = voiceRecordingSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const offset = event.clientX - session.startX;
    if (offset <= -96) cancelVoiceRecording(session);
  };

  const finishVoiceRecording = (event: ReactPointerEvent<HTMLFormElement>) => {
    const session = voiceRecordingSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const cancelRect = voiceCancelButtonRef.current?.getBoundingClientRect();
    if (cancelRect
      && event.clientX >= cancelRect.left
      && event.clientX <= cancelRect.right
      && event.clientY >= cancelRect.top
      && event.clientY <= cancelRect.bottom) {
      cancelVoiceRecording(session);
      return;
    }
    if (!session.recorder || session.recorder.state !== 'recording') {
      cancelVoiceRecording(session);
      return;
    }
    try {
      session.recorder.stop();
    } catch {
      cancelVoiceRecording(session);
    }
  };

  useEffect(() => {
    const session = voiceRecordingSessionRef.current;
    if (session && session.recipientId !== selectedId) cancelVoiceRecording(session);
  }, [cancelVoiceRecording, selectedId]);

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = text.trim();
    if (!supabaseConfigured || !selectedId || !content || sending
      || conversations.some(conversation => conversation.profile.id === selectedId && isConversationRequestLocked(conversation))) {
      closeEmojiPicker();
      return;
    }

    const recipientId = selectedId;
    if (editingMessage) {
      const messageToEdit = editingMessage;
      if (messageToEdit.sender_id !== currentUserId || !isEditableTextMessage(messageToEdit)) {
        setEditingMessage(null);
        toast.error('لا يمكن تعديل هذا النوع من الرسائل.');
        return;
      }
      setSending(true);
      closeEmojiPicker();
      try {
        const { data, error } = await supabase
          .from('messages')
          .update({ content })
          .eq('id', messageToEdit.id)
          .eq('sender_id', currentUserId)
          .select('id')
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Message edit was not authorized or the message no longer exists.');
        if (selectedIdRef.current === recipientId) {
          setThread(current => current.map(message => message.id === messageToEdit.id
            ? { ...message, content }
            : message));
          setEditingMessage(null);
          setText('');
        }
        void loadConversationList();
        toast.success('تم تعديل الرسالة');
      } catch (error) {
        console.error('[messages] تعذر تعديل الرسالة:', error);
        toast.error('تعذر تعديل الرسالة. تأكد من تطبيق صلاحيات تعديل الرسائل في Supabase.');
      } finally {
        setSending(false);
      }
      return;
    }

    const optimisticMessage: MessageRow = {
      id: createMessageId(),
      sender_id: currentUserId,
      recipient_id: recipientId,
      content,
      post_id: null,
      story_id: null,
      created_at: new Date().toISOString(),
      delivered_at: null,
      read_at: null,
      reply_to_message_id: replyMessage?.id || null,
      sendState: 'pending',
    };
    setThread(current => current.some(message => message.id === optimisticMessage.id)
      ? current
      : [...current, optimisticMessage]);
    setText('');
    setReplyMessage(null);
    setSending(true);
    closeEmojiPicker();

    try {
      const { error } = await supabase.from('messages').insert({
        id: optimisticMessage.id,
        sender_id: currentUserId,
        recipient_id: recipientId,
        content,
        ...(replyMessage ? { reply_to_message_id: replyMessage.id } : {}),
      });
      if (error) throw error;
      setThreadCacheReady(true);
      setThread(current => current.map(message => message.id === optimisticMessage.id
        ? { ...message, sendState: 'sent' }
        : message));
      void loadConversationList();
    } catch (error) {
      console.error('[messages] تعذر إرسال الرسالة:', error);
      setThread(current => current.map(message => message.id === optimisticMessage.id && message.sendState === 'pending'
        ? { ...message, sendState: 'failed' }
        : message));
      toast.error('تعذر إرسال الرسالة. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const sendSticker = async (sticker: ChatStickerPayload) => {
    if (!supabaseConfigured || !selectedId || sending
      || conversations.some(conversation => conversation.profile.id === selectedId && isConversationRequestLocked(conversation))) {
      toast.error('تعذر إرسال الملصق. تحقق من قبول طلب المراسلة والاتصال.');
      return;
    }
    const content = `${CHAT_STICKER_MESSAGE_PREFIX}${JSON.stringify(sticker)}`;
    if (content.length > 4000) {
      toast.error('بيانات الملصق كبيرة جداً.');
      return;
    }

    setSending(true);
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: selectedId,
        content,
        ...(replyMessage ? { reply_to_message_id: replyMessage.id } : {}),
      });
      if (error) throw error;
      setReplyMessage(null);
      await Promise.all([loadThread(), loadConversationList()]);
    } catch (error) {
      console.error('[messages] تعذر إرسال الملصق:', error);
      toast.error('تعذر إرسال الملصق. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const tabConversations = useMemo(() => (
    activeTab === 'requests'
      ? conversations.filter(conversation => !conversationPreferences.archivedIds.includes(conversation.profile.id) && conversation.isRequest)
      : conversations.filter(conversation => !conversationPreferences.archivedIds.includes(conversation.profile.id) && !conversation.isRequest)
  ), [activeTab, conversations, conversationPreferences.archivedIds]);
  const archivedConversations = useMemo(() => conversations
    .filter(conversation => conversationPreferences.archivedIds.includes(conversation.profile.id))
    .sort((left, right) => Date.parse(right.lastMessage?.created_at || '') - Date.parse(left.lastMessage?.created_at || '')),
  [conversations, conversationPreferences.archivedIds]);
  const orderedTabConversations = useMemo(() => [...tabConversations].sort((left, right) => (
    Number(conversationPreferences.pinnedIds.includes(right.profile.id)) - Number(conversationPreferences.pinnedIds.includes(left.profile.id))
  )), [conversationPreferences.pinnedIds, tabConversations]);
  const searchNeedle = searchTerm.trim().toLocaleLowerCase();
  const matchingConversationCount = tabConversations.filter(conversation => (
    `${displayName(conversation.profile)} ${conversation.profile.username || ''}`.toLocaleLowerCase().includes(searchNeedle)
  )).length;
  const requestCount = Object.entries(requestUnreadByContact).reduce((total, [contactId, count]) => (
    total + (conversationPreferences.archivedIds.includes(contactId) ? 0 : count)
  ), 0);
  const archivedCount = conversations.filter(conversation => conversationPreferences.archivedIds.includes(conversation.profile.id)).length;
  const selectedConversation = conversations.find(conversation => conversation.profile.id === selectedId) || null;
  const target = selectedConversation?.profile || null;
  const selectedPendingMediaMessage = pendingMediaMessage?.recipientId === selectedId ? pendingMediaMessage : null;
  const threadSearchMatches = useMemo(() => {
    const needle = threadSearch.trim().toLocaleLowerCase();
    return needle ? thread.filter(message => message.content.toLocaleLowerCase().includes(needle)) : [];
  }, [thread, threadSearch]);
  const sharedMessages = thread.filter(message => Boolean(message.post_id) || message.content.trim().startsWith('[post:'));
  const forwardableConversations = conversations.filter(conversation => conversation.profile.id !== selectedId);
  const mediaGalleryItems = thread.flatMap(message => {
    const media = parseChatMediaMessage(message.content);
    if (!media || media.viewOnce) return [];
    return media.urls.map((url, index) => ({ message, url, index, caption: media.caption }));
  });

  const decideMessageRequest = async (status: 'accepted' | 'declined') => {
    const conversation = selectedConversation;
    if (!conversation?.isRequest || !selectedId || requestActionBusy) return;
    if (status === 'accepted' && conversation.requestStatus === 'declined') return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setRequestActionBusy(true);
    try {
      const { error } = await supabase.rpc('aani_set_message_conversation_request', {
        p_other_user_id: selectedId,
        p_status: status,
      });
      if (error) throw error;
      setConversations(current => current.map(item => item.profile.id === selectedId
        ? { ...item, isRequest: status === 'declined', requestStatus: status }
        : item));
      setRequestUnreadByContact(current => {
        if (!(selectedId in current)) return current;
        const next = { ...current };
        delete next[selectedId];
        return next;
      });
      if (status === 'accepted') {
        setActiveTab('messages');
        toast.success('تم قبول طلب المراسلة ونقل المحادثة إلى الرسائل');
      } else {
        toast.success('تم رفض طلب المراسلة');
      }
      await loadConversationList();
    } catch (error) {
      console.error('[messages] تعذر تحديث طلب المراسلة:', error);
      toast.error('تعذر تحديث الطلب. تأكد من تطبيق ترحيل طلبات المراسلة في Supabase.');
    } finally {
      setRequestActionBusy(false);
    }
  };

  const deleteDeclinedMessageRequest = async () => {
    const conversation = selectedConversation;
    if (!conversation || conversation.requestStatus !== 'declined' || !selectedId || requestActionBusy) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setRequestActionBusy(true);
    try {
      const { error } = await supabase.rpc('aani_delete_declined_message_request', { p_other_user_id: selectedId });
      if (error) throw error;
      setConversations(current => current.filter(item => item.profile.id !== selectedId));
      setRequestUnreadByContact(current => {
        if (!(selectedId in current)) return current;
        const next = { ...current };
        delete next[selectedId];
        return next;
      });
      setThread([]);
      setLocation('/messages');
      toast.success('تم حذف المحادثة نهائياً');
    } catch (error) {
      console.error('[messages] تعذر حذف طلب المراسلة المرفوض:', error);
      toast.error('تعذر حذف المحادثة. تأكد من تطبيق ترحيل طلبات المراسلة في Supabase.');
    } finally {
      setRequestActionBusy(false);
    }
  };

  useEffect(() => {
    const rows = threadListRef.current?.querySelectorAll<HTMLElement>('[data-message-id]');
    if (!rows) return;
    if (!threadSearchOpen || threadSearchMatches.length === 0) {
      rows.forEach(row => row.classList.remove('is-search-match'));
      return;
    }
    const targetMessage = threadSearchMatches[Math.min(threadSearchIndex, threadSearchMatches.length - 1)];
    if (!targetMessage) return;
    rows.forEach(row => row.classList.toggle('is-search-match', row.dataset.messageId === targetMessage.id));
    const targetRow = Array.from(rows).find(row => row.dataset.messageId === targetMessage.id);
    targetRow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [threadSearchIndex, threadSearchMatches, threadSearchOpen]);

  useEffect(() => {
    if (!selectedId || !supabaseConfigured) return;
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('aani_get_message_expiration', { p_other_user_id: selectedId });
        if (error) throw error;
        if (active) setMessageExpirationSeconds(typeof data === 'number' ? data : null);
      } catch (error) {
        if (active) console.warn('[messages] تعذر تحميل مدة المحادثة المؤقتة:', error);
      }
    })();
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    if (!supabaseConfigured) {
      setGlobalExpirationSeconds(null);
      return () => { active = false; };
    }
    setGlobalExpirationLoading(true);
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('aani_get_global_message_expiration');
        if (error) throw error;
        if (active) setGlobalExpirationSeconds(typeof data === 'number' ? data : null);
      } catch (error) {
        if (active) console.warn('[messages] تعذر تحميل مؤقت المحادثات العام:', error);
      } finally {
        if (active) setGlobalExpirationLoading(false);
      }
    })();
    return () => { active = false; };
  }, [currentUserId]);

  useEffect(() => {
    if ((!selectedId || messageExpirationSeconds === null) && globalExpirationSeconds === null) return;
    if (!supabaseConfigured) return;
    const timer = window.setInterval(() => { void purgeExpiredMessages(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [globalExpirationSeconds, messageExpirationSeconds, purgeExpiredMessages, selectedId]);

  const setConversationPreference = (key: ConversationPreferenceKey, contactId: string, enabled: boolean) => {
    setConversationPreferences(current => {
      const next = updatePreferenceList(current, key, contactId, enabled);
      writeConversationPreferences(currentUserId, next);
      return next;
    });
  };

  const openConversationSheet = () => {
    setThreadOptionsView('menu');
    setThreadOptionsOpen(true);
  };

  const openConversationGallery = (view: ConversationGalleryView) => {
    setThreadOptionsView('menu');
    setThreadOptionsOpen(false);
    setGalleryForwardOpen(false);
    setForwardRecipientId('');
    setGalleryPreview(null);
    setGalleryView(view);
  };

  const closeConversationGallery = () => {
    setGalleryForwardOpen(false);
    setForwardRecipientId('');
    setGalleryPreview(null);
    setGalleryView(null);
  };

  const forwardGalleryPreview = async () => {
    if (!galleryPreview || !forwardRecipientId || forwardBusy) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    const content = galleryPreview.kind === 'media'
      ? `${CHAT_MEDIA_MESSAGE_PREFIX}${JSON.stringify({ urls: [galleryPreview.url], caption: galleryPreview.caption, viewOnce: false })}`
      : galleryPreview.content;
    const payload: { sender_id: string; recipient_id: string; content: string; post_id?: string } = {
      sender_id: currentUserId,
      recipient_id: forwardRecipientId,
      content,
      ...(galleryPreview.kind === 'post' ? { post_id: galleryPreview.postId } : {}),
    };

    setForwardBusy(true);
    try {
      let { error } = await supabase.from('messages').insert(payload);
      if (error && payload.post_id && ((error as { code?: string }).code === '42703' || /post_id/i.test(error.message || ''))) {
        const legacyPayload = { ...payload };
        delete legacyPayload.post_id;
        ({ error } = await supabase.from('messages').insert(legacyPayload));
      }
      if (error) throw error;
      setGalleryForwardOpen(false);
      setForwardRecipientId('');
      toast.success('تمت إعادة إرسال العنصر');
      void loadConversationList();
    } catch (error) {
      console.error('[messages] تعذرت إعادة إرسال العنصر:', error);
      toast.error('تعذرت إعادة إرسال العنصر. تحقق من الاتصال وحاول مجدداً.');
    } finally {
      setForwardBusy(false);
    }
  };

  const jumpToGalleryMessage = () => {
    if (!galleryPreview) return;
    const messageId = galleryPreview.messageId;
    setGalleryForwardOpen(false);
    setForwardRecipientId('');
    setGalleryPreview(null);
    setGalleryView(null);
    setThreadOptionsOpen(false);
    window.requestAnimationFrame(() => {
      const rows = threadListRef.current?.querySelectorAll<HTMLElement>('[data-message-id]');
      const targetRow = Array.from(rows || []).find(row => row.dataset.messageId === messageId);
      if (!targetRow) return;
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetRow.classList.add('is-gallery-target');
      window.setTimeout(() => targetRow.classList.remove('is-gallery-target'), 2200);
    });
  };

  const updateMessageExpiration = async (seconds: number | null) => {
    if (!selectedId || expirationSaving) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    setExpirationSaving(true);
    try {
      const { error } = await supabase.rpc('aani_set_message_expiration', {
        p_other_user_id: selectedId,
        p_duration_seconds: seconds,
      });
      if (error) throw error;
      setMessageExpirationSeconds(seconds);
      toast.success(seconds === null ? 'تم إيقاف مؤقت الرسائل' : 'تم تحديث مؤقت المحادثة للرسائل الجديدة');
    } catch (error) {
      console.error('[messages] تعذر تحديث مؤقت المحادثة:', error);
      toast.error('تعذر تحديث المؤقت. تأكد من تطبيق تحديث الرسائل المؤقتة في Supabase.');
    } finally {
      setExpirationSaving(false);
    }
  };

  const updateGlobalMessageExpiration = async (seconds: number | null) => {
    if (globalExpirationSaving || globalExpirationLoading) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    setGlobalExpirationSaving(true);
    try {
      const { error } = await supabase.rpc('aani_set_global_message_expiration', {
        p_duration_seconds: seconds,
      });
      if (error) throw error;
      setGlobalExpirationSeconds(seconds);
      toast.success(seconds === null ? 'تم إيقاف المؤقت العام' : 'تم تطبيق المؤقت العام على الرسائل الجديدة في جميع المحادثات');
    } catch (error) {
      console.error('[messages] تعذر تحديث مؤقت المحادثات العام:', error);
      toast.error('تعذر تحديث المؤقت العام. تحقق من تطبيق تحديث الرسائل في قاعدة البيانات.');
    } finally {
      setGlobalExpirationSaving(false);
    }
  };

  const openConversationContextMenu = (conversation: ConversationSummary, targetRect: DOMRect) => {
    const rect = {
      top: targetRect.top,
      left: targetRect.left,
      width: targetRect.width,
      height: targetRect.height,
    };
    const menuHeight = 6 * 48 + 16;
    const belowTop = rect.top + rect.height + 8;
    const menuTop = belowTop + menuHeight <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, rect.top - menuHeight - 8);
    setConversationContext({ conversation, rect, menuTop, menuRight: 12 });
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressOriginRef.current = null;
  };

  const handleConversationAction = async (
    action: 'pin' | 'archive' | 'mute' | 'block' | 'report' | 'delete',
    conversation: ConversationSummary,
  ) => {
    const contactId = conversation.profile.id;
    const name = displayName(conversation.profile);
    setConversationContext(null);

    if (action === 'delete') {
      setDeleteTarget(conversation);
      return;
    }
    if (action === 'pin') {
      const pinned = conversationPreferences.pinnedIds.includes(contactId);
      setConversationPreference('pinnedIds', contactId, !pinned);
      toast.success(pinned ? 'تم إلغاء تثبيت المحادثة' : 'تم تثبيت المحادثة');
      return;
    }
    if (action === 'archive') {
      const archived = conversationPreferences.archivedIds.includes(contactId);
      setConversationPreference('archivedIds', contactId, !archived);
      if (archived) {
        setActiveTab(conversation.isRequest ? 'requests' : 'messages');
      } else {
        setActiveTab('messages');
        if (selectedId === contactId) setLocation('/messages');
      }
      toast.success(archived ? 'تم إلغاء أرشفة المحادثة' : 'تمت أرشفة المحادثة');
      return;
    }
    if (action === 'mute') {
      const muted = conversationPreferences.mutedIds.includes(contactId);
      setConversationPreference('mutedIds', contactId, !muted);
      toast.success(muted ? 'تم إلغاء كتم المحادثة' : 'تم كتم المحادثة');
      return;
    }

    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    if (action === 'block') {
      if (!window.confirm(`هل تريد حظر ${name}؟ سيُمنع الحساب من التواصل معك.`)) return;
      if (moderationBusy) return;
      setModerationBusy(true);
      try {
        const { error } = await supabase.rpc('aani_block_user', { p_blocked_user_id: contactId });
        if (error) throw error;
        if (selectedId === contactId) setLocation('/messages');
        await loadConversationList();
        toast.success('تم حظر الحساب');
      } catch (error) {
        console.error('[messages] تعذر حظر الحساب:', error);
        toast.error('تعذر حظر الحساب. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
      } finally {
        setModerationBusy(false);
      }
      return;
    }

    const details = window.prompt(`ما سبب الإبلاغ عن ${name}؟`);
    if (details === null) return;
    const normalizedDetails = details.trim();
    if (!normalizedDetails) {
      toast.error('اكتب سبباً للإبلاغ عن الحساب.');
      return;
    }
    if (normalizedDetails.length > 1000) {
      toast.error('يجب ألا يتجاوز سبب البلاغ 1000 حرف.');
      return;
    }
    if (moderationBusy) return;
    setModerationBusy(true);
    try {
      const { error } = await supabase.from('user_reports').insert({
        reporter_id: currentUserId,
        reported_user_id: contactId,
        category: 'other',
        details: normalizedDetails,
      });
      if (error?.code === '23505') {
        toast.info('سبق أن أبلغت عن هذا الحساب.');
        return;
      }
      if (error) throw error;
      toast.success('تم إرسال البلاغ لمراجعة الحساب.');
    } catch (error) {
      console.error('[messages] تعذر إرسال بلاغ الحساب:', error);
      toast.error('تعذر إرسال البلاغ. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setModerationBusy(false);
    }
  };

  const deleteConversation = async (forEveryone: boolean) => {
    const conversation = deleteTarget;
    if (!conversation || deleteBusy) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setDeleteBusy(true);
    try {
      const { error } = await supabase.rpc(
        forEveryone ? 'aani_delete_message_conversation_for_everyone' : 'aani_hide_message_conversation',
        { p_other_user_id: conversation.profile.id },
      );
      if (error) throw error;
      setDeleteTarget(null);
      if (selectedId === conversation.profile.id) {
        setThread([]);
        setLocation('/messages');
      }
      await loadConversationList();
      toast.success(forEveryone ? 'تم حذف المحادثة لدى الجميع' : 'تم حذف المحادثة من قائمتك');
    } catch (error) {
      console.error('[messages] تعذر حذف المحادثة:', error);
      toast.error('تعذر حذف المحادثة. تأكد من تطبيق تحديث أدوات المحادثات في Supabase.');
    } finally {
      setDeleteBusy(false);
    }
  };

  const openMessageActionMenu = (message: MessageRow, sourceElement: HTMLElement) => {
    if (message.sendState === 'pending' || message.sendState === 'failed') return;
    const row = sourceElement.matches('.messages-message-row')
      ? sourceElement
      : sourceElement.querySelector('.messages-message-row');
    if (!(row instanceof HTMLElement)) return;
    const content = row.querySelector('.messages-bubble, .messages-rich-message, .messages-image-message, .messages-sticker-message') || row;
    const rect = content.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const canEditMessage = message.sender_id === currentUserId && isEditableTextMessage(message);
    const menuWidth = Math.min(260, window.innerWidth - 24);
    const actionMenuHeight = (canEditMessage ? 5 : 4) * 46 + 20;
    const reactionHeight = 46;
    const reactionGap = 8;
    const minMenuTop = 12 + reactionHeight + reactionGap;
    const maxMenuTop = Math.max(minMenuTop, window.innerHeight - actionMenuHeight - 12);
    const belowMenuTop = rect.bottom + 12 + reactionHeight + reactionGap;
    const aboveMenuTop = rect.top - actionMenuHeight - 12;
    const preferredMenuTop = belowMenuTop + actionMenuHeight <= window.innerHeight - 12
      ? belowMenuTop
      : aboveMenuTop >= minMenuTop ? aboveMenuTop : minMenuTop;
    const menuTop = Math.max(minMenuTop, Math.min(maxMenuTop, preferredMenuTop));
    const menuLeft = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.left + rect.width / 2 - menuWidth / 2));
    const reactionsWidth = Math.min(300, window.innerWidth - 24);
    const reactionsTop = menuTop - reactionHeight - reactionGap;
    const reactionsLeft = Math.max(12, Math.min(window.innerWidth - reactionsWidth - 12, rect.left + rect.width / 2 - reactionsWidth / 2));
    messageActionOpenedAtRef.current = Date.now();
    setMessageAction({
      message,
      mode: 'actions',
      rect: { top: rowRect.top, left: rowRect.left, width: rowRect.width, height: rowRect.height },
      rowMarkup: row.outerHTML,
      menuTop,
      menuLeft,
      reactionsTop,
      reactionsLeft,
    });
  };

  const toggleMessageReaction = (message: MessageRow, emoji: string) => {
    if (!supabaseConfigured || message.sendState === 'pending' || message.sendState === 'failed' || !emoji || emoji.length > 32) {
      if (!supabaseConfigured) toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    const previousRows = [...(reactionsByMessageRef.current[message.id] || [])];
    const existing = previousRows.find(reaction => reaction.user_id === currentUserId);
    const nextEmoji = existing?.emoji === emoji ? null : emoji;
    const nextRows = previousRows.filter(reaction => reaction.user_id !== currentUserId);
    if (nextEmoji) nextRows.push({ user_id: currentUserId, emoji: nextEmoji });
    const optimisticReactions = { ...reactionsByMessageRef.current };
    if (nextRows.length) optimisticReactions[message.id] = nextRows;
    else delete optimisticReactions[message.id];
    commitReactionsByMessage(optimisticReactions);

    const version = (reactionMutationVersionRef.current.get(message.id) || 0) + 1;
    reactionMutationVersionRef.current.set(message.id, version);
    pendingReactionByMessageRef.current.set(message.id, { version, emoji: nextEmoji });
    const previousWrite = reactionWriteQueueRef.current.get(message.id) || Promise.resolve();
    const write = previousWrite.catch(() => undefined).then(async () => {
      if (nextEmoji === null) {
        await retrySupabaseQuery(async () => {
          const result = await supabase.from('message_reactions').delete().eq('message_id', message.id).eq('user_id', currentUserId);
          if (result.error) throw result.error;
          return result;
        });
      } else {
        await retrySupabaseQuery(async () => {
          const result = await supabase.from('message_reactions').upsert({
            message_id: message.id,
            user_id: currentUserId,
            emoji: nextEmoji,
          }, { onConflict: 'message_id,user_id' });
          if (result.error) throw result.error;
          return result;
        });
      }
      if (pendingReactionByMessageRef.current.get(message.id)?.version === version) {
        pendingReactionByMessageRef.current.delete(message.id);
      }
    });
    reactionWriteQueueRef.current.set(message.id, write);
    void write.catch(error => {
      console.warn('[messages] تعذر تحديث تفاعل الرسالة بعد إعادة المحاولة:', error);
    }).finally(() => {
      if (reactionWriteQueueRef.current.get(message.id) === write) reactionWriteQueueRef.current.delete(message.id);
    });
  };

  const copyMessage = async (message: MessageRow) => {
    const mediaMessage = parseChatMediaMessage(message.content);
    const stickerMessage = parseChatStickerMessage(message.content);
    const voiceMessage = parseVoiceMessage(message.content);
    const callLog = parseCallLogMessage(message.content);
    const documentMessage = parseChatDocumentMessage(message.content);
    const locationMessage = parseChatLocationMessage(message.content);
    const content = message.content.trim();
    const textToCopy = callLog
      ? `${callLogOutcomeLabel(callLog.outcome)} · مكالمة ${callLogModeLabel(callLog.mode)}`
      : content.startsWith(CHAT_CALL_MESSAGE_PREFIX)
        ? 'سجل مكالمة'
      : voiceMessage
        ? 'رسالة صوتية'
        : mediaMessage
          ? mediaMessage.caption || 'صورة'
      : stickerMessage
        ? 'ملصق'
      : documentMessage
        ? `مستند: ${documentMessage.name}`
      : locationMessage
        ? `موقع: ${locationMessage.latitude}, ${locationMessage.longitude}${locationMessage.note ? ` · ${locationMessage.note}` : ''}`
        : content.startsWith('[story-reply]')
          ? content.slice('[story-reply]'.length).trim()
          : message.post_id || content.startsWith('[post:')
            ? 'مشاركة منشور'
            : content.startsWith('[story:') ? 'أرسل قصة' : content;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable');
      await navigator.clipboard.writeText(textToCopy);
      setMessageAction(null);
      toast.success('تم نسخ الرسالة');
    } catch (error) {
      console.warn('[messages] تعذر نسخ الرسالة:', error);
      toast.error('تعذر النسخ. اسمح بالوصول إلى الحافظة وحاول مرة أخرى.');
    }
  };

  const reportMessage = async (message: MessageRow) => {
    setMessageAction(null);
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    const details = window.prompt('ما سبب الإبلاغ عن هذه الرسالة؟');
    if (details === null) return;
    const normalizedDetails = details.trim();
    if (!normalizedDetails) {
      toast.error('اكتب سبباً للإبلاغ عن الرسالة.');
      return;
    }
    if (normalizedDetails.length > 1000) {
      toast.error('يجب ألا يتجاوز سبب البلاغ 1000 حرف.');
      return;
    }
    setMessageModerationBusy(true);
    try {
      const { error } = await supabase.rpc('aani_report_message', {
        p_message_id: message.id,
        p_details: normalizedDetails,
      });
      if (error?.code === '23505') {
        toast.info('سبق أن أبلغت عن هذه الرسالة.');
        return;
      }
      if (error) throw error;
      toast.success('تم إرسال بلاغ الرسالة للمراجعة.');
    } catch (error) {
      console.error('[messages] تعذر الإبلاغ عن الرسالة:', error);
      toast.error('تعذر إرسال البلاغ. تأكد من تطبيق تحديث تفاعلات الرسائل في Supabase.');
    } finally {
      setMessageModerationBusy(false);
    }
  };

  const deleteMessage = async (forEveryone: boolean) => {
    const message = messageAction?.message;
    if (!message || messageDeleteBusy) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    if (forEveryone && message.sender_id !== currentUserId) {
      toast.error('يمكن لمرسل الرسالة فقط حذفها لدى الجميع.');
      return;
    }

    setMessageDeleteBusy(true);
    try {
      const { error } = await supabase.rpc(
        forEveryone ? 'aani_delete_message_for_everyone' : 'aani_hide_message',
        { p_message_id: message.id },
      );
      if (error) throw error;
      deletedMessageIdsRef.current.add(message.id);
      setThread(current => current.filter(item => item.id !== message.id));
      const nextReactions = { ...reactionsByMessageRef.current };
      delete nextReactions[message.id];
      commitReactionsByMessage(nextReactions);
      setMessageAction(null);
      await Promise.all([loadThread(), loadConversationList()]);
      toast.success(forEveryone ? 'تم حذف الرسالة لدى الجميع' : 'تم حذف الرسالة من محادثتك');
    } catch (error) {
      console.error('[messages] تعذر حذف الرسالة:', error);
      toast.error('تعذر حذف الرسالة. تأكد من تطبيق تحديث تفاعلات الرسائل في Supabase.');
    } finally {
      setMessageDeleteBusy(false);
    }
  };

  const openNewMessage = () => {
    setUserMenuOpen(false);
    setNewMessageSearch('');
    setNewMessageProfiles([]);
    setNewMessageError(null);
    setNewMessageOpen(true);
  };

  const openBroadcastMessage = () => {
    setGlobalMenuOpen(false);
    setBroadcastText('');
    setBroadcastSelectedIds(new Set());
    setBroadcastOpen(true);
  };

  const sendBroadcastMessage = async () => {
    const content = broadcastText.trim();
    const recipientIds = mutualFollowers
      .filter(person => broadcastSelectedIds.has(person.id))
      .map(person => person.id);
    if (!content || recipientIds.length === 0 || broadcastSending) return;
    if (content.length > 4000) {
      toast.error('لا يمكن أن تتجاوز الرسالة 4000 حرفاً.');
      return;
    }
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setBroadcastSending(true);
    const failedIds: string[] = [];
    let sentCount = 0;
    try {
      for (const recipientId of recipientIds) {
        try {
          const { error } = await supabase.from('messages').insert({
            sender_id: currentUserId,
            recipient_id: recipientId,
            content,
          });
          if (error) throw error;
          sentCount += 1;
        } catch (error) {
          console.warn('[messages] تعذر إرسال الرسالة الجماعية إلى حساب:', recipientId, error);
          failedIds.push(recipientId);
        }
      }

      if (sentCount > 0) void loadConversationList();
      if (failedIds.length > 0) {
        setBroadcastSelectedIds(new Set(failedIds));
        toast.error(`أُرسلت الرسالة إلى ${sentCount} وتعذر إرسالها إلى ${failedIds.length}. يمكنك إعادة المحاولة للمحددين.`);
      } else {
        toast.success(`تم إرسال الرسالة إلى ${sentCount} من المتابعين المتبادلين.`);
        setBroadcastOpen(false);
        setBroadcastText('');
        setBroadcastSelectedIds(new Set());
      }
    } finally {
      setBroadcastSending(false);
    }
  };

  return (
    <section
      ref={messagesViewRef}
      className="messages-view"
      dir="rtl"
      onPointerDown={event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.messages-composer, .messages-bubble, .messages-rich-message, .messages-image-message, .messages-sticker-message, .messages-sender-avatar, button, a, input, textarea, [role="button"], [role="menuitem"]')) return;
        messageInputRef.current?.blur();
      }}
    >
      <div className={`messages-layout${selectedId ? ' is-thread-open' : ''}`}>
        <aside className="messages-sidebar">
          <header className="messages-side-header">
            <div className="messages-account-wrap">
              <button
                type="button"
                className="messages-user-chip"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen(value => !value)}
              >
                <Avatar profile={currentProfile} large />
                <span className="messages-account-identity">
                  <span className="messages-account-name">{currentProfile?.username || currentProfile?.full_name || 'حسابي'}</span>
                  <span className="messages-account-hint">المحادثات</span>
                </span>
                <ChevronDown size={18} className={`messages-chevron${userMenuOpen ? ' is-open' : ''}`} />
              </button>
              {userMenuOpen && (
                <div className="messages-account-menu">
                  <span className="messages-menu-caption">الحساب الحالي</span>
                  <Link href="/profile" onClick={() => setUserMenuOpen(false)} className="messages-profile-link">
                    <Avatar profile={currentProfile} />
                    <span>{displayName(currentProfile)}</span>
                    <span className="messages-menu-username" dir="ltr">{currentProfile?.username ? `@${currentProfile.username.replace(/^@+/, '')}` : ''}</span>
                  </Link>
                </div>
              )}
            </div>
            <button
              type="button"
              className="messages-menu-button"
              aria-label="خيارات الرسائل"
              aria-haspopup="dialog"
              aria-expanded={globalMenuOpen}
              onClick={() => setGlobalMenuOpen(true)}
            >
              <Menu size={22} strokeWidth={2} />
            </button>
          </header>

          <div className="messages-search-wrap">
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              placeholder="ابحث"
              aria-label="ابحث في المحادثات"
            />
            {searchTerm && (
              <button type="button" aria-label="مسح البحث" onClick={() => setSearchTerm('')}>
                <X size={16} />
              </button>
            )}
          </div>

          <div className="messages-tabs" role="tablist" aria-label="أقسام الرسائل">
            <button type="button" role="tab" aria-selected={activeTab === 'messages'} className={`messages-tab${activeTab === 'messages' ? ' active' : ''}`} onClick={() => setActiveTab('messages')}>الرسائل</button>
            <button type="button" role="tab" aria-selected={activeTab === 'requests'} className={`messages-tab${activeTab === 'requests' ? ' active' : ''}`} onClick={() => {
              setActiveTab('requests');
              markRequestsTabSeen();
            }}>
              <span>الطلبات</span>
              {requestCount > 0 && <span className="messages-tab-badge">{requestCount > 99 ? '99+' : requestCount}</span>}
            </button>
          </div>

          <div className="messages-list-wrap">
            {contactsError && conversations.length === 0 && (
              <div className="messages-list-status" role="alert">
                <span>{contactsError}</span>
                <button type="button" onClick={() => void loadConversationList()}>إعادة المحاولة</button>
              </div>
            )}
            {orderedTabConversations.map(conversation => {
              const isUnread = Boolean(conversation.lastMessage
                && conversation.lastMessage.sender_id !== currentUserId
                && Date.parse(conversation.lastMessage.created_at) > (Date.parse(readAtByContact[conversation.profile.id] || '') || 0));
              const matchesSearch = `${displayName(conversation.profile)} ${conversation.profile.username || ''}`
                .toLocaleLowerCase()
                .includes(searchNeedle);
              const isOnline = onlineUserIds.has(conversation.profile.id);
              const isPinned = conversationPreferences.pinnedIds.includes(conversation.profile.id);
              const isMuted = conversationPreferences.mutedIds.includes(conversation.profile.id);
              return (
                <Link
                  key={conversation.profile.id}
                  href={`/messages/${encodeURIComponent(conversation.profile.id)}`}
                  hidden={!matchesSearch}
                  aria-current={selectedId === conversation.profile.id ? 'page' : undefined}
                  onPointerDown={event => {
                    if (event.button !== 0) return;
                    suppressNextConversationClickRef.current = false;
                    cancelLongPress();
                    longPressOriginRef.current = { x: event.clientX, y: event.clientY };
                    const rect = event.currentTarget.getBoundingClientRect();
                    longPressTimerRef.current = window.setTimeout(() => {
                      longPressTimerRef.current = null;
                      suppressNextConversationClickRef.current = true;
                      openConversationContextMenu(conversation, rect);
                    }, 450);
                  }}
                  onPointerMove={event => {
                    const origin = longPressOriginRef.current;
                    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelLongPress();
                  }}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onContextMenu={event => {
                    event.preventDefault();
                    cancelLongPress();
                    openConversationContextMenu(conversation, event.currentTarget.getBoundingClientRect());
                  }}
                  onClick={event => {
                    if (suppressNextConversationClickRef.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      suppressNextConversationClickRef.current = false;
                      return;
                    }
                    markConversationRead(conversation.profile.id);
                  }}
                  className={`messages-chat-item${selectedId === conversation.profile.id ? ' active' : ''}${isUnread ? ' unread' : ''}${isPinned ? ' is-pinned' : ''}`}
                >
                  <span
                    className={`messages-avatar-wrap${conversation.hasStory ? ' has-story' : ''}${conversation.hasStory && !conversation.hasUnseenStory ? ' is-story-seen' : ''}${isOnline ? ' is-online' : ''}`}
                    role={conversation.hasStory ? 'button' : undefined}
                    tabIndex={conversation.hasStory ? 0 : undefined}
                    aria-label={conversation.hasStory ? `عرض قصة ${displayName(conversation.profile)}` : undefined}
                    onClick={event => {
                      if (!conversation.hasStory) return;
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenStories(conversation.profile.id);
                      setLocation('/feed');
                    }}
                    onKeyDown={event => {
                      if (!conversation.hasStory || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenStories(conversation.profile.id);
                      setLocation('/feed');
                    }}
                  >
                    <span className="messages-avatar-inner"><Avatar profile={conversation.profile} large /></span>
                    {isOnline && <span className="messages-online-dot" aria-label="متصل الآن" />}
                  </span>
                  <span className="messages-chat-copy">
                    <span className="messages-chat-topline">
                      <span className={`messages-chat-name${isUnread ? ' is-unread' : ''}`}>
                        <span>{displayName(conversation.profile)}</span>
                        {isPinned && <Pin size={13} aria-label="مثبتة" />}
                        {isMuted && <BellOff size={13} aria-label="مكتومة" />}
                      </span>
                      <time className="messages-chat-time" dateTime={conversation.lastMessage?.created_at || undefined}>
                        {conversation.lastMessage ? formatConversationTime(conversation.lastMessage.created_at) : ''}
                      </time>
                    </span>
                    <span className="messages-chat-preview-row">
                      <span className={`messages-chat-preview${isUnread ? ' is-unread' : ''}`}>{messagePreview(conversation.lastMessage, currentUserId)}</span>
                      {isUnread && <span className="messages-unread-dot" aria-label="رسالة غير مقروءة" />}
                    </span>
                  </span>
                </Link>
              );
            })}
            {(!contactsError || conversations.length > 0) && tabConversations.length > 0 && matchingConversationCount === 0 && (
              <EmptyState className="py-6" />
            )}
            {(!contactsError || conversations.length > 0) && tabConversations.length === 0 && (
              <div className="messages-list-empty">
                <EmptyState className="py-6" />
                {activeTab === 'messages' && <button type="button" onClick={openNewMessage}>إرسال رسالة</button>}
              </div>
            )}
          </div>
        </aside>

        <main className={`messages-chat-area${selectedId ? ' is-open' : ''}`}>
          {!selectedId ? (
            <div className="messages-empty-state">
              <div className="messages-empty-icon"><MessageCircle size={34} strokeWidth={1.5} /></div>
              <h1>رسائلك</h1>
              <p>أرسل صوراً ورسائل خاصة مع الأصدقاء.</p>
              <button type="button" onClick={openNewMessage}>إرسال رسالة</button>
            </div>
          ) : (
            <>
              <header className="messages-thread-header">
                <button type="button" className="messages-mobile-back" aria-label="العودة إلى قائمة الرسائل" onClick={() => setLocation('/messages')}>
                  <ArrowLeft size={22} />
                </button>
                {target ? (
                  <Link href={`/profile/${encodeURIComponent(target.id)}`} className="messages-thread-person">
                    <Avatar profile={target} />
                    <UserIdentity
                      name={displayName(target)}
                      username={target.username}
                      className="min-w-0"
                      nameClassName="text-sm font-semibold text-white"
                      usernameClassName="text-xs text-[#a8a8a8]"
                    />
                  </Link>
                ) : (
                  <div className="messages-thread-person">
                    <Avatar />
                    <span className="messages-thread-placeholder">المحادثة</span>
                  </div>
                )}
                <div className="messages-thread-actions">
                  <button type="button" aria-label="اتصال صوتي أو فيديو" onClick={() => openCallPicker(target)} disabled={isConversationRequestLocked(selectedConversation)}>
                    <Phone size={20} />
                  </button>
                  <button
                    type="button"
                    aria-label="خيارات المحادثة"
                    aria-expanded={threadOptionsOpen}
                    onClick={openConversationSheet}
                  >
                    <MoreVertical size={21} />
                  </button>
                </div>
              </header>
              {threadSearchOpen && (
                <div className="messages-thread-searchbar" role="search" dir="rtl">
                  <Search size={19} aria-hidden="true" />
                  <input
                    ref={threadSearchInputRef}
                    type="search"
                    value={threadSearch}
                    placeholder="ابحث في المحادثة"
                    aria-label="ابحث في رسائل المحادثة"
                    onChange={event => { setThreadSearch(event.target.value); setThreadSearchIndex(0); }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && threadSearchMatches.length) {
                        event.preventDefault();
                        setThreadSearchIndex(index => (index + (event.shiftKey ? threadSearchMatches.length - 1 : 1)) % threadSearchMatches.length);
                      }
                      if (event.key === 'Escape') {
                        setThreadSearchOpen(false);
                        setThreadSearch('');
                      }
                    }}
                  />
                  <span className="messages-thread-search-count">{threadSearchMatches.length ? `${Math.min(threadSearchIndex + 1, threadSearchMatches.length)} / ${threadSearchMatches.length}` : '0 / 0'}</span>
                  <button type="button" aria-label="النتيجة السابقة" disabled={!threadSearchMatches.length} onClick={() => setThreadSearchIndex(index => (index + threadSearchMatches.length - 1) % threadSearchMatches.length)}><ChevronUp size={18} /></button>
                  <button type="button" aria-label="النتيجة التالية" disabled={!threadSearchMatches.length} onClick={() => setThreadSearchIndex(index => (index + 1) % threadSearchMatches.length)}><ChevronDown size={18} /></button>
                  <button type="button" aria-label="إغلاق البحث" onClick={() => { setThreadSearchOpen(false); setThreadSearch(''); setThreadSearchIndex(0); }}><X size={18} /></button>
                </div>
              )}
              <div
                ref={threadListRef}
                className="messages-thread-list"
                aria-live="polite"
                onScroll={event => {
                  const threadList = event.currentTarget;
                  const voiceMessageIsUploading = thread.some(message => voiceScrollLockRef.current.has(message.id));
                  if (voiceMessageIsUploading
                    && threadList.scrollHeight - threadList.clientHeight - threadList.scrollTop > 1) {
                    scrollThreadToBottom();
                  }
                }}
                onWheel={() => messageInputRef.current?.blur()}
                onTouchStart={event => {
                  const touch = event.touches[0];
                  threadScrollTouchOriginRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
                }}
                onTouchMove={event => {
                  const origin = threadScrollTouchOriginRef.current;
                  const touch = event.touches[0];
                  if (!origin || !touch) return;
                  const deltaX = Math.abs(touch.clientX - origin.x);
                  const deltaY = Math.abs(touch.clientY - origin.y);
                  if (deltaY > 8 && deltaY > deltaX) {
                    messageInputRef.current?.blur();
                    threadScrollTouchOriginRef.current = null;
                  }
                }}
                onTouchEnd={() => { threadScrollTouchOriginRef.current = null; }}
                onTouchCancel={() => { threadScrollTouchOriginRef.current = null; }}
              >
                {thread.length === 0 && !selectedPendingMediaMessage && (
                  <div className="messages-thread-start">أرسل أول رسالة لبدء المحادثة.</div>
                )}
                {thread.map((message, index) => {
                  const isMine = message.sender_id === currentUserId;
                  const showSenderAvatar = !isMine && (
                    index === thread.length - 1 || thread[index + 1]?.sender_id !== message.sender_id
                  );
                  const content = message.content.trim();
                  const isSharedPost = Boolean(message.post_id) || content.startsWith('[post:');
                  const storyFromColumn = message.story_id ? String(message.story_id) : null;
                  const storyFromContent = content.startsWith('[story:') ? content.slice(7).split(']')[0] : null;
                  const sharedStoryId = storyFromColumn || storyFromContent;
                  const isStoryReply = isStoryReplyMessage(message);
                  const isSharedStory = Boolean(sharedStoryId) && !isSharedPost && !isStoryReply;
                  // صاحب الستوري: إن كنت أنا الرادّ فهو الطرف الآخر، وإن كان الرادّ
                  // الطرف الآخر فأنا صاحب الستوري.
                  const storyReplyOwnerId = isMine ? target?.id ?? null : currentUserId;
                  const mediaMessage = parseChatMediaMessage(content);
                  const stickerMessage = parseChatStickerMessage(content);
                  const voiceMessage = parseVoiceMessage(content);
                  const callLogMessage = parseCallLogMessage(content);
                  const documentMessage = parseChatDocumentMessage(content);
                  const locationMessage = parseChatLocationMessage(content);
                  const messageReactions = reactionsByMessage[message.id] || [];
                  const reactionCounts = Object.entries(messageReactions.reduce<Record<string, MessageReaction[]>>((grouped, reaction) => {
                    (grouped[reaction.emoji] ||= []).push(reaction);
                    return grouped;
                  }, {}));
                  const repliedMessage = message.reply_to_message_id
                    ? thread.find(item => item.id === message.reply_to_message_id) || null
                    : null;
                  const replyPreview = message.reply_to_message_id ? (
                    <div className="messages-reply-inline">
                      <strong>{repliedMessage ? (repliedMessage.sender_id === currentUserId ? displayName(currentProfile) : displayName(target)) : 'رسالة محذوفة'}</strong>
                      <span>{repliedMessage ? replyMessagePreview(repliedMessage) : 'لم تعد هذه الرسالة متاحة'}</span>
                    </div>
                  ) : null;
                  return (
                    <MessageSwipeReply
                      key={message.id}
                      isMine={isMine}
                      onLongPress={element => openMessageActionMenu(message, element)}
                      onContextMenu={event => {
                        event.preventDefault();
                        openMessageActionMenu(message, event.currentTarget);
                      }}
                      onReply={() => {
                        setMessageAction(null);
                        if (editingMessage) {
                          setEditingMessage(null);
                          setText('');
                        }
                        setReplyMessage(message);
                        window.requestAnimationFrame(() => messageInputRef.current?.focus());
                      }}
                    >
                      <div className={`messages-message-row${isMine ? ' is-mine' : ' is-theirs'}${messageReactions.length ? ' has-reactions' : ''}`} data-message-id={message.id}>
                        <div className="messages-message-body">
                          {isSharedPost ? (
                            <>
                              {replyPreview}
                              <div className="messages-rich-message"><SharedPostPreview postId={message.post_id} content={message.content} /></div>
                            </>
                          ) : isSharedStory ? (
                            <>
                              {replyPreview}
                              <div className="messages-rich-message">
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
                            </>
                          ) : voiceMessage ? (
                            <div className={`messages-bubble messages-voice-bubble${isMine ? ' is-mine' : ' is-theirs'}`}>
                              {replyPreview}
                              <div className="messages-voice-line">
                                <div className="messages-voice-player">
                                  <Mic size={17} aria-hidden="true" />
                                  <VoiceMessagePlayer url={voiceMessage.url} durationMs={voiceMessage.durationMs} />
                                </div>
                                <span className="messages-bubble-footer">
                                  <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                  {isMine && <MessageDeliveryStatus message={message} />}
                                </span>
                              </div>
                            </div>
                          ) : callLogMessage || content.startsWith(CHAT_CALL_MESSAGE_PREFIX) ? (
                            <div
                              className={`messages-bubble messages-call-log${isMine ? ' is-mine' : ' is-theirs'}${callLogMessage?.outcome === 'completed' ? ' is-completed' : ' is-missed'}`}
                              style={{
                                minWidth: 'min(225px, 100%)',
                                maxWidth: 'min(320px, 82vw)',
                                padding: 12,
                                border: `1px solid ${callLogMessage?.outcome === 'completed' ? 'rgba(52, 199, 89, .42)' : 'rgba(255, 59, 48, .38)'}`,
                                background: callLogMessage?.outcome === 'completed' ? 'rgba(36, 168, 106, .2)' : 'rgba(229, 72, 77, .16)',
                                color: callLogMessage?.outcome === 'completed' ? '#e2ffed' : '#ffe5e4',
                                whiteSpace: 'normal',
                              }}
                            >
                              {replyPreview}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span
                                  aria-hidden="true"
                                  style={{
                                    width: 38,
                                    height: 38,
                                    flex: '0 0 38px',
                                    display: 'grid',
                                    placeItems: 'center',
                                    borderRadius: '50%',
                                    background: callLogMessage?.outcome === 'completed' ? 'rgba(52, 199, 89, .22)' : 'rgba(255, 59, 48, .2)',
                                  }}
                                >
                                  {callLogMessage?.mode === 'video' ? <Video size={19} /> : <Phone size={19} />}
                                </span>
                                <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  <strong>{callLogMessage ? `مكالمة ${callLogModeLabel(callLogMessage.mode)}` : 'سجل مكالمة'}</strong>
                                  <span style={{ fontSize: 12, opacity: .88 }}>
                                    {callLogMessage ? callLogOutcomeLabel(callLogMessage.outcome) : 'بيانات المكالمة غير متاحة'}
                                  </span>
                                  {callLogMessage?.outcome === 'completed' && (
                                    <span style={{ fontSize: 12, opacity: .88 }} dir="rtl">
                                      المدة {formatVoiceDuration(callLogMessage.durationSeconds * 1000)}
                                    </span>
                                  )}
                                </span>
                                {callLogMessage && (
                                  <button
                                    type="button"
                                    aria-label={`إعادة الاتصال، مكالمة ${callLogModeLabel(callLogMessage.mode)}`}
                                    disabled={isConversationRequestLocked(selectedConversation)}
                                    onClick={event => {
                                      event.stopPropagation();
                                      startCallNow(callLogMessage.mode, target);
                                    }}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: 5,
                                      padding: '8px 10px',
                                      border: '1px solid rgba(255,255,255,.18)',
                                      borderRadius: 18,
                                      background: callLogMessage.outcome === 'completed' ? 'rgba(52,199,89,.22)' : 'rgba(255,255,255,.1)',
                                      color: 'inherit',
                                      font: 'inherit',
                                      fontSize: 12,
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    <Phone size={15} /> إعادة الاتصال
                                  </button>
                                )}
                              </div>
                              <span className="messages-bubble-footer" style={{ display: 'flex', marginTop: 8 }}>
                                <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                {isMine && <MessageDeliveryStatus message={message} />}
                              </span>
                            </div>
                          ) : stickerMessage ? (
                            <>
                              {replyPreview}
                              <ChatStickerMessage payload={stickerMessage} />
                            </>
                          ) : mediaMessage ? (
                            <>
                              {replyPreview}
                              <ChatImageMessage
                                messageId={message.id}
                                currentUserId={currentUserId}
                                payload={mediaMessage}
                                isMine={isMine}
                                createdAt={message.created_at}
                                onViewOnceOpened={(messageId, urls) => { void markViewOnceMessageOpened(messageId, urls); }}
                              />
                            </>
                          ) : documentMessage ? (
                            <div className={`messages-bubble messages-special-attachment${isMine ? ' is-mine' : ' is-theirs'}`}>
                              {replyPreview}
                              <a className="messages-document-card" href={documentMessage.url} target="_blank" rel="noreferrer" download={documentMessage.name}>
                                <FileText size={25} aria-hidden="true" />
                                <span><strong>{documentMessage.name}</strong><small>{formatAttachmentSize(documentMessage.size)}</small></span>
                              </a>
                              <span className="messages-bubble-footer">
                                <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                {isMine && <MessageDeliveryStatus message={message} />}
                              </span>
                            </div>
                          ) : locationMessage ? (
                            <div className={`messages-bubble messages-special-attachment${isMine ? ' is-mine' : ' is-theirs'}`}>
                              {replyPreview}
                              <a className="messages-location-card" href={`https://www.openstreetmap.org/?mlat=${locationMessage.latitude}&mlon=${locationMessage.longitude}#map=16/${locationMessage.latitude}/${locationMessage.longitude}`} target="_blank" rel="noreferrer">
                                <MapPin size={25} aria-hidden="true" />
                                <span><strong>الموقع</strong>{locationMessage.note && <small>{locationMessage.note}</small>}</span>
                              </a>
                              <span className="messages-bubble-footer">
                                <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                {isMine && <MessageDeliveryStatus message={message} />}
                              </span>
                            </div>
                          ) : isStoryReply ? (
                            <StoryReplyCard
                              storyId={message.story_id ?? null}
                              mediaUrl={message.story_media_url ?? null}
                              thumbnailUrl={message.story_thumbnail_url ?? null}
                              mediaType={message.story_media_type ?? null}
                              isMine={isMine}
                              header={replyPreview}
                              onOpen={message.story_id && storyReplyOwnerId
                                ? () => {
                                  onOpenStories(storyReplyOwnerId);
                                  setLocation('/feed');
                                }
                                : undefined}
                            >
                              <div className={`messages-bubble messages-story-reply-text${isMine ? ' is-mine' : ' is-theirs'}`}>
                                <span className="messages-bubble-content">
                                  <EmojiText text={storyReplyText(message)} />
                                </span>
                                <span className="messages-bubble-footer">
                                  <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                  {isMine && <MessageDeliveryStatus message={message} />}
                                </span>
                              </div>
                            </StoryReplyCard>
                          ) : (
                            <div className={`messages-bubble${isMine ? ' is-mine' : ' is-theirs'}`}>
                              {replyPreview}
                              <span className="messages-bubble-content">
                                {content.startsWith('[story:') ? 'أرسل لك قصة' : <EmojiText text={message.content} />}
                              </span>
                              <span className="messages-bubble-footer">
                                <time className="messages-bubble-time" dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                                {isMine && <MessageDeliveryStatus message={message} />}
                              </span>
                            </div>
                          )}
                          {reactionCounts.length > 0 && (
                            <div className="messages-reaction-badges" role="group" aria-label="تفاعلات الرسالة">
                              {reactionCounts.map(([emoji, reactions]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  className={reactions.some(reaction => reaction.user_id === currentUserId) ? 'is-mine' : ''}
                                  aria-label={`${emoji}، ${reactions.length} تفاعل`}
                                  onClick={event => {
                                    event.stopPropagation();
                                    void toggleMessageReaction(message, emoji);
                                  }}
                                >
                                  <EmojiText text={emoji} />
                                  {reactions.length > 1 && <span>{reactions.length}</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {!isMine && (
                          <span className="messages-sender-avatar" aria-hidden="true">
                            {showSenderAvatar && <Avatar profile={target} />}
                          </span>
                        )}
                      </div>
                    </MessageSwipeReply>
                  );
                })}
                {selectedPendingMediaMessage && (
                  <div key={selectedPendingMediaMessage.id} className="messages-message-row is-mine">
                    <div className="messages-image-message messages-media-pending" aria-label={selectedPendingMediaMessage.isUploading ? 'جارٍ رفع الصور' : 'تم رفع الصور'}>
                      <div className={`messages-image-grid messages-media-pending-grid${selectedPendingMediaMessage.urls.length > 1 ? ' has-multiple' : ''}`}>
                        {selectedPendingMediaMessage.urls.map((url, index) => (
                          <img key={`${selectedPendingMediaMessage.id}-${index}`} src={url} alt={`صورة مرسلة ${index + 1}`} onLoad={scrollThreadToBottom} />
                        ))}
                        <span
                          className={`messages-media-pending-indicator${selectedPendingMediaMessage.isUploading ? '' : ' is-complete'}`}
                          role={selectedPendingMediaMessage.isUploading ? 'status' : undefined}
                          aria-hidden={!selectedPendingMediaMessage.isUploading}
                          aria-label="جارٍ رفع الصور"
                        >
                          <span className="messages-media-pending-spinner" />
                        </span>
                      </div>
                      {selectedPendingMediaMessage.caption && (
                        <div className="messages-image-caption messages-bubble is-mine"><EmojiText text={selectedPendingMediaMessage.caption} /></div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {selectedConversation?.isRequest ? (
                <div className="messages-request-banner" role="group" aria-label="إجراء طلب المراسلة" dir="rtl">
                  <p>
                    {selectedConversation.requestStatus === 'declined'
                      ? 'تم رفض طلب المراسلة'
                      : `${displayName(selectedConversation.profile)} يرغب في مراسلتك`}
                  </p>
                  <div className="messages-request-actions">
                    {selectedConversation.requestStatus === 'declined' ? (
                      <button type="button" className="messages-request-delete" onClick={() => void deleteDeclinedMessageRequest()} disabled={requestActionBusy}>
                        حذف المحادثة
                      </button>
                    ) : (
                      <>
                        <button type="button" className="messages-request-accept" onClick={() => void decideMessageRequest('accepted')} disabled={requestActionBusy}>
                          قبول
                        </button>
                        <button type="button" className="messages-request-decline" onClick={() => void decideMessageRequest('declined')} disabled={requestActionBusy}>
                          رفض
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : selectedConversation?.requestStatus && selectedConversation.requestRecipientId !== currentUserId && selectedConversation.requestStatus !== 'accepted' ? (
                <div className="messages-request-banner" role="status" dir="rtl">
                  <p>{selectedConversation.requestStatus === 'pending'
                    ? 'طلب المراسلة بانتظار القبول. لا يمكنك إرسال رسائل أخرى الآن.'
                    : 'تم رفض طلب المراسلة؛ لا يمكنك إرسال رسائل في هذه المحادثة.'}</p>
                </div>
              ) : selectedConversation ? (
                <form
                ref={messageComposerRef}
                className={`messages-composer${replyMessage || editingMessage ? ' has-reply' : ''}${emojiPickerOpen ? ' is-emoji-panel-open' : ''}${voiceRecordingStatus !== 'idle' ? ' is-recording' : ''}`}
                onSubmit={sendMessage}
                onPointerMove={handleVoicePointerMove}
                onPointerUp={finishVoiceRecording}
                onPointerCancel={event => {
                  const session = voiceRecordingSessionRef.current;
                  if (session?.pointerId === event.pointerId) cancelVoiceRecording(session);
                }}
              >
                {editingMessage && (
                  <div className="messages-reply-preview messages-edit-preview">
                    <div className="messages-reply-preview-copy">
                      <strong>تعديل الرسالة</strong>
                      <span>سيتم حفظ التغييرات على رسالتك</span>
                    </div>
                    <button
                      type="button"
                      aria-label="إلغاء التعديل"
                      onClick={() => {
                        setEditingMessage(null);
                        setText('');
                      }}
                    >
                      <X size={17} />
                    </button>
                  </div>
                )}
                {replyMessage && (
                  <div className="messages-reply-preview">
                    <div className="messages-reply-preview-copy">
                      <strong>الرد على {replyMessage.sender_id === currentUserId ? displayName(currentProfile) : displayName(target)}</strong>
                      <span>{replyMessagePreview(replyMessage)}</span>
                    </div>
                    <button type="button" aria-label="إلغاء الرد" onClick={() => setReplyMessage(null)}>
                      <X size={17} />
                    </button>
                  </div>
                )}
                {voiceRecordingStatus !== 'idle' ? (
                  <div className="messages-voice-recording" role="group" aria-label="تسجيل رسالة صوتية">
                    <button
                      ref={voiceCancelButtonRef}
                      type="button"
                      className="messages-voice-cancel"
                      aria-label="إلغاء التسجيل الصوتي"
                      title="إلغاء التسجيل"
                      onClick={() => cancelVoiceRecording()}
                    >
                      <Trash2 size={19} />
                    </button>
                    <div className="messages-voice-recording-copy">
                      <div className="messages-voice-recording-status">
                        <span className={`messages-voice-recording-dot${voiceRecordingStatus === 'recording' ? ' is-active' : ''}`} />
                        <span role="status">{voiceRecordingStatus === 'requesting' ? 'الميكروفون' : 'جارٍ التسجيل'}</span>
                        <time dir="ltr">{formatVoiceDuration(voiceRecordingElapsedMs)}</time>
                      </div>
                      <div className={`messages-voice-waveform${voiceRecordingStatus === 'recording' ? ' is-active' : ''}`} aria-hidden="true">
                        {[7, 13, 19, 10, 23, 15, 8, 18, 25, 12, 20, 9, 16, 24, 11, 18, 7, 14].map((height, index) => (
                          <span key={index} style={{ height: `${height}px`, animationDelay: `${index * 35}ms` }} />
                        ))}
                      </div>
                    </div>
                    <span className="messages-voice-mic-indicator" aria-label="التسجيل نشط"><Mic size={20} /></span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="messages-composer-control messages-composer-attach"
                      aria-label="المرفقات"
                      aria-haspopup="dialog"
                      onClick={() => setAttachmentOpen(true)}
                    >
                      <Plus size={24} />
                    </button>
                    <div className="messages-composer-field">
                      <textarea
                        ref={messageInputRef}
                        value={text}
                        onChange={event => setText(event.target.value)}
                        onFocus={() => {
                          scrollThreadToBottom();
                          window.requestAnimationFrame(scrollThreadToBottom);
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder={editingMessage ? 'عدّل رسالتك...' : 'اكتب رسالة...'}
                        aria-label={editingMessage ? 'تعديل الرسالة' : 'اكتب رسالة'}
                        autoComplete="off"
                        enterKeyHint="send"
                        rows={1}
                      />
                    </div>
                    <div className="messages-composer-actions">
                      <button
                        type="button"
                        className="messages-composer-control messages-composer-emoji"
                        aria-label="إيموجي وملصقات"
                        aria-haspopup="dialog"
                        aria-expanded={emojiPickerOpen}
                        onClick={openEmojiPicker}
                      >
                        <Smile size={19} />
                      </button>
                      {text.length === 0 && !editingMessage ? (
                        <>
                          <button
                            type="button"
                            className="messages-composer-control messages-composer-empty-action messages-composer-mic"
                            aria-label="اضغط مطولاً لتسجيل رسالة صوتية"
                            title="اضغط مطولاً لتسجيل رسالة صوتية"
                            onPointerDown={startVoiceRecording}
                            onContextMenu={event => event.preventDefault()}
                          >
                            <Mic size={22} />
                          </button>
                          <button type="button" className="messages-composer-control messages-composer-empty-action" aria-label="اختيار صورة أو التقاط صورة" onClick={openChatMediaPicker}>
                            <Camera size={22} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="submit"
                          className="messages-composer-control messages-composer-send"
                          aria-label={editingMessage ? 'حفظ التعديل' : 'إرسال الرسالة'}
                          title={editingMessage ? 'حفظ التعديل' : undefined}
                          disabled={!text.trim() || sending}
                          onMouseDown={event => {
                            if (document.activeElement === messageInputRef.current) event.preventDefault();
                          }}
                          onPointerDown={event => {
                            if (document.activeElement === messageInputRef.current) event.preventDefault();
                          }}
                        >
                          {editingMessage ? <Check size={20} /> : <Send size={20} />}
                        </button>
                      )}
                    </div>
                  </>
                )}
                {emojiPickerOpen && voiceRecordingStatus === 'idle' && (
                  <ChatStickerPanel
                    currentUserId={currentUserId}
                    closing={emojiPickerClosing}
                    onClose={() => {
                      setEmojiTargetMessage(null);
                      closeEmojiPicker();
                    }}
                    onInsertEmoji={emoji => {
                      const targetMessage = emojiTargetMessage;
                      if (targetMessage) {
                        setEmojiTargetMessage(null);
                        closeEmojiPicker();
                        void toggleMessageReaction(targetMessage, emoji);
                      } else {
                        insertComposerSymbol(emoji);
                      }
                    }}
                    onSendSticker={sticker => { void sendSticker(sticker); }}
                  />
                )}
                </form>
              ) : null}
            </>
          )}
        </main>
      </div>

      {selectedConversation && !isConversationRequestLocked(selectedConversation) && (
        <ChatMediaPicker
          currentUserId={currentUserId}
          recipientId={selectedId}
          onSendStart={message => setPendingMediaMessage(message)}
          onUploaded={(pendingId, recipientId, urls) => {
            setPendingMediaMessage(current => current?.id === pendingId && current.recipientId === recipientId
              ? { ...current, urls, isUploading: false }
              : current);
          }}
          onSent={async (pendingId, recipientId) => {
            const refreshes: Promise<void>[] = [loadConversationList()];
            if (recipientId === selectedIdRef.current) refreshes.push(loadThread());
            await Promise.all(refreshes);
            setPendingMediaMessage(current => current?.id === pendingId ? null : current);
          }}
          onSendFailed={pendingId => setPendingMediaMessage(current => current?.id === pendingId ? null : current)}
        />
      )}

      {selectedConversation && !isConversationRequestLocked(selectedConversation) && (
        <MessageAttachmentSheet
          key={selectedConversation.profile.id}
          open={attachmentOpen}
          currentUserId={currentUserId}
          recipientId={selectedConversation.profile.id}
          replyToMessageId={replyMessage?.id}
          onClose={() => setAttachmentOpen(false)}
          onSent={async () => {
            setReplyMessage(null);
            await Promise.all([loadThread(), loadConversationList()]);
          }}
        />
      )}

      {selectedConversation && createPortal(
        <div
          className={`messages-bottom-sheet-backdrop${threadOptionsOpen ? ' is-open' : ''}`}
          role="presentation"
          aria-hidden={!threadOptionsOpen}
          onClick={() => setThreadOptionsOpen(false)}
        >
          <section
            className={`messages-bottom-sheet${threadOptionsOpen ? ' is-open' : ''}`}
            role="dialog"
            aria-modal={threadOptionsOpen}
            aria-label="خيارات المحادثة"
            dir="rtl"
            onClick={event => event.stopPropagation()}
          >
            <div
              className="messages-bottom-sheet-handle-area"
              onPointerDown={event => {
                sheetDragStartYRef.current = event.clientY;
                try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
              }}
              onPointerUp={event => {
                const startY = sheetDragStartYRef.current;
                sheetDragStartYRef.current = null;
                if (startY !== null && event.clientY - startY > 55) setThreadOptionsOpen(false);
              }}
              onPointerCancel={() => { sheetDragStartYRef.current = null; }}
            >
              <span className="messages-bottom-sheet-handle" />
            </div>

            {threadOptionsView === 'menu' ? (
              <div className="messages-bottom-sheet-content messages-bottom-sheet-menu" role="menu" aria-label="إجراءات المحادثة">
                <button type="button" role="menuitem" onClick={() => {
                  setThreadOptionsOpen(false);
                  setThreadSearch('');
                  setThreadSearchIndex(0);
                  setThreadSearchOpen(true);
                }}>
                  <Search size={21} /><span>البحث</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setThreadOptionsView('timer')}>
                  <Clock size={21} /><span>مؤقت (محادثة مؤقتة)</span>
                </button>
                <button type="button" role="menuitem" onClick={() => openConversationGallery('media')}>
                  <ImageIcon size={21} /><span>عرض الوسائط</span>
                </button>
                <button type="button" role="menuitem" onClick={() => openConversationGallery('shares')}>
                  <FileText size={21} /><span>عرض المشاركات</span>
                </button>
                <button type="button" role="menuitem" disabled={moderationBusy} onClick={() => {
                  setThreadOptionsOpen(false);
                  void handleConversationAction('block', selectedConversation);
                }}>
                  <Ban size={21} /><span>الحظر</span>
                </button>
                <button type="button" role="menuitem" disabled={moderationBusy} className="is-destructive" onClick={() => {
                  setThreadOptionsOpen(false);
                  void handleConversationAction('report', selectedConversation);
                }}>
                  <Flag size={21} /><span>الإبلاغ</span>
                </button>
                <button type="button" role="menuitem" className="is-destructive" disabled={deleteBusy} onClick={() => {
                  setThreadOptionsOpen(false);
                  void handleConversationAction('delete', selectedConversation);
                }}>
                  <Trash2 size={21} /><span>الحذف</span>
                </button>
              </div>
            ) : (
              <>
                <header className="messages-bottom-sheet-subheader" dir="rtl">
                  <button type="button" aria-label="العودة إلى خيارات المحادثة" onClick={() => setThreadOptionsView('menu')}><ArrowLeft size={20} /></button>
                  <h2>محادثة مؤقتة</h2>
                  <span aria-hidden="true" />
                </header>
                <div className="messages-bottom-sheet-content messages-expiration-options" dir="rtl">
                  <p>اختر مدة اختفاء الرسائل الجديدة في هذه المحادثة.</p>
                  {MESSAGE_EXPIRATION_OPTIONS.map(option => (
                    <button
                      key={option.seconds ?? 'off'}
                      type="button"
                      className={messageExpirationSeconds === option.seconds ? 'is-selected' : ''}
                      disabled={expirationSaving}
                      onClick={() => { void updateMessageExpiration(option.seconds); }}
                    >
                      <span>{option.label}</span>
                      {messageExpirationSeconds === option.seconds && <Check size={19} />}
                    </button>
                  ))}
                  <small>يسري المؤقت على الرسائل التي تُرسل بعد تفعيل المدة.</small>
                </div>
              </>
            )}
          </section>
        </div>,
        document.body,
      )}

      {galleryView && createPortal(
        <section
          className="messages-gallery-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={galleryPreview ? 'معاينة عنصر مشترك' : galleryView === 'media' ? 'عرض الوسائط' : 'عرض المشاركات'}
          dir="rtl"
        >
          <header className="messages-gallery-header">
            <div className="messages-gallery-header-actions">
              <button
                type="button"
                aria-label={galleryPreview ? 'العودة إلى المعرض' : 'إغلاق المعرض'}
                onClick={() => galleryPreview ? setGalleryPreview(null) : closeConversationGallery()}
              >
                <X size={23} />
              </button>
              {galleryPreview && (
                <>
                  <button type="button" aria-label="إعادة إرسال العنصر" onClick={() => {
                    setForwardRecipientId('');
                    setGalleryForwardOpen(true);
                  }}>
                    <Send size={19} />
                  </button>
                  <button type="button" aria-label="الانتقال إلى الرسالة الأصلية" onClick={jumpToGalleryMessage}>
                    <span className="messages-gallery-jump-icon"><Eye /><ArrowRight /></span>
                  </button>
                </>
              )}
            </div>
            <h1>{galleryPreview ? galleryPreview.kind === 'media' ? 'معاينة الوسائط' : 'معاينة المشاركة' : galleryView === 'media' ? 'عرض الوسائط' : 'عرض المشاركات'}</h1>
          </header>
          {galleryPreview ? (
            <div className="messages-gallery-preview-scroll">
              {galleryPreview.kind === 'media' ? (
                <figure className="messages-gallery-preview-media">
                  {isVideoMediaUrl(galleryPreview.url) ? (
                    <video src={galleryPreview.url} controls playsInline preload="metadata" aria-label="معاينة فيديو مشترك" />
                  ) : (
                    <img src={galleryPreview.url} alt="معاينة صورة مشتركة" />
                  )}
                  {galleryPreview.caption && <figcaption>{galleryPreview.caption}</figcaption>}
                </figure>
              ) : (
                <SharedPostPreview postId={galleryPreview.postId} content={galleryPreview.content} variant="preview" />
              )}
            </div>
          ) : (
            <div className="messages-gallery-scroll">
              {galleryView === 'media' ? (
                mediaGalleryItems.length === 0 ? (
                  <EmptyState className="py-10" />
                ) : (
                  <div className="messages-gallery-grid">
                    {mediaGalleryItems.map(({ message, url, index, caption }) => (
                      <button
                        type="button"
                        key={`${message.id}-${index}`}
                        className="messages-gallery-media-tile"
                        aria-label={isVideoMediaUrl(url) ? 'معاينة فيديو مشترك' : 'معاينة صورة مشتركة'}
                        onClick={() => setGalleryPreview({ kind: 'media', messageId: message.id, url, caption })}
                      >
                        {isVideoMediaUrl(url) ? (
                          <>
                            <video src={url} muted playsInline preload="metadata" aria-hidden="true" />
                            <span className="messages-gallery-video-badge"><Play size={13} fill="currentColor" /></span>
                          </>
                        ) : (
                          <img src={url} alt="صورة مشتركة في المحادثة" loading="lazy" />
                        )}
                      </button>
                    ))}
                  </div>
                )
              ) : sharedMessages.length === 0 ? (
                <EmptyState className="py-10" />
              ) : (
                <div className="messages-gallery-grid">
                  {sharedMessages.map(message => {
                    const postId = message.post_id || message.content.match(/^\[post:(\S+)\]/)?.[1] || '';
                    return (
                      <SharedPostPreview
                        key={message.id}
                        postId={postId}
                        content={message.content}
                        variant="gallery"
                        onPreview={() => setGalleryPreview({ kind: 'post', messageId: message.id, postId, content: message.content })}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {galleryForwardOpen && galleryPreview && (
            <div
              className="messages-gallery-forward-backdrop"
              role="presentation"
              onClick={() => {
                if (forwardBusy) return;
                setGalleryForwardOpen(false);
                setForwardRecipientId('');
              }}
            >
              <section
                className="messages-gallery-forward-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="messages-gallery-forward-title"
                onClick={event => event.stopPropagation()}
              >
                <header>
                  <h2 id="messages-gallery-forward-title">إعادة إرسال العنصر</h2>
                  <button type="button" aria-label="إغلاق" disabled={forwardBusy} onClick={() => {
                    setGalleryForwardOpen(false);
                    setForwardRecipientId('');
                  }}>
                    <X size={20} />
                  </button>
                </header>
                <div className="messages-gallery-forward-list">
                  {forwardableConversations.length === 0 ? (
                    <EmptyState className="py-6" />
                  ) : forwardableConversations.map(conversation => (
                    <button
                      type="button"
                      key={conversation.profile.id}
                      className={forwardRecipientId === conversation.profile.id ? 'is-selected' : ''}
                      aria-pressed={forwardRecipientId === conversation.profile.id}
                      onClick={() => setForwardRecipientId(conversation.profile.id)}
                    >
                      <Avatar profile={conversation.profile} />
                      <span>{displayName(conversation.profile)}</span>
                      {forwardRecipientId === conversation.profile.id && <Check size={18} />}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="messages-gallery-forward-submit"
                  disabled={!forwardRecipientId || forwardBusy}
                  onClick={() => { void forwardGalleryPreview(); }}
                >
                  {forwardBusy ? 'جارٍ الإرسال...' : 'إرسال'}
                </button>
              </section>
            </div>
          )}
        </section>,
        document.body,
      )}

      {messageAction && createPortal(
        <div
          className="messages-message-action-backdrop"
          role="presentation"
          onClick={event => {
            if (Date.now() - messageActionOpenedAtRef.current < 500) {
              event.preventDefault();
              return;
            }
            setMessageAction(null);
          }}
        >
          <div
            className="messages-message-action-focus"
            aria-hidden="true"
            style={{
              top: messageAction.rect.top,
              left: messageAction.rect.left,
              width: messageAction.rect.width,
              height: messageAction.rect.height,
            }}
            dangerouslySetInnerHTML={{ __html: messageAction.rowMarkup }}
          />
          <div
            className="messages-message-action-reactions"
            role="toolbar"
            aria-label="تفاعلات سريعة"
            style={{ top: messageAction.reactionsTop, left: messageAction.reactionsLeft }}
            onClick={event => event.stopPropagation()}
          >
            {['❤️', '😂', '😮', '😢', '😡', '👍'].map(emoji => (
              <button
                key={emoji}
                type="button"
                aria-label={`تفاعل ${emoji}`}
                onClick={() => {
                  setMessageAction(null);
                  void toggleMessageReaction(messageAction.message, emoji);
                }}
              >
                <EmojiText text={emoji} />
              </button>
            ))}
            <button
              type="button"
              aria-label="فتح منتقي الإيموجي الكامل"
              onClick={() => {
                setEmojiTargetMessage(messageAction.message);
                setMessageAction(null);
                openEmojiPicker();
              }}
            >
              <Plus size={20} />
            </button>
          </div>
          <section
            className="messages-message-action-menu"
            role="menu"
            aria-label={messageAction.mode === 'delete' ? 'خيارات حذف الرسالة' : 'إجراءات الرسالة'}
            style={{ top: messageAction.menuTop, left: messageAction.menuLeft }}
            onClick={event => event.stopPropagation()}
          >
            {messageAction.mode === 'actions' ? (
              <>
                {messageAction.message.sender_id === currentUserId && isEditableTextMessage(messageAction.message) && (
                  <button type="button" role="menuitem" onClick={() => {
                    const selectedMessage = messageAction.message;
                    setMessageAction(null);
                    setReplyMessage(null);
                    setEditingMessage(selectedMessage);
                    setText(selectedMessage.content);
                    closeEmojiPicker();
                    window.requestAnimationFrame(() => messageInputRef.current?.focus());
                  }}>
                    <Pencil size={18} />
                    <span>تعديل</span>
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => {
                  const selectedMessage = messageAction.message;
                  setMessageAction(null);
                  if (editingMessage) {
                    setEditingMessage(null);
                    setText('');
                  }
                  setReplyMessage(selectedMessage);
                  window.requestAnimationFrame(() => messageInputRef.current?.focus());
                }}>
                  <Reply size={18} />
                  <span>رد</span>
                </button>
                <button type="button" role="menuitem" onClick={() => void copyMessage(messageAction.message)}>
                  <Copy size={18} />
                  <span>نسخ</span>
                </button>
                <button type="button" role="menuitem" disabled={messageModerationBusy || messageAction.message.sender_id === currentUserId} title={messageAction.message.sender_id === currentUserId ? 'يمكن الإبلاغ عن رسائل الطرف الآخر فقط' : undefined} onClick={() => void reportMessage(messageAction.message)}>
                  <Flag size={18} />
                  <span>إبلاغ</span>
                </button>
                <button type="button" role="menuitem" className="is-destructive" onClick={() => setMessageAction(current => current ? { ...current, mode: 'delete' } : current)}>
                  <Trash2 size={18} />
                  <span>حذف</span>
                </button>
              </>
            ) : (
              <>
                <div className="messages-message-action-title">حذف الرسالة</div>
                <button type="button" role="menuitem" disabled={messageDeleteBusy} onClick={() => void deleteMessage(false)}>
                  <Trash2 size={17} />
                  <span>الحذف لدي</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-destructive"
                  disabled={messageDeleteBusy || messageAction.message.sender_id !== currentUserId}
                  title={messageAction.message.sender_id !== currentUserId ? 'يمكن لمرسل الرسالة فقط حذفها لدى الجميع' : undefined}
                  onClick={() => void deleteMessage(true)}
                >
                  <Trash2 size={17} />
                  <span>الحذف لدى الجميع</span>
                </button>
                <button type="button" role="menuitem" className="messages-message-action-cancel" disabled={messageDeleteBusy} onClick={() => setMessageAction(current => current ? { ...current, mode: 'actions' } : current)}>
                  <span>رجوع</span>
                </button>
              </>
            )}
          </section>
        </div>,
        document.body,
      )}

      {conversationContext && createPortal(
        <div className="messages-context-backdrop" role="presentation" onClick={() => setConversationContext(null)}>
          <div
            className="messages-chat-item messages-context-focus"
            style={{
              top: conversationContext.rect.top,
              left: conversationContext.rect.left,
              width: conversationContext.rect.width,
              height: conversationContext.rect.height,
            }}
            aria-hidden="true"
          >
            <span className="messages-avatar-wrap">
              <span className="messages-avatar-inner"><Avatar profile={conversationContext.conversation.profile} large /></span>
            </span>
            <span className="messages-chat-copy">
              <span className="messages-chat-name">{displayName(conversationContext.conversation.profile)}</span>
              <span className="messages-chat-preview">{messagePreview(conversationContext.conversation.lastMessage, currentUserId)}</span>
            </span>
          </div>
          <section
            className="messages-context-menu"
            role="menu"
            aria-label={`إجراءات محادثة ${displayName(conversationContext.conversation.profile)}`}
            style={{ top: conversationContext.menuTop, right: conversationContext.menuRight }}
            onClick={event => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => void handleConversationAction('pin', conversationContext.conversation)}>
              <Pin size={18} />
              <span>{conversationPreferences.pinnedIds.includes(conversationContext.conversation.profile.id) ? 'إلغاء التثبيت' : 'تثبيت'}</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void handleConversationAction('archive', conversationContext.conversation)}>
              <Archive size={18} />
              <span>{conversationPreferences.archivedIds.includes(conversationContext.conversation.profile.id) ? 'إلغاء الأرشفة' : 'أرشفة'}</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void handleConversationAction('mute', conversationContext.conversation)}>
              <BellOff size={18} />
              <span>{conversationPreferences.mutedIds.includes(conversationContext.conversation.profile.id) ? 'إلغاء الكتم' : 'كتم'}</span>
            </button>
            <button type="button" role="menuitem" disabled={moderationBusy} onClick={() => void handleConversationAction('block', conversationContext.conversation)}>
              <Ban size={18} />
              <span>حظر</span>
            </button>
            <button type="button" role="menuitem" disabled={moderationBusy} onClick={() => void handleConversationAction('report', conversationContext.conversation)}>
              <Flag size={18} />
              <span>إبلاغ</span>
            </button>
            <button type="button" role="menuitem" className="is-destructive" onClick={() => void handleConversationAction('delete', conversationContext.conversation)}>
              <Trash2 size={18} />
              <span>حذف</span>
            </button>
          </section>
        </div>,
        document.body,
      )}

      {deleteTarget && createPortal(
        <div className="messages-delete-backdrop" role="presentation" onClick={() => { if (!deleteBusy) setDeleteTarget(null); }}>
          <section
            className="messages-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="messages-delete-title"
            aria-describedby="messages-delete-description"
            onClick={event => event.stopPropagation()}
          >
            <h2 id="messages-delete-title">حذف المحادثة؟</h2>
            <p id="messages-delete-description">اختر طريقة حذف محادثتك مع {displayName(deleteTarget.profile)}.</p>
            <button type="button" disabled={deleteBusy} onClick={() => void deleteConversation(false)}>حذف لدي</button>
            <button type="button" className="is-destructive" disabled={deleteBusy} onClick={() => void deleteConversation(true)}>حذف لدى الجميع</button>
            <small>الحذف لدى الجميع يزيل كل رسائل هذه المحادثة للطرفين.</small>
            <button type="button" className="messages-delete-cancel" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>إلغاء</button>
          </section>
        </div>,
        document.body,
      )}

      {newMessageOpen && (
        <div className="messages-modal-backdrop" role="presentation" onClick={() => setNewMessageOpen(false)}>
          <section className="messages-new-modal" role="dialog" aria-modal="true" aria-labelledby="messages-new-title" onClick={event => event.stopPropagation()}>
            <header className="messages-modal-header">
              <h2 id="messages-new-title">رسالة جديدة</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setNewMessageOpen(false)}><X size={20} /></button>
            </header>
            <div className="messages-modal-search">
              <label htmlFor="messages-new-search">إلى:</label>
              <input
                id="messages-new-search"
                value={newMessageSearch}
                onChange={event => setNewMessageSearch(event.target.value)}
                placeholder="ابحث عن حساب"
                autoFocus
              />
            </div>
            <div className="messages-new-results">
              {newMessageLoading && <MessagesSkeleton count={5} />}
              {newMessageError && !newMessageLoading && <div className="messages-list-status" role="alert">{newMessageError}</div>}
              {!newMessageLoading && !newMessageError && newMessageProfiles.map(person => (
                <button
                  key={person.id}
                  type="button"
                  className="messages-new-person"
                  onClick={() => {
                    setNewMessageOpen(false);
                    setLocation(`/messages/${encodeURIComponent(person.id)}`);
                  }}
                >
                  <Avatar profile={person} large />
                  <UserIdentity
                    name={displayName(person)}
                    username={person.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-sm font-semibold text-white"
                    usernameClassName="text-xs text-[#a8a8a8]"
                  />
                </button>
              ))}
              {!newMessageLoading && !newMessageError && newMessageProfiles.length === 0 && (
                <EmptyState className="py-6" />
              )}
            </div>
          </section>
        </div>
      )}
      {globalMenuOpen && createPortal(
        <div className="messages-global-menu-backdrop" role="presentation" onClick={() => setGlobalMenuOpen(false)}>
          <section
            className="messages-global-menu"
            role="dialog"
            aria-modal="true"
            aria-labelledby="messages-global-menu-title"
            dir="rtl"
            onClick={event => event.stopPropagation()}
          >
            <header>
              <h2 id="messages-global-menu-title">خيارات الرسائل</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setGlobalMenuOpen(false)}><X size={20} /></button>
            </header>
            <div className="messages-global-menu-options">
              <button type="button" onClick={openBroadcastMessage}>
                <Send size={20} />
                <span>رسالة جماعية</span>
                <ArrowLeft size={17} />
              </button>
              <button type="button" onClick={() => { setGlobalMenuOpen(false); setGlobalTimerOpen(true); }}>
                <Clock size={20} />
                <span>مؤقت المحادثات</span>
                <ArrowLeft size={17} />
              </button>
              <button type="button" onClick={() => { setGlobalMenuOpen(false); setArchivedOpen(true); }}>
                <Archive size={20} />
                <span>المحادثات المؤرشفة</span>
                {archivedCount > 0 && <span className="messages-global-menu-count">{archivedCount}</span>}
                <ArrowLeft size={17} />
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {broadcastOpen && createPortal(
        <div
          className="messages-fullscreen-overlay messages-broadcast-overlay"
          role="presentation"
          onClick={() => { if (!broadcastSending) setBroadcastOpen(false); }}
        >
          <section
            className="messages-fullscreen-panel messages-broadcast-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="messages-broadcast-title"
            dir="rtl"
            onClick={event => event.stopPropagation()}
          >
            <header className="messages-fullscreen-header">
              <h1 id="messages-broadcast-title">رسالة جماعية</h1>
              <button type="button" aria-label="إغلاق" disabled={broadcastSending} onClick={() => setBroadcastOpen(false)}><X size={22} /></button>
            </header>
            <div className="messages-broadcast-select-all">
              <label>
                <input
                  type="checkbox"
                  checked={mutualFollowers.length > 0 && mutualFollowers.every(person => broadcastSelectedIds.has(person.id))}
                  disabled={mutualFollowersLoading || mutualFollowers.length === 0 || broadcastSending}
                  onChange={event => setBroadcastSelectedIds(event.currentTarget.checked
                    ? new Set(mutualFollowers.map(person => person.id))
                    : new Set())}
                />
                <span>تحديد الكل</span>
              </label>
              <span>{broadcastSelectedIds.size} محدد</span>
            </div>
            <div className="messages-broadcast-list">
              {mutualFollowersLoading && <MessagesSkeleton count={5} />}
              {!mutualFollowersLoading && mutualFollowers.length === 0 && (
                <div className="messages-list-empty"><EmptyState className="py-6" /></div>
              )}
              {!mutualFollowersLoading && mutualFollowers.map(person => (
                <label key={person.id} className="messages-broadcast-person">
                  <input
                    type="checkbox"
                    checked={broadcastSelectedIds.has(person.id)}
                    disabled={broadcastSending}
                    onChange={event => {
                      const checked = event.currentTarget.checked;
                      setBroadcastSelectedIds(current => {
                        const next = new Set(current);
                        if (checked) next.add(person.id);
                        else next.delete(person.id);
                        return next;
                      });
                    }}
                  />
                  <Avatar profile={person} large />
                  <UserIdentity
                    name={displayName(person)}
                    username={person.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-sm font-semibold text-white"
                    usernameClassName="text-xs text-[#a8a8a8]"
                  />
                </label>
              ))}
            </div>
            <form className="messages-broadcast-composer" onSubmit={event => { event.preventDefault(); void sendBroadcastMessage(); }}>
              <textarea
                value={broadcastText}
                maxLength={4000}
                placeholder="اكتب رسالتك..."
                aria-label="نص الرسالة الجماعية"
                disabled={broadcastSending}
                onChange={event => setBroadcastText(event.target.value)}
              />
              <button
                type="submit"
                disabled={broadcastSending || mutualFollowersLoading || !broadcastText.trim() || broadcastSelectedIds.size === 0}
                aria-label="إرسال الرسالة الجماعية"
              >
                <Send size={20} />
                <span>{broadcastSending ? 'جارٍ الإرسال...' : 'إرسال'}</span>
              </button>
            </form>
          </section>
        </div>,
        document.body,
      )}

      {globalTimerOpen && createPortal(
        <div className="messages-fullscreen-overlay messages-timer-overlay" role="presentation" onClick={() => setGlobalTimerOpen(false)}>
          <section
            className="messages-fullscreen-panel messages-global-timer-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="messages-global-timer-title"
            dir="rtl"
            onClick={event => event.stopPropagation()}
          >
            <header className="messages-fullscreen-header">
              <h1 id="messages-global-timer-title">مؤقت المحادثات</h1>
              <button type="button" aria-label="إغلاق" onClick={() => setGlobalTimerOpen(false)}><X size={22} /></button>
            </header>
            <div className="messages-global-timer-content">
              <p>اختر مدة حذف الرسائل الجديدة تلقائياً في جميع محادثاتك.</p>
              {globalExpirationLoading ? <ListSkeleton count={3} /> : GLOBAL_MESSAGE_EXPIRATION_OPTIONS.map(option => (
                <button
                  key={option.seconds ?? 'off'}
                  type="button"
                  className={globalExpirationSeconds === option.seconds ? 'is-selected' : ''}
                  disabled={globalExpirationSaving}
                  onClick={() => { void updateGlobalMessageExpiration(option.seconds); }}
                >
                  <span>{option.label}</span>
                  {globalExpirationSeconds === option.seconds && <Check size={19} />}
                </button>
              ))}
              <small>يسري الاختيار على الرسائل الجديدة في جميع المحادثات.</small>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {archivedOpen && createPortal(
        <div className="messages-fullscreen-overlay messages-archive-overlay" role="presentation" onClick={() => setArchivedOpen(false)}>
          <section
            className="messages-fullscreen-panel messages-archive-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="messages-archive-title"
            dir="rtl"
            onClick={event => event.stopPropagation()}
          >
            <header className="messages-fullscreen-header">
              <h1 id="messages-archive-title">المحادثات المؤرشفة</h1>
              <button type="button" aria-label="إغلاق" onClick={() => setArchivedOpen(false)}><X size={22} /></button>
            </header>
            <p className="messages-archive-note">تبقى المحادثات هنا بهدوء حتى عند وصول رسائل جديدة.</p>
            <div className="messages-archive-list">
              {archivedConversations.length === 0 ? (
                <div className="messages-list-empty"><EmptyState className="py-6" /></div>
              ) : archivedConversations.map(conversation => (
                <div className="messages-archive-item" key={conversation.profile.id}>
                  <Link
                    href={`/messages/${encodeURIComponent(conversation.profile.id)}`}
                    className="messages-archive-person"
                    onClick={() => { setArchivedOpen(false); markConversationRead(conversation.profile.id); }}
                  >
                    <Avatar profile={conversation.profile} large />
                    <span className="messages-archive-copy">
                      <span className="messages-archive-name">{displayName(conversation.profile)}</span>
                      <span className="messages-archive-preview">{messagePreview(conversation.lastMessage, currentUserId)}</span>
                    </span>
                    <time>{conversation.lastMessage ? formatConversationTime(conversation.lastMessage.created_at) : ''}</time>
                  </Link>
                  <button
                    type="button"
                    className="messages-archive-restore"
                    aria-label={`إلغاء أرشفة ${displayName(conversation.profile)}`}
                    title="إلغاء الأرشفة"
                    onClick={() => {
                      setConversationPreference('archivedIds', conversation.profile.id, false);
                      toast.success('تم إلغاء أرشفة المحادثة');
                    }}
                  >
                    <Archive size={17} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>,
        document.body,
      )}

    </section>
  );
}
