import { useEffect, useMemo, useState } from 'react';
import { Check, Search, Star, X } from 'lucide-react';
import { toast } from 'sonner';

import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName } from '@/lib/types';

interface CloseFriendPerson {
  id: string;
  username: string;
  full_name: string | null;
  display_name?: string | null;
  avatar_url: string | null;
}

interface CloseFriendsSheetProps {
  open: boolean;
  currentUserId: string;
  onClose: () => void;
}

export default function CloseFriendsSheet({ open, currentUserId, onClose }: CloseFriendsSheetProps) {
  const [people, setPeople] = useState<CloseFriendPerson[]>([]);
  const [originalIds, setOriginalIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!supabaseConfigured) {
      setFailed(true);
      return;
    }

    let active = true;
    setLoading(true);
    setFailed(false);
    setSearch('');

    void (async () => {
      const [followingResult, followersResult, selectedResult] = await Promise.all([
        supabase.from('follows').select('following_id').eq('follower_id', currentUserId).limit(2000),
        supabase.from('follows').select('follower_id').eq('following_id', currentUserId).limit(2000),
        supabase.from('close_friends').select('friend_id').eq('user_id', currentUserId).limit(2000),
      ]);

      if (!active) return;
      if (followingResult.error || followersResult.error || selectedResult.error) {
        setFailed(true);
        setPeople([]);
        setLoading(false);
        return;
      }

      const followers = new Set((followersResult.data || []).map(row => row.follower_id));
      const mutualIds = [...new Set((followingResult.data || [])
        .map(row => row.following_id)
        .filter(id => id !== currentUserId && followers.has(id)))];
      const storedSelectedIds = new Set((selectedResult.data || []).map(row => row.friend_id));
      const selected = new Set([...storedSelectedIds].filter(id => mutualIds.includes(id)));

      const { data: profiles, error: profileError } = mutualIds.length
        ? await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, gender')
          .in('id', mutualIds)
          .order('full_name', { ascending: true, nullsFirst: false })
          .limit(2000)
        : { data: [], error: null };

      if (!active) return;
      if (profileError) {
        setFailed(true);
        setPeople([]);
        setLoading(false);
        return;
      }

      setPeople((profiles || []) as CloseFriendPerson[]);
      setOriginalIds(storedSelectedIds);
      setSelectedIds(new Set(selected));
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [open, currentUserId]);

  const visiblePeople = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return people;
    return people.filter(person =>
      `${person.full_name || ''} ${person.display_name || ''} ${person.username || ''}`.toLocaleLowerCase().includes(term),
    );
  }, [people, search]);

  const toggle = (personId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  // الحفظ: upsert يتجاهل الصفوف الموجودة مسبقاً (لا يُعاد إدراج صف قائم)،
  // والحذف يقتصر على صفوف المستخدم نفسه. تُبقى الرسائل كما هي، وتُسجَّل
  // التفاصيل التقنية في الكونسول فقط، ولا تُغلق النافذة إلا عند نجاح الحفظ.
  const save = async () => {
    if (saving || !supabaseConfigured) return;
    setSaving(true);

    const toAdd = [...selectedIds].filter(id => !originalIds.has(id));
    const toRemove = [...originalIds].filter(id => !selectedIds.has(id));

    try {
      if (toAdd.length) {
        const { error } = await supabase
          .from('close_friends')
          .upsert(
            toAdd.map(friendId => ({ user_id: currentUserId, friend_id: friendId })),
            { onConflict: 'user_id,friend_id', ignoreDuplicates: true },
          );
        if (error) {
          console.error('close_friends upsert failed', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
          toast.error('تعذر حفظ قائمة الأصدقاء المقربين');
          return;
        }
      }

      if (toRemove.length) {
        const { error } = await supabase
          .from('close_friends')
          .delete()
          .eq('user_id', currentUserId)
          .in('friend_id', toRemove);
        if (error) {
          console.error('close_friends delete failed', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
          toast.error('تعذر تحديث بعض الأصدقاء المقربين');
          return;
        }
      }

      setOriginalIds(new Set(selectedIds));
      toast.success('تم حفظ قائمة الأصدقاء المقربين');
      onClose();
    } catch (error) {
      console.error('close_friends save failed', error);
      toast.error('تعذر حفظ قائمة الأصدقاء المقربين');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 p-3" dir="rtl">
      <section
        className="flex h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#141519] text-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aani-close-friends-title"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Star size={17} className="text-emerald-400" fill="currentColor" />
            <h2 id="aani-close-friends-title" className="text-[14px] font-bold">الأصدقاء المقربون</h2>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/60">{selectedIds.size}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading || failed}
              className="rounded-full bg-white px-4 py-1.5 text-[11px] font-bold text-[#121212] disabled:opacity-50"
            >
              {saving ? 'جارٍ الحفظ…' : 'تم'}
            </button>
            <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-full p-1 text-white/70 hover:bg-white/10">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
            <Search size={15} className="text-white/50" />
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="ابحث عن الأصدقاء المتبادلين"
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-white/40"
            />
          </div>
          <p className="mt-2 text-[10px] leading-4 text-white/45">تظهر هنا الحسابات التي تتابعك وتتابعها. لا يُرسل إشعار عند تعديل القائمة.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading && (
            <ListSkeleton count={5} compact className="px-2" />
          )}
          {!loading && failed && <p className="py-8 text-center text-[11px] text-red-300">تعذر تحميل القائمة. حاول مرة أخرى.</p>}
          {!loading && !failed && visiblePeople.length === 0 && (
            <EmptyState className="py-8" />
          )}
          {!loading && !failed && visiblePeople.map(person => {
            const selected = selectedIds.has(person.id);
            return (
              <button
                key={person.id}
                type="button"
                onClick={() => toggle(person.id)}
                aria-pressed={selected}
                className="mb-1 flex w-full items-center gap-4 rounded-2xl px-2 py-2 text-right transition hover:bg-white/10 active:scale-[0.99]"
              >
                {person.avatar_url ? (
                  <img src={person.avatar_url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-bold">
                    {(displayName(person).charAt(0) || '?').toUpperCase()}
                  </span>
                )}
                <UserIdentity
                  name={displayName(person)}
                  username={person.username}
                  className="min-w-0 flex-1"
                  nameClassName="text-[12px] font-bold text-white"
                  usernameClassName="text-[10px] text-white/50"
                />
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition ${selected ? 'border-emerald-400 bg-emerald-500 text-white' : 'border-white/30 text-transparent'}`}>
                  <Check size={13} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
