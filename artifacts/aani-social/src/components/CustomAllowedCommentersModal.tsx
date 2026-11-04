import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';

import UserIdentity from '@/components/UserIdentity';
import { supabase, supabaseConfigured } from '@/lib/supabase';

type Person = {
  id: string;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
};

type CustomAllowedCommentersModalProps = {
  open: boolean;
  ownerId: string;
  selectedIds: string[];
  onClose: () => void;
  onSave: (ids: string[]) => void;
};

export default function CustomAllowedCommentersModal({
  open,
  ownerId,
  selectedIds,
  onClose,
  onSave,
}: CustomAllowedCommentersModalProps) {
  const [people, setPeople] = useState<Person[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set(selectedIds));
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelection(new Set(selectedIds));
    setSearch('');
    setFailed(false);

    if (!supabaseConfigured || !ownerId) {
      setPeople([]);
      setFailed(true);
      return;
    }

    let active = true;
    setLoading(true);
    void (async () => {
      const [followingResult, followersResult] = await Promise.all([
        supabase.from('follows').select('following_id').eq('follower_id', ownerId).limit(2000),
        supabase.from('follows').select('follower_id').eq('following_id', ownerId).limit(2000),
      ]);

      if (!active) return;
      if (followingResult.error || followersResult.error) {
        setFailed(true);
        setPeople([]);
        setLoading(false);
        return;
      }

      const followerIds = new Set((followersResult.data || []).map(row => row.follower_id));
      const mutualIds = [...new Set((followingResult.data || [])
        .map(row => row.following_id)
        .filter(id => id !== ownerId && followerIds.has(id)))];
      const { data, error } = mutualIds.length
        ? await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', mutualIds)
          .order('full_name', { ascending: true, nullsFirst: false })
          .limit(2000)
        : { data: [], error: null };

      if (!active) return;
      if (error) {
        setFailed(true);
        setPeople([]);
      } else {
        setPeople((data || []) as Person[]);
        setSelection(current => new Set([...current].filter(id => mutualIds.includes(id))));
      }
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [open, ownerId, selectedIds]);

  const visiblePeople = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return people;
    return people.filter(person =>
      `${person.full_name || ''} ${person.username || ''}`.toLocaleLowerCase().includes(term),
    );
  }, [people, search]);

  const toggle = (id: string) => {
    setSelection(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-3" dir="rtl">
      <button type="button" aria-label="إغلاق اختيار المعلقين" onClick={onClose} className="absolute inset-0 h-full w-full" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-commenters-title"
        className="relative z-10 flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#19191d] text-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 id="aani-commenters-title" className="text-sm font-bold">أشخاص مسموح لهم بالتعليق</h2>
            <p className="mt-1 text-[10px] text-white/45">اختر من بين الحسابات ذات المتابعة المتبادلة</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-white/70">{selection.size}</span>
            <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 py-2.5">
            <Search size={15} className="shrink-0 text-white/45" />
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="ابحث بالاسم أو اسم المستخدم"
              className="w-full bg-transparent text-xs text-white outline-none placeholder:text-white/40"
            />
          </div>
        </div>

        <div className="min-h-36 flex-1 overflow-y-auto px-3 py-2">
          {loading && <p className="flex items-center justify-center gap-2 py-8 text-xs text-white/55"><Loader2 size={15} className="animate-spin" /> جارٍ تحميل الحسابات…</p>}
          {!loading && failed && <p role="alert" className="py-8 text-center text-xs text-rose-300">تعذر تحميل الأصدقاء المتبادلين. تحقق من الاتصال ثم حاول مرة أخرى.</p>}
          {!loading && !failed && visiblePeople.length === 0 && (
            <p className="py-8 text-center text-xs text-white/50">
              {people.length ? 'لا توجد نتائج مطابقة' : 'لا توجد حسابات بمتابعة متبادلة بعد'}
            </p>
          )}
          {!loading && !failed && visiblePeople.map(person => {
            const checked = selection.has(person.id);
            return (
              <button
                key={person.id}
                type="button"
                aria-pressed={checked}
                onClick={() => toggle(person.id)}
                className="mb-1 flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-right transition hover:bg-white/[0.07]"
              >
                {person.avatar_url ? (
                  <img src={person.avatar_url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-bold text-white/70">
                    {(person.full_name || person.username || 'آ').slice(0, 1)}
                  </span>
                )}
                <UserIdentity
                  name={person.full_name || person.username}
                  username={person.username}
                  className="min-w-0 flex-1"
                  nameClassName="text-xs font-semibold text-white"
                  usernameClassName="text-[10px] text-white/45"
                />
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border transition ${checked ? 'border-violet-400 bg-violet-500 text-white' : 'border-white/25 text-transparent'}`}>
                  <Check size={13} />
                </span>
              </button>
            );
          })}
        </div>

        <footer className="border-t border-white/10 p-4">
          <button
            type="button"
            onClick={() => onSave([...selection])}
            disabled={loading || failed}
            className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-3 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            حفظ الاختيار
          </button>
        </footer>
      </section>
    </div>
  );
}
