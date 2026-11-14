import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';

import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName } from '@/lib/types';

export interface MentionCandidate {
  id: string;
  username: string;
  full_name: string | null;
  display_name?: string | null;
  avatar_url: string | null;
}

interface StoryMentionPickerProps {
  open: boolean;
  currentUserId: string;
  onClose: () => void;
  onConfirm: (people: MentionCandidate[]) => void;
}

const PAGE_SIZE = 25;

export default function StoryMentionPicker({ open, currentUserId, onClose, onConfirm }: StoryMentionPickerProps) {
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, MentionCandidate>>(new Map());
  const [allowedIds, setAllowedIds] = useState<string[] | null>(null);

  const requestIdRef = useRef(0);

  // الأشخاص المسموح بذكرهم: المتابَعون + المتابعون (بدون تكرار، وبدون الحساب نفسه)
  useEffect(() => {
    if (!open || !supabaseConfigured || allowedIds) return;

    let cancelled = false;
    const run = async () => {
      const [followingRes, followersRes] = await Promise.all([
        supabase.from('follows').select('following_id').eq('follower_id', currentUserId).limit(2000),
        supabase.from('follows').select('follower_id').eq('following_id', currentUserId).limit(2000),
      ]);

      if (cancelled) return;
      const ids = new Set<string>();
      (followingRes.data || []).forEach(row => row.following_id && ids.add(row.following_id));
      (followersRes.data || []).forEach(row => row.follower_id && ids.add(row.follower_id));
      ids.delete(currentUserId);
      setAllowedIds(Array.from(ids));
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, currentUserId, allowedIds]);

  const loadPage = useCallback(
    async (nextOffset: number, query: string) => {
      if (!allowedIds) return;
      if (allowedIds.length === 0) {
        setPeople([]);
        setHasMore(false);
        setLoading(false);
        return;
      }

      const ticket = requestIdRef.current + 1;
      requestIdRef.current = ticket;

      setLoading(true);
      setFailed(false);

      const term = query.trim();
      let request = supabase
        .from('profiles')
        .select('id, username, full_name, display_name, avatar_url, gender')
        .in('id', allowedIds)
        .order('full_name', { ascending: true, nullsFirst: false })
        .range(nextOffset, nextOffset + PAGE_SIZE - 1);

      if (term) {
        request = request.or(`username.ilike.%${term}%,full_name.ilike.%${term}%,display_name.ilike.%${term}%`);
      }

      const { data, error } = await request;
      if (requestIdRef.current !== ticket) return;

      if (error) {
        setFailed(true);
        setPeople([]);
        setHasMore(false);
        setLoading(false);
        return;
      }

      const rows = (data || []) as MentionCandidate[];
      setPeople(prev => (nextOffset === 0 ? rows : [...prev, ...rows]));
      setHasMore(rows.length === PAGE_SIZE);
      setLoading(false);
    },
    [allowedIds],
  );

  // بحث حقيقي أثناء الكتابة (مع تأخير قصير)
  useEffect(() => {
    if (!open || !allowedIds) return;
    const timer = window.setTimeout(() => {
      setOffset(0);
      void loadPage(0, search);
    }, 250);

    return () => clearTimeout(timer);
  }, [open, allowedIds, search, loadPage]);

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  const toggle = (person: MentionCandidate) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(person.id)) next.delete(person.id);
      else next.set(person.id, person);
      return next;
    });
  };

  if (!open) return null;

  // أعلى طبقة في محرّر القصة (z-200) مع تعتيم يغطي الشاشة بالكامل:
  // يمنع النقر على شريط الأدوات أو أزرار النشر أو زر الإغلاق خلف المنتقي
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="الإشارة إلى أشخاص"
    >
      <div className="flex h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#141519] text-white shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold">الإشارة إلى أشخاص</span>
            {selectedList.length > 0 && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
                {selectedList.length} محدد
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfirm(selectedList)}
              className="rounded-full bg-white px-3.5 py-1 text-[11px] font-bold text-[#121212] transition active:scale-95"
            >
              تم
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="rounded-full p-1 text-white/70 transition hover:bg-white/10"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
            <Search size={15} className="text-white/50" />
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="ابحث بالاسم أو اسم المستخدم"
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-white/40"
            />
          </div>
        </div>

        <div className="aani-hscroll flex-1 overflow-y-auto px-3 pb-4">
          {loading && people.length === 0 && (
            <ListSkeleton count={5} compact />
          )}

          {!loading && failed && (
            <p className="py-8 text-center text-[11px] text-white/50">تعذّر تحميل الحسابات، حاول لاحقاً</p>
          )}

          {!loading && !failed && people.length === 0 && (
            <EmptyState className="py-8" />
          )}

          {people.map(person => {
            const picked = selected.has(person.id);
            return (
              <button
                key={person.id}
                type="button"
                onClick={() => toggle(person)}
                className="mb-1 flex w-full items-center gap-4 rounded-2xl px-2 py-2 text-right transition active:scale-[0.99] hover:bg-white/10"
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
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition ${
                    picked ? 'border-white bg-white text-[#121212]' : 'border-white/30 text-transparent'
                  }`}
                >
                  <Check size={13} />
                </span>
              </button>
            );
          })}

          {hasMore && !loading && (
            <button
              type="button"
              onClick={() => {
                const next = offset + PAGE_SIZE;
                setOffset(next);
                void loadPage(next, search);
              }}
              className="mx-auto mt-2 block rounded-full bg-white/10 px-4 py-1.5 text-[11px] text-white/75"
            >
              تحميل المزيد
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
