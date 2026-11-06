import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { Search, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

const readSearchHistory = (key: string): Profile[] => {
  try {
    const saved = localStorage.getItem(key);
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];

    const seenIds = new Set<string>();
    return parsed.flatMap((value): Profile[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const row = value as Partial<Profile>;
      if (typeof row.id !== 'string' || !row.id || seenIds.has(row.id)) return [];
      seenIds.add(row.id);

      return [{
        id: row.id,
        username: typeof row.username === 'string' ? row.username : '',
        full_name: typeof row.full_name === 'string' ? row.full_name : '',
        display_name: typeof row.display_name === 'string' ? row.display_name : null,
        avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        bio: typeof row.bio === 'string' ? row.bio : '',
        ...(typeof row.is_private === 'boolean' ? { is_private: row.is_private } : {}),
      }];
    });
  } catch {
    return [];
  }
};

export default function SearchPage({ userId }: { userId: string }) {
  const [term, setTerm] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<Profile[]>([]);
  const searchRequestRef = useRef(0);

  const historyKey = `aani_search_history_${userId}`;

  useEffect(() => {
    setSearchHistory(readSearchHistory(historyKey));
    return () => { searchRequestRef.current += 1; };
  }, [historyKey]);

  const persistHistory = (nextHistory: Profile[]) => {
    setSearchHistory(nextHistory);
    try {
      localStorage.setItem(historyKey, JSON.stringify(nextHistory));
    } catch {
      /* التخزين المحلي غير متاح */
    }
  };

  const addProfileToHistory = (profile: Profile) => {
    persistHistory([profile, ...searchHistory.filter(item => item.id !== profile.id)].slice(0, 10));
  };

  const deleteHistoryItem = (profileId: string) => {
    persistHistory(searchHistory.filter(profile => profile.id !== profileId));
  };

  const clearAllHistory = () => {
    setSearchHistory([]);
    try {
      localStorage.removeItem(historyKey);
    } catch {
      /* التخزين المحلي غير متاح */
    }
  };

  const handleSearch = async (queryTerm: string) => {
    const query = queryTerm.trim();
    if (!query) return;
    if (!supabaseConfigured) {
      setProfiles([]);
      setSearchError('تعذر الاتصال بالحسابات الآن.');
      return;
    }

    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setSearchError(null);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, bio')
        .or(`username.ilike.%${query}%,full_name.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(30);

      if (requestId !== searchRequestRef.current) return;
      if (error) throw error;
      setProfiles((data || []) as Profile[]);
    } catch {
      if (requestId !== searchRequestRef.current) return;
      setProfiles([]);
      setSearchError('تعذر تحميل الحسابات. حاول مرة أخرى.');
    } finally {
      if (requestId === searchRequestRef.current) setLoading(false);
    }
  };

  return (
    <section className="new-view mx-auto max-w-lg space-y-4" dir="rtl">
      <form
        className="flex items-center gap-3"
        onSubmit={event => {
          event.preventDefault();
          void handleSearch(term);
        }}
      >
        <h1 className="shrink-0 text-xl font-bold text-white">بحث</h1>
        <div className="relative flex min-w-0 flex-1 items-center rounded-full border border-zinc-800 bg-zinc-950 px-4 py-3 shadow-inner">
          <input
            value={term}
            onChange={event => {
              setTerm(event.target.value);
              setSearchError(null);
            }}
            placeholder="ابحث عن الاسم أو اسم المستخدم..."
            aria-label="ابحث عن الاسم أو اسم المستخدم"
            className="w-full bg-transparent pl-10 text-sm font-medium text-white outline-none placeholder:text-zinc-500 touch-pan-y"
          />
          <button
            className="absolute left-3 flex h-8 w-8 items-center justify-center rounded-full text-[#FF007A] transition-colors hover:bg-pink-500/10 hover:text-pink-300"
            type="submit"
            aria-label="بحث عن الحسابات"
          >
            <Search size={20} />
          </button>
        </div>
      </form>

      {searchHistory.length > 0 && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">الأبحاث الأخيرة</h2>
            <button
              type="button"
              onClick={clearAllHistory}
              className="text-xs font-semibold text-pink-400 transition-colors hover:text-pink-300"
            >
              مسح الكل
            </button>
          </div>
          <div className="space-y-1">
            {searchHistory.map(profile => (
              <div key={profile.id} className="flex items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-zinc-800/60">
                <Link
                  href={`/profile/${encodeURIComponent(profile.id)}`}
                  onClick={() => addProfileToHistory(profile)}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <Avatar profile={profile} large />
                  <UserIdentity
                    name={displayName(profile)}
                    username={profile.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-sm font-bold text-white"
                    usernameClassName="text-xs text-zinc-400"
                  />
                </Link>
                <button
                  type="button"
                  onClick={() => deleteHistoryItem(profile.id)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200"
                  aria-label={`حذف ${displayName(profile)} من سجل البحث`}
                  title="حذف من سجل البحث"
                >
                  <X size={17} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {loading && <div className="status-box">جاري البحث عن الحسابات...</div>}
      {searchError && !loading && <div className="status-box">{searchError}</div>}

      {!loading && !searchError && profiles.length > 0 && (
        <div className="card space-y-2">
          {profiles.map(profile => (
            <Link
              key={profile.id}
              href={`/profile/${encodeURIComponent(profile.id)}`}
              onClick={() => addProfileToHistory(profile)}
              className="flex items-center justify-between rounded-xl p-2.5 hover:bg-zinc-800/50"
            >
              <div className="flex min-w-0 items-center gap-4">
                <Avatar profile={profile} large />
                <UserIdentity
                  name={displayName(profile)}
                  username={profile.username}
                  className="min-w-0 flex-1"
                  nameClassName="text-sm font-bold text-white"
                  usernameClassName="text-xs text-zinc-400"
                />
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && !searchError && term.trim() && profiles.length === 0 && (
        <div className="empty-state card">
          <h2>لا توجد نتائج مطابقة</h2>
          <p className="text-xs text-zinc-400">تأكد من كتابة اسم المستخدم أو الاسم الصحيح.</p>
        </div>
      )}
    </section>
  );
}
