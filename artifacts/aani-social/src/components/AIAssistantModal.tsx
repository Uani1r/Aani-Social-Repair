import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Loader2, Send, Sparkles, X } from 'lucide-react';

import { supabase } from '@/lib/supabase';

export default function AIAssistantModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        .filter(message => !message.error)
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
      setMessages(current => [
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
      <div className="bg-zinc-900 border border-zinc-800 w-full max-w-lg h-[580px] rounded-3xl shadow-2xl flex flex-col overflow-hidden text-white" onClick={event => event.stopPropagation()}>
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
          {messages.map((message, index) => (
            <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] p-3 rounded-2xl leading-relaxed whitespace-pre-wrap break-words ${
                message.role === 'user'
                  ? 'bg-pink-600 text-white rounded-br-none'
                  : message.error
                    ? 'bg-red-500/10 border border-red-500/30 text-red-400 rounded-bl-none'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-bl-none'
              }`}>
                {message.content}
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
            onChange={event => setInput(event.target.value)}
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
