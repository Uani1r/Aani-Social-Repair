import { useState, type FormEvent } from 'react';
import { SendHorizontal, Settings, Sparkles, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import type { SettingsModalProps } from '@/lib/appShared';
import { displayName } from '@/lib/types';

export default function SettingsModal({ isOpen, onClose, currentProfile, onSignOut }: SettingsModalProps) {
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
              <div className="user-identity-meta h-12 min-w-0 flex-1">
                <strong className="block truncate text-sm leading-tight">{displayName(currentProfile)}</strong>
                {currentProfile?.username && <span className="block truncate text-xs leading-none text-zinc-400" dir="ltr">{currentProfile.username}</span>}
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
