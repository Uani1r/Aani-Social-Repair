import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'wouter';
import { Archive, ArrowLeft, Ban, BellOff, Camera, ChevronDown, Flag, MessageCircle, Mic, MoreVertical, Phone, Pin, Plus, Search, Send, Smile, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import ChatImageMessage, { hasViewedOnce, openedChatMediaContent, parseChatMediaMessage } from '@/components/ChatImageMessage';
import ChatMediaPicker, { type PendingChatMediaMessage } from '@/components/ChatMediaPicker';
import SharedPostPreview from '@/components/SharedPostPreview';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import UserIdentity from '@/components/UserIdentity';
import { storageBucket, supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  post_id: string | null;
  story_id: string | null;
  created_at: string;
}

interface ConversationSummary {
  profile: Profile;
  lastMessage: MessageRow | null;
  hasStory: boolean;
  isRequest: boolean;
}

type InboxTab = 'messages' | 'requests' | 'archived';

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

const PROFILE_FIELDS = 'id, username, full_name, display_name, avatar_url';
const MESSAGE_EMOJIS = ['😀', '😂', '🥰', '😍', '😊', '😭', '👍', '❤️', '✨', '🙏', '😎'];
const MESSAGE_STICKERS = ['🥹', '🫶', '🎉', '🤍', '🌙', '💜'];
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

async function loadHiddenMessageIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('message_hides')
    .select('message_id')
    .eq('user_id', userId);
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
      created_at: typeof item.created_at === 'string' ? item.created_at : '',
    }];
  });
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

