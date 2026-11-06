import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowUpLeft, Send } from 'lucide-react';

import Avatar from '@/components/Avatar';
import SharedPostPreview from '@/components/SharedPostPreview';
import UserIdentity from '@/components/UserIdentity';
import StoryDmCard, { type StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
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
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [target, setTarget] = useState<Profile | null>(null);
  const [thread, setThread] = useState<MessageRow[]>([]);
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
        setThread(normalizeMessageRows(fallback));
        return;
      }
      console.error('[messages] تعذر جلب المحادثة:', error);
      setThread([]);
      return;
    }

    setThread(normalizeMessageRows(data));
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
        const { data: profs } = await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url').in('id', ids);
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

    try {
      const { error } = await supabase.from('messages').insert({ sender_id: currentUserId, recipient_id: selectedId, content: text.trim() });
      if (error) throw error;
    } catch (error) {
      console.error('[messages] تعذر إرسال الرسالة:', error);
      alert('تعذر إرسال الرسالة. تحقق من الاتصال وحاول مرة أخرى.');
      return;
    }

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
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <Avatar profile={c} />
                  <UserIdentity
                    name={displayName(c)}
                    username={c.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-xs text-white"
                    usernameClassName="text-[10px] text-zinc-400"
                  />
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
            {target && (
              <UserIdentity
                name={displayName(target)}
                username={target.username}
                className="min-w-0 max-w-[55%]"
                nameClassName="text-xs text-white"
                usernameClassName="text-[10px] text-zinc-400"
              />
            )}
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
