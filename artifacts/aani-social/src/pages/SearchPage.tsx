import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpLeft, Search, Trash2 } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

export default function SearchPage({ userId }: { userId: string }) {
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
              <div className="flex min-w-0 items-center gap-4">
                <Avatar profile={p} large />
                <UserIdentity
                  name={displayName(p)}
                  username={p.username}
                  className="min-w-0 flex-1"
                  nameClassName="text-xs font-bold text-white"
                  usernameClassName="text-[11px] text-zinc-400"
                />
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