function messagePreview(message: MessageRow | null, currentUserId: string): string {
  if (!message) return 'ابدأ محادثة جديدة';
  const content = message.content.trim();
  const mediaMessage = parseChatMediaMessage(content);
  let preview = content;
  if (mediaMessage) {
    const hasOpened = mediaMessage.opened || hasViewedOnce(currentUserId, message.id);
    preview = mediaMessage.viewOnce
      ? (hasOpened ? 'صورة مؤقتة · تم الفتح' : 'صورة مؤقتة')
      : mediaMessage.caption || (mediaMessage.urls.length > 1 ? 'صور' : 'صورة');
  } else if (message.post_id || content.startsWith('[post:')) preview = 'مشاركة منشور';
  else if (content.startsWith('[story-reply]')) preview = 'رد على قصة';
  else if (content.startsWith('[story:')) preview = 'أرسل قصة';
  else if (!preview) preview = 'رسالة';
  return message.sender_id === currentUserId ? `أنت: ${preview}` : preview;
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

export default function MessagesPage({
  currentUserId,
  selectedId,
  onReshareStory,
}: {
  currentUserId: string;
  selectedId?: string;
  onReshareStory: (story: StoryDmCardStory) => void;
}) {
  const [, setLocation] = useLocation();
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [thread, setThread] = useState<MessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [pendingMediaMessage, setPendingMediaMessage] = useState<PendingChatMediaMessage | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiPickerTab, setEmojiPickerTab] = useState<'emoji' | 'stickers'>('emoji');
  const [threadOptionsOpen, setThreadOptionsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InboxTab>('messages');
  const [searchTerm, setSearchTerm] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());
  const [readAtByContact, setReadAtByContact] = useState<Record<string, string>>(() => readConversationReadTimes(currentUserId));
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
  const selectedIdRef = useRef(selectedId);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextConversationClickRef = useRef(false);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    setConversationPreferences(readConversationPreferences(currentUserId));
  }, [currentUserId]);

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
    setReadAtByContact(current => {
      const next = { ...current, [contactId]: readAt };
      try {
        localStorage.setItem(`aani_message_read_at_${currentUserId}`, JSON.stringify(next));
      } catch {
        /* التخزين المحلي غير متاح */
      }
      return next;
    });
  }, [currentUserId]);

  useLayoutEffect(() => {
    const input = messageInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    input.scrollTop = input.scrollHeight;
  }, [text, selectedId]);

  const loadConversationList = useCallback(async () => {
    const requestId = ++contactsRequestRef.current;
    if (!supabaseConfigured) {
      setCurrentProfile(null);
      setConversations([]);
      setContactsLoading(false);
      return;
    }

    setContactsLoading(true);
    setContactsError(null);
    try {
      const [profileResult, messagesResult, followsResult, hiddenMessageIds] = await Promise.all([
        supabase.from('profiles').select(PROFILE_FIELDS).eq('id', currentUserId).maybeSingle(),
        supabase
          .from('messages')
          .select('id, sender_id, recipient_id, content, created_at')
          .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
          .order('created_at', { ascending: false }),
        supabase
          .from('follows')
          .select('follower_id, following_id')
          .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`),
        loadHiddenMessageIds(currentUserId),
      ]);

      if (requestId !== contactsRequestRef.current) return;
      if (profileResult.error) throw profileResult.error;
      if (messagesResult.error) throw messagesResult.error;
      if (followsResult.error) throw followsResult.error;
      setCurrentProfile((profileResult.data || null) as Profile | null);

      const latestByContact = new Map<string, MessageRow>();
      normalizeMessageRows(messagesResult.data).filter(message => !hiddenMessageIds.has(message.id)).forEach(message => {
        const contactId = message.sender_id === currentUserId ? message.recipient_id : message.sender_id;
        const mediaMessage = parseChatMediaMessage(message.content);
        const safeMessage = mediaMessage?.viewOnce && (mediaMessage.opened || hasViewedOnce(currentUserId, message.id))
          ? { ...message, content: openedChatMediaContent(message.content) }
          : message;
        if (!latestByContact.has(contactId)) latestByContact.set(contactId, safeMessage);
      });
      const contactIds = [...latestByContact.keys()];
      if (selectedId && !contactIds.includes(selectedId)) contactIds.push(selectedId);

      const profilesResult = contactIds.length
        ? await supabase.from('profiles').select(PROFILE_FIELDS).in('id', contactIds)
        : { data: [], error: null };
      if (requestId !== contactsRequestRef.current) return;
      if (profilesResult.error) throw profilesResult.error;

      const storiesResult = contactIds.length
        ? await supabase.from('stories').select('user_id').in('user_id', contactIds).gt('expires_at', new Date().toISOString())
        : { data: [], error: null };
      if (requestId !== contactsRequestRef.current) return;
      const storyUserIds = new Set((storiesResult.data || []).map(story => story.user_id as string));
      const connectedIds = new Set<string>();
      (followsResult.data || []).forEach(follow => {
        if (follow.follower_id === currentUserId) connectedIds.add(follow.following_id);
        if (follow.following_id === currentUserId) connectedIds.add(follow.follower_id);
      });
      const profileById = new Map<string, Profile>(((profilesResult.data || []) as Profile[]).map(profile => [profile.id, profile] as [string, Profile]));

      setConversations(contactIds.flatMap(contactId => {
        const profile = profileById.get(contactId);
        if (!profile) return [];
        const lastMessage = latestByContact.get(contactId) || null;
        return [{
          profile,
          lastMessage,
          hasStory: storyUserIds.has(contactId),
          isRequest: Boolean(lastMessage && lastMessage.sender_id !== currentUserId && !connectedIds.has(contactId)),
        }];
      }));
    } catch (error) {
      if (requestId !== contactsRequestRef.current) return;
      console.error('[messages] تعذر تحميل قائمة المحادثات:', error);
      setContactsError('تعذر تحميل المحادثات الآن. حاول مرة أخرى.');
      setConversations([]);
    } finally {
      if (requestId === contactsRequestRef.current) setContactsLoading(false);
    }
  }, [currentUserId, selectedId]);

  const loadThread = useCallback(async () => {
    if (!supabaseConfigured || !selectedId) return;
    const requestId = ++threadRequestRef.current;
    const threadFilter = `and(sender_id.eq.${currentUserId},recipient_id.eq.${selectedId}),and(sender_id.eq.${selectedId},recipient_id.eq.${currentUserId})`;
    setThreadLoading(true);

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, recipient_id, content, post_id, story_id, created_at')
        .or(threadFilter)
        .order('created_at', { ascending: true });
      const hiddenMessageIds = await loadHiddenMessageIds(currentUserId);
      const visibleMessages = (rows: unknown) => normalizeMessageRows(rows)
        .filter(message => !hiddenMessageIds.has(message.id))
        .map(message => {
          const mediaMessage = parseChatMediaMessage(message.content);
          return mediaMessage?.viewOnce && (mediaMessage.opened || hasViewedOnce(currentUserId, message.id))
            ? { ...message, content: openedChatMediaContent(message.content) }
            : message;
        });

      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '42703' || /post_id|story_id/i.test(error.message || '')) {
          const { data: fallback, error: fallbackError } = await supabase
            .from('messages')
            .select('id, sender_id, recipient_id, content, created_at')
            .or(threadFilter)
            .order('created_at', { ascending: true });
          if (fallbackError) throw fallbackError;
          if (requestId === threadRequestRef.current) setThread(visibleMessages(fallback));
        } else {
          throw error;
        }
      } else if (requestId === threadRequestRef.current) {
        setThread(visibleMessages(data));
      }
    } catch (error) {
      if (requestId !== threadRequestRef.current) return;
      console.error('[messages] تعذر جلب المحادثة:', error);
      setThread([]);
    } finally {
      if (requestId === threadRequestRef.current) setThreadLoading(false);
    }
  }, [currentUserId, selectedId]);

  const markViewOnceMessageOpened = useCallback(async (messageId: string, urls: string[]) => {
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
  }, []);

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
      }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, () => scheduleMessageRefresh(false))
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'message_hides',
        filter: `user_id=eq.${currentUserId}`,
      }, () => scheduleMessageRefresh(false))
      .subscribe();
    return () => {
      contactsRequestRef.current += 1;
      clearScheduledMessageRefresh();
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, loadConversationList, scheduleMessageRefresh, clearScheduledMessageRefresh]);

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

  useEffect(() => {
    if (!selectedId) {
      threadRequestRef.current += 1;
      setThread([]);
      setThreadLoading(false);
      return;
    }

    setThread([]);
    void loadThread();
    if (!supabaseConfigured) return;
    const channel = supabase.channel(`realtime-msgs-${currentUserId}-${selectedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => scheduleMessageRefresh(true))
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

  const lastThreadMessageId = thread[thread.length - 1]?.id;
  useEffect(() => {
    if (selectedId) markConversationRead(selectedId);
  }, [selectedId, lastThreadMessageId, markConversationRead]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: thread.length || pendingMediaMessage ? 'smooth' : 'auto' });
  }, [pendingMediaMessage, thread, selectedId]);

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
              supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('username', pattern).limit(12),
              supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('full_name', pattern).limit(12),
              supabase.from('profiles').select(PROFILE_FIELDS).neq('id', currentUserId).ilike('display_name', pattern).limit(12),
            ]);
            const error = usernameResult.error || fullNameResult.error || displayNameResult.error;
            if (error) throw error;
            rows = [
              ...((usernameResult.data || []) as Profile[]),
              ...((fullNameResult.data || []) as Profile[]),
              ...((displayNameResult.data || []) as Profile[]),
            ];
          } else {
            const { data, error } = await supabase
              .from('profiles')
              .select(PROFILE_FIELDS)
              .neq('id', currentUserId)
              .order('username', { ascending: true })
              .limit(20);
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

  const insertComposerSymbol = (symbol: string) => {
    setText(value => `${value}${symbol}`);
    setEmojiPickerOpen(false);
    messageInputRef.current?.focus();
  };

  const openChatMediaPicker = () => {
    if (!selectedId) return;
    setEmojiPickerOpen(false);
    window.dispatchEvent(new CustomEvent('aani-open-chat-media-picker', { detail: { caption: text, recipientId: selectedId } }));
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = text.trim();
    if (!supabaseConfigured || !selectedId || !content || sending) return;

    setEmojiPickerOpen(false);
    setSending(true);
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: selectedId,
        content,
      });
      if (error) throw error;
      setText('');
      await Promise.all([loadThread(), loadConversationList()]);
    } catch (error) {
      console.error('[messages] تعذر إرسال الرسالة:', error);
      alert('تعذر إرسال الرسالة. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const tabConversations = useMemo(() => (
    activeTab === 'archived'
      ? conversations.filter(conversation => conversationPreferences.archivedIds.includes(conversation.profile.id))
      : activeTab === 'requests'
        ? conversations.filter(conversation => !conversationPreferences.archivedIds.includes(conversation.profile.id) && conversation.isRequest)
        : conversations.filter(conversation => !conversationPreferences.archivedIds.includes(conversation.profile.id) && !conversation.isRequest)
  ), [activeTab, conversations, conversationPreferences.archivedIds]);
  const orderedTabConversations = useMemo(() => [...tabConversations].sort((left, right) => (
    Number(conversationPreferences.pinnedIds.includes(right.profile.id)) - Number(conversationPreferences.pinnedIds.includes(left.profile.id))
  )), [conversationPreferences.pinnedIds, tabConversations]);
  const searchNeedle = searchTerm.trim().toLocaleLowerCase();
  const matchingConversationCount = tabConversations.filter(conversation => (
    `${displayName(conversation.profile)} ${conversation.profile.username || ''}`.toLocaleLowerCase().includes(searchNeedle)
  )).length;
  const requestCount = conversations.filter(conversation => (
    conversation.isRequest && !conversationPreferences.archivedIds.includes(conversation.profile.id)
  )).length;
  const archivedCount = conversations.filter(conversation => conversationPreferences.archivedIds.includes(conversation.profile.id)).length;
  const selectedConversation = conversations.find(conversation => conversation.profile.id === selectedId) || null;
  const target = selectedConversation?.profile || null;
  const selectedPendingMediaMessage = pendingMediaMessage?.recipientId === selectedId ? pendingMediaMessage : null;

  const setConversationPreference = (key: ConversationPreferenceKey, contactId: string, enabled: boolean) => {
    setConversationPreferences(current => {
      const next = updatePreferenceList(current, key, contactId, enabled);
      writeConversationPreferences(currentUserId, next);
      return next;
    });
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

  const openNewMessage = () => {
    setUserMenuOpen(false);
    setNewMessageSearch('');
    setNewMessageProfiles([]);
    setNewMessageError(null);
    setNewMessageOpen(true);
  };

  return (
    <section className="messages-view" dir="rtl">
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
            <button type="button" className="messages-new-text-button" onClick={openNewMessage}>رسالة جديدة</button>
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
            <button type="button" role="tab" aria-selected={activeTab === 'requests'} className={`messages-tab${activeTab === 'requests' ? ' active' : ''}`} onClick={() => setActiveTab('requests')}>
              <span>الطلبات</span>
              {requestCount > 0 && <span className="messages-tab-badge">{requestCount > 99 ? '99+' : requestCount}</span>}
            </button>
            <button type="button" role="tab" aria-selected={activeTab === 'archived'} className={`messages-tab${activeTab === 'archived' ? ' active' : ''}`} onClick={() => setActiveTab('archived')}>
              <span>المؤرشفة</span>
              {archivedCount > 0 && <span className="messages-tab-badge">{archivedCount > 99 ? '99+' : archivedCount}</span>}
            </button>
          </div>

          <div className="messages-list-wrap">
            {contactsLoading && <div className="messages-list-status">جارٍ تحميل المحادثات...</div>}
            {!contactsLoading && contactsError && (
              <div className="messages-list-status" role="alert">
                <span>{contactsError}</span>
                <button type="button" onClick={() => void loadConversationList()}>إعادة المحاولة</button>
              </div>
            )}
            {!contactsLoading && !contactsError && orderedTabConversations.map(conversation => {
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
                  <span className={`messages-avatar-wrap${conversation.hasStory ? ' has-story' : ''}${isOnline ? ' is-online' : ''}`}>
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
            {!contactsLoading && !contactsError && tabConversations.length > 0 && matchingConversationCount === 0 && (
              <div className="messages-list-status">لا توجد محادثات مطابقة.</div>
            )}
            {!contactsLoading && !contactsError && tabConversations.length === 0 && (
              <div className="messages-list-empty">
                <MessageCircle size={26} />
                <span>{activeTab === 'requests' ? 'لا توجد طلبات مراسلة' : activeTab === 'archived' ? 'لا توجد محادثات مؤرشفة' : 'لا توجد محادثات بعد'}</span>
                <small>{activeTab === 'requests' ? 'ستظهر هنا الرسائل الواردة من حسابات غير متصلة بك.' : activeTab === 'archived' ? 'ستظهر هنا المحادثات التي أرشفتها.' : 'ابدأ محادثة جديدة مع أحد الحسابات.'}</small>
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
                    <span className="messages-thread-placeholder">جارٍ تحميل الحساب...</span>
                  </div>
                )}
                <div className="messages-thread-actions">
                  <button type="button" aria-label="اتصال صوتي" onClick={() => toast.info('المكالمات الصوتية غير متاحة حالياً.')}>
                    <Phone size={20} />
                  </button>
                  <button
                    type="button"
                    aria-label="خيارات المحادثة"
                    aria-expanded={threadOptionsOpen}
                    onClick={() => setThreadOptionsOpen(value => !value)}
                  >
                    <MoreVertical size={21} />
                  </button>
                  {threadOptionsOpen && selectedConversation && (
                    <div className="messages-thread-options-menu" role="menu" aria-label="خيارات المحادثة">
                      <button type="button" role="menuitem" onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('pin', selectedConversation); }}>
                        <Pin size={17} />
                        <span>{conversationPreferences.pinnedIds.includes(selectedConversation.profile.id) ? 'إلغاء التثبيت' : 'تثبيت'}</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('archive', selectedConversation); }}>
                        <Archive size={17} />
                        <span>{conversationPreferences.archivedIds.includes(selectedConversation.profile.id) ? 'إلغاء الأرشفة' : 'أرشفة'}</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('mute', selectedConversation); }}>
                        <BellOff size={17} />
                        <span>{conversationPreferences.mutedIds.includes(selectedConversation.profile.id) ? 'إلغاء الكتم' : 'كتم'}</span>
                      </button>
                      <button type="button" role="menuitem" disabled={moderationBusy} onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('block', selectedConversation); }}>
                        <Ban size={17} />
                        <span>حظر</span>
                      </button>
                      <button type="button" role="menuitem" disabled={moderationBusy} onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('report', selectedConversation); }}>
                        <Flag size={17} />
                        <span>إبلاغ</span>
                      </button>
                      <button type="button" role="menuitem" className="is-destructive" disabled={deleteBusy} onClick={() => { setThreadOptionsOpen(false); void handleConversationAction('delete', selectedConversation); }}>
                        <Trash2 size={17} />
                        <span>حذف</span>
                      </button>
                    </div>
                  )}
                </div>
              </header>
              <div className="messages-thread-list" aria-live="polite">
                {threadLoading && thread.length === 0 && <div className="messages-thread-status">جارٍ تحميل الرسائل...</div>}
                {!threadLoading && thread.length === 0 && !selectedPendingMediaMessage && (
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
                  const isStoryReply = Boolean(message.story_id) && content.startsWith('[story-reply]');
                  const isSharedStory = Boolean(sharedStoryId) && !isSharedPost && !isStoryReply;
                  const mediaMessage = parseChatMediaMessage(content);
                  return (
                    <div key={message.id} className={`messages-message-row${isMine ? ' is-mine' : ' is-theirs'}`}>
                      {isSharedPost ? (
                        <div className="messages-rich-message"><SharedPostPreview postId={message.post_id} content={message.content} /></div>
                      ) : isSharedStory ? (
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
                      ) : mediaMessage ? (
                        <ChatImageMessage
                          messageId={message.id}
                          currentUserId={currentUserId}
                          payload={mediaMessage}
                          isMine={isMine}
                          createdAt={message.created_at}
                          onViewOnceOpened={(messageId, urls) => { void markViewOnceMessageOpened(messageId, urls); }}
                        />
                      ) : (
                        <div className={`messages-bubble${isMine ? ' is-mine' : ' is-theirs'}`}>
                          {isStoryReply ? (
                            <>
                              <span className="messages-story-reply-label">رد على الستوري</span>
                              <span>{content.slice('[story-reply]'.length).trim()}</span>
                            </>
                          ) : content.startsWith('[story:') ? 'أرسل لك قصة' : message.content}
                        </div>
                      )}
                      {!isMine && (
                        <span className="messages-sender-avatar" aria-hidden="true">
                          {showSenderAvatar && <Avatar profile={target} />}
                        </span>
                      )}
                    </div>
                  );
                })}
                {selectedPendingMediaMessage && (
                  <div key={selectedPendingMediaMessage.id} className="messages-message-row is-mine">
                    <div className="messages-image-message messages-media-pending" aria-label="جارٍ إرسال الصور">
                      <div className={`messages-image-grid messages-media-pending-grid${selectedPendingMediaMessage.urls.length > 1 ? ' has-multiple' : ''}`}>
                        {selectedPendingMediaMessage.urls.map((url, index) => (
                          <img key={`${selectedPendingMediaMessage.id}-${index}`} src={url} alt={`صورة قيد الإرسال ${index + 1}`} />
                        ))}
                        <span className="messages-media-pending-indicator" role="status" aria-label="جارٍ إرسال الصور">
                          <span className="messages-media-pending-spinner" />
                        </span>
                      </div>
                      {selectedPendingMediaMessage.caption && (
                        <div className="messages-image-caption messages-bubble is-mine">{selectedPendingMediaMessage.caption}</div>
                      )}
                    </div>
                  </div>
                )}
                <div ref={threadEndRef} />
              </div>
              <form className="messages-composer" onSubmit={sendMessage}>
                <button
                  type="button"
                  className="messages-composer-control messages-composer-attach"
                  aria-label="إضافة صور"
                  onClick={openChatMediaPicker}
                >
                  <Plus size={24} />
                </button>
                <div className="messages-composer-field">
                  <textarea
                    ref={messageInputRef}
                    value={text}
                    onChange={event => setText(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="اكتب رسالة..."
                    aria-label="اكتب رسالة"
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
                    onClick={() => setEmojiPickerOpen(value => !value)}
                  >
                    <Smile size={19} />
                  </button>
                  {text.length === 0 ? (
                    <>
                      <button type="button" className="messages-composer-control messages-composer-empty-action" aria-label="تسجيل رسالة صوتية" onClick={() => toast.info('الرسائل الصوتية غير متاحة حالياً.')}>
                        <Mic size={22} />
                      </button>
                      <button type="button" className="messages-composer-control messages-composer-empty-action" aria-label="اختيار صورة أو التقاط صورة" onClick={openChatMediaPicker}>
                        <Camera size={22} />
                      </button>
                    </>
                  ) : (
                    <button type="submit" className="messages-composer-control messages-composer-send" aria-label="إرسال الرسالة" disabled={!text.trim() || sending}>
                      <Send size={20} />
                    </button>
                  )}
                </div>
                {emojiPickerOpen && (
                  <div className="messages-emoji-picker" role="dialog" aria-label="الإيموجي والملصقات">
                    <div className="messages-emoji-tabs" role="tablist" aria-label="نوع التعبير">
                      <button type="button" role="tab" aria-selected={emojiPickerTab === 'emoji'} className={emojiPickerTab === 'emoji' ? 'active' : ''} onClick={() => setEmojiPickerTab('emoji')}>إيموجي</button>
                      <button type="button" role="tab" aria-selected={emojiPickerTab === 'stickers'} className={emojiPickerTab === 'stickers' ? 'active' : ''} onClick={() => setEmojiPickerTab('stickers')}>ملصقات</button>
                    </div>
                    <div className={`messages-emoji-grid${emojiPickerTab === 'stickers' ? ' is-stickers' : ''}`}>
                      {(emojiPickerTab === 'emoji' ? MESSAGE_EMOJIS : MESSAGE_STICKERS).map(symbol => (
                        <button key={symbol} type="button" className="messages-emoji-option" aria-label={`إضافة ${symbol}`} onClick={() => insertComposerSymbol(symbol)}>
                          {symbol}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </form>
            </>
          )}
        </main>
      </div>

      <ChatMediaPicker
        currentUserId={currentUserId}
        recipientId={selectedId}
        onSendStart={message => setPendingMediaMessage(message)}
        onSent={async (pendingId, recipientId) => {
          const refreshes: Promise<void>[] = [loadConversationList()];
          if (recipientId === selectedIdRef.current) refreshes.push(loadThread());
          await Promise.all(refreshes);
          setPendingMediaMessage(current => current?.id === pendingId ? null : current);
        }}
        onSendFailed={pendingId => setPendingMediaMessage(current => current?.id === pendingId ? null : current)}
      />

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
              {newMessageLoading && <div className="messages-list-status">جارٍ البحث...</div>}
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
                <div className="messages-list-status">لا توجد حسابات مطابقة.</div>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
