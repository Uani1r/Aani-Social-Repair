import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, ChevronDown, MessageCircle, Pencil, Search, Send, X } from 'lucide-react';
import Avatar from '@/components/Avatar';
import SharedPostPreview from '@/components/SharedPostPreview';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import UserIdentity from '@/components/UserIdentity';
import { supabase, supabaseConfigured } from '@/lib/supabase';
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

type InboxTab = 'messages' | 'requests';

const PROFILE_FIELDS = 'id, username, full_name, display_name, avatar_url';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  let preview = content;
  if (message.post_id || content.startsWith('[post:')) preview = 'مشاركة منشور';
  else if (content.startsWith('[story-reply]')) preview = 'رد على قصة';
  else if (content.startsWith('[story:')) preview = 'أرسل قصة';
  else if (!preview) preview = 'رسالة';
  return message.sender_id === currentUserId ? `أنت: ${preview}` : preview;
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
  const safeThread = Array.isArray(thread)
    ? thread.filter(message => Boolean(message && typeof message.id === 'string' && typeof message.sender_id === 'string' && typeof message.content === 'string'))
    : [];
  const [threadLoading, setThreadLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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
  const threadRequestRef = useRef(0);
  const contactsRequestRef = useRef(0);
  const threadEndRef = useRef<HTMLDivElement>(null);

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
      const [profileResult, messagesResult, followsResult] = await Promise.all([
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
      ]);

      if (requestId !== contactsRequestRef.current) return;
      if (profileResult.error) throw profileResult.error;
      if (messagesResult.error) throw messagesResult.error;
      if (followsResult.error) throw followsResult.error;
      setCurrentProfile((profileResult.data || null) as Profile | null);

      const latestByContact = new Map<string, MessageRow>();
      normalizeMessageRows(messagesResult.data).forEach(message => {
        const contactId = message.sender_id === currentUserId ? message.recipient_id : message.sender_id;
        if (!latestByContact.has(contactId)) latestByContact.set(contactId, message);
      });
      const contactIds = [...latestByContact.keys()];
      if (selectedId && !contactIds.includes(selectedId)) contactIds.push(selectedId);
      const connectedIds = new Set<string>();
      (followsResult.data || []).forEach(follow => {
        if (follow.follower_id === currentUserId) connectedIds.add(follow.following_id);
        if (follow.following_id === currentUserId) connectedIds.add(follow.follower_id);
      });
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

      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '42703' || /post_id|story_id/i.test(error.message || '')) {
          const { data: fallback, error: fallbackError } = await supabase
            .from('messages')
            .select('id, sender_id, recipient_id, content, created_at')
            .or(threadFilter)
            .order('created_at', { ascending: true });
          if (fallbackError) throw fallbackError;
          if (requestId === threadRequestRef.current) setThread(normalizeMessageRows(fallback));
        } else {
          throw error;
        }
      } else if (requestId === threadRequestRef.current) {
        setThread(normalizeMessageRows(data));
      }
    } catch (error) {
      if (requestId !== threadRequestRef.current) return;
      console.error('[messages] تعذر جلب المحادثة:', error);
      setThread([]);
    } finally {
      if (requestId === threadRequestRef.current) setThreadLoading(false);
    }
  }, [currentUserId, selectedId]);

  useEffect(() => {
    void loadConversationList();
    if (!supabaseConfigured) return;
    const channel = supabase.channel(`messages-inbox-${currentUserId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `recipient_id=eq.${currentUserId}`,
      }, () => void loadConversationList())
      .subscribe();
    return () => {
      contactsRequestRef.current += 1;
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, loadConversationList]);

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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
        void loadThread();
        void loadConversationList();
      })
      .subscribe();
    return () => {
      threadRequestRef.current += 1;
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, selectedId, loadConversationList, loadThread]);

  const lastThreadMessageId = safeThread[safeThread.length - 1]?.id;
  useEffect(() => {
    if (selectedId) markConversationRead(selectedId);
  }, [selectedId, lastThreadMessageId, markConversationRead]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: safeThread.length ? 'smooth' : 'auto' });
  }, [thread, selectedId]);

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

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = text.trim();
    if (!selectedId || !content || sending || !supabaseConfigured) return;

    setSending(true);
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: selectedId,
        content,
      });
      if (error) throw error;
      await Promise.all([loadThread(), loadConversationList()]);
      setText('');
    } catch (error) {
      console.error('[messages] تعذر إرسال الرسالة:', error);
      alert(error instanceof Error ? error.message : 'تعذر إرسال الرسالة. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const tabConversations = useMemo(() => (
    activeTab === 'requests'
      ? conversations.filter(conversation => conversation.isRequest)
      : conversations.filter(conversation => !conversation.isRequest)
  ), [activeTab, conversations]);
  const searchNeedle = searchTerm.trim().toLocaleLowerCase();
  const matchingConversationCount = tabConversations.filter(conversation => (
    `${displayName(conversation.profile)} ${conversation.profile.username || ''}`.toLocaleLowerCase().includes(searchNeedle)
  )).length;
  const requestCount = conversations.filter(conversation => conversation.isRequest).length;
  const target = conversations.find(conversation => conversation.profile.id === selectedId)?.profile || null;

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
            <button type="button" className="messages-new-button" aria-label="رسالة جديدة" title="رسالة جديدة" onClick={openNewMessage}>
              <Pencil size={20} strokeWidth={2} />
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
            <button type="button" role="tab" aria-selected={activeTab === 'requests'} className={`messages-tab${activeTab === 'requests' ? ' active' : ''}`} onClick={() => setActiveTab('requests')}>
              <span>الطلبات</span>
              {requestCount > 0 && <span className="messages-tab-badge">{requestCount > 99 ? '99+' : requestCount}</span>}
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
                {!contactsLoading && !contactsError && tabConversations.map(conversation => {
                  const isUnread = Boolean(conversation.lastMessage
                    && conversation.lastMessage.sender_id !== currentUserId
                    && Date.parse(conversation.lastMessage.created_at) > (Date.parse(readAtByContact[conversation.profile.id] || '') || 0));
                  const matchesSearch = `${displayName(conversation.profile)} ${conversation.profile.username || ''}`
                    .toLocaleLowerCase()
                    .includes(searchNeedle);
                  const isOnline = onlineUserIds.has(conversation.profile.id);
                  return (
                    <Link
                      key={conversation.profile.id}
                      href={`/messages/${encodeURIComponent(conversation.profile.id)}`}
                      hidden={!matchesSearch}
                      aria-current={selectedId === conversation.profile.id ? 'page' : undefined}
                      onClick={() => markConversationRead(conversation.profile.id)}
                      className={`messages-chat-item${selectedId === conversation.profile.id ? ' active' : ''}${isUnread ? ' unread' : ''}`}
                    >
                      <span className={`messages-avatar-wrap${conversation.hasStory ? ' has-story' : ''}${isOnline ? ' is-online' : ''}`}>
                        <span className="messages-avatar-inner"><Avatar profile={conversation.profile} large /></span>
                        {isOnline && <span className="messages-online-dot" aria-label="متصل الآن" />}
                      </span>
                      <span className="messages-chat-copy">
                        <span className="messages-chat-topline">
                          <span className={`messages-chat-name${isUnread ? ' is-unread' : ''}`}>{displayName(conversation.profile)}</span>
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
                    <span>{activeTab === 'requests' ? 'لا توجد طلبات مراسلة' : 'لا توجد محادثات بعد'}</span>
                    <small>{activeTab === 'requests' ? 'ستظهر هنا الرسائل الواردة من حسابات غير متصلة بك.' : 'ابدأ محادثة جديدة مع أحد الحسابات.'}</small>
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
                <button
                  type="button"
                  className="messages-mobile-back"
                  aria-label="العودة إلى قائمة الرسائل"
                  onClick={() => setLocation('/messages')}
                >
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
              </header>
              <div className="messages-thread-list" aria-live="polite">
                {threadLoading && safeThread.length === 0 && <div className="messages-thread-status">جارٍ تحميل الرسائل...</div>}
                {!threadLoading && safeThread.length === 0 && (
                  <div className="messages-thread-start">أرسل أول رسالة لبدء المحادثة.</div>
                )}
                {safeThread?.map(message => {
                  const isMine = message.sender_id === currentUserId;
                  const content = message.content.trim();
                  const isSharedPost = Boolean(message.post_id) || content.startsWith('[post:');
                  const storyFromColumn = message.story_id ? String(message.story_id) : null;
                  const storyFromContent = content.startsWith('[story:') ? content.slice(7).split(']')[0] : null;
                  const sharedStoryId = storyFromColumn || storyFromContent;
                  const isStoryReply = Boolean(message.story_id) && content.startsWith('[story-reply]');
                  const isSharedStory = Boolean(sharedStoryId) && !isSharedPost && !isStoryReply;
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
                    </div>
                  );
                })}
                    <div ref={threadEndRef} />
              </div>
              <form className="messages-composer" onSubmit={sendMessage}>
                <input
                  value={text}
                  onChange={event => setText(event.target.value)}
                  placeholder="اكتب رسالة..."
                  aria-label="اكتب رسالة"
                  autoComplete="off"
                />
                <button type="submit" aria-label="إرسال الرسالة" disabled={!text.trim() || sending}>
                  <Send size={19} />
                </button>
              </form>
            </>
          )}
        </main>
      </div>

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
