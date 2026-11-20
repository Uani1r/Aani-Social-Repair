import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { Search, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

const searchStateCache = new Map<string, { term: string; profiles: Profile[] }>();

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

// ---------------------------------------------------------------------------
// تطبيع نص البحث
//   * NFC ثم توحيد الحروف العربية المتكافئة (أ إ آ ← ا، ة ← ه، ى ← ي، ؤ ← و).
//   * حذف التشكيل والتطويل (U+064B..U+0652، U+0670، U+0640) قبل المقارنة.
//   * تاريخ/أرقام عربية-هندية تُحوَّل إلى أرقام لاتينية ليعمل البحث الرقمي.
//   * الإنجليزية تبقى كما هي عبر toLowerCase.
// ---------------------------------------------------------------------------
const ARABIC_DIACRITICS_REGEX = /[\u064B-\u0652\u0670\u0640]/g;
const ARABIC_INDIC_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

const normalizeSearchText = (value: string): string => value
  .normalize('NFKC')
  .replace(ARABIC_DIACRITICS_REGEX, '')
  .trim()
  .replace(/\s+/g, ' ')
  .toLowerCase()
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/[٠-٩۰-۹]/g, digit => ARABIC_INDIC_DIGITS[digit] || digit);

/** الاستعلام بعد إزالة بادئة @ وتطبيع النص — يدعم البحث بـ @username. */
const normalizeSearchQuery = (value: string): string => normalizeSearchText(value).replace(/^@+/, '').trim();

// عدد بدائل الحروف محدود: كل حرف له بديلان أو ثلاثة، والسقف 16 شكلاً
// حتى لا يتضخم طلب PostgREST عند الكتابة السريعة.
const MAX_SEARCH_VARIANTS = 16;

const getSearchVariants = (normalizedQuery: string): string[] => {
  const alternatives: Record<string, string[]> = {
    ا: ['ا', 'أ', 'إ', 'آ'],
    ه: ['ه', 'ة'],
    ي: ['ي', 'ى'],
    و: ['و', 'ؤ'],
  };

  if (!normalizedQuery) return [];

  let variants: string[] = [''];
  for (const character of normalizedQuery) {
    const characters = alternatives[character];
    if (!characters) {
      variants = variants.map(prefix => `${prefix}${character}`);
    } else {
      if (variants.length * characters.length > MAX_SEARCH_VARIANTS) break;
      variants = variants.flatMap(prefix => characters.map(alternative => `${prefix}${alternative}`));
    }
    if (variants.length >= MAX_SEARCH_VARIANTS) break;
  }

  // لو توقفنا قبل نهاية الاستعلام بسبب السقف، نكتفي بالشكل المطبَّع وحده:
  // استعلام واحد كامل أدق من بادئة ناقصة تُرجع نتائج عشوائية.
  if (variants.length === 0 || variants.some(variant => variant.length !== normalizedQuery.length)) {
    return [normalizedQuery];
  }

  return [...new Set(variants)];
};

const quotePostgrestValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// حقول اسم المستخدم وحقول الاسم، مفصولة لأن درجات الصلة تختلف بينهما.
const USERNAME_SEARCH_FIELDS = ['username'] as const;
const NAME_SEARCH_FIELDS = ['full_name', 'display_name'] as const;
// الأعمدة التي تعرضها الواجهة فقط — بلا bio أو حقول غير مستخدمة.
const SEARCH_PROFILE_COLUMNS = 'id, username, full_name, display_name, avatar_url, gender';
// لكل درجة صلة استعلامها المستقل بنفس سقف النتائج المعروضة: أي درجة وحدها
// تستطيع ملء الشاشة، فلا تُسقط درجة أعلى نتيجة بسبب ميزانية درجة أدنى.
const SEARCH_TIER_LIMIT = 30;

/**
 * درجة الصلة للحساب حسب الأولوية المطلوبة:
 *   6 تطابق اسم المستخدم بالكامل
 *   5 بداية اسم المستخدم
 *   4 تطابق الاسم المعروض بالكامل
 *   3 بداية الاسم المعروض
 *   2 تطابق جزئي في اسم المستخدم
 *   1 تطابق جزئي في الاسم المعروض
 *   0 لا تطابق (يُستبعد، فلا تظهر نتائج غير مرتبطة)
 */
const scoreProfileMatch = (profile: Profile, normalizedQuery: string): number => {
  if (!normalizedQuery) return 0;

  const username = normalizeSearchText(profile.username || '');
  const displayName = normalizeSearchText(profile.display_name || '');
  const fullName = normalizeSearchText(profile.full_name || '');

  if (username === normalizedQuery) return 6;
  if (username.startsWith(normalizedQuery)) return 5;
  if (displayName === normalizedQuery || fullName === normalizedQuery) return 4;
  if (displayName.startsWith(normalizedQuery) || fullName.startsWith(normalizedQuery)) return 3;
  if (username.includes(normalizedQuery)) return 2;
  if (displayName.includes(normalizedQuery) || fullName.includes(normalizedQuery)) return 1;
  return 0;
};

export default function SearchPage({ userId }: { userId: string }) {
  const cachedSearch = searchStateCache.get(userId);
  const [term, setTerm] = useState(cachedSearch?.term || '');
  const [profiles, setProfiles] = useState<Profile[]>(cachedSearch?.profiles || []);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<Profile[]>([]);
  const searchRequestRef = useRef(0);
  const searchTimeoutRef = useRef<number | null>(null);

  const historyKey = `aani_search_history_${userId}`;

  useEffect(() => {
    setSearchHistory(readSearchHistory(historyKey));
    return () => {
      searchRequestRef.current += 1;
      if (searchTimeoutRef.current !== null) window.clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    };
  }, [historyKey]);

  useEffect(() => {
    searchStateCache.set(userId, { term, profiles });
  }, [userId, term, profiles]);

  const preserveSearchState = () => {
    searchStateCache.set(userId, { term, profiles });
  };

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
    const normalizedQuery = normalizeSearchQuery(queryTerm);
    if (!normalizedQuery) {
      searchRequestRef.current += 1;
      setProfiles([]);
      setLoading(false);
      setSearchError(null);
      return;
    }
    if (!supabaseConfigured) {
      setProfiles([]);
      setLoading(false);
      setSearchError('تعذر الاتصال بالحسابات الآن.');
      return;
    }

    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setSearchError(null);
    try {
      // عدد البدائل ≤ 16 لكل حقل ⇒ كل طلب PostgREST محدود الحجم مهما طال النص.
      const variants = getSearchVariants(normalizedQuery);
      const buildFilters = (
        fields: readonly string[],
        match: 'exact' | 'prefix' | 'contains',
      ) => variants.flatMap(variant => {
        const pattern = match === 'exact'
          ? variant
          : match === 'prefix'
            ? `${variant}%`
            : `%${variant}%`;

        return fields.flatMap((field) => {
          // اسم المستخدم مخزَّن بأحرف لاتينية صغيرة (a-z 0-9 _ .) وفق قيد
          // الجدول، فالمقارنة الدقيقة eq والبادئة/الجزء بـ LIKE بلا حاجة إلى
          // ILIKE. الأسماء تبقى على ILIKE لأنها قد تحمل حالة مختلفة.
          if (field === 'username') {
            return [
              match === 'exact'
                ? `username.eq.${quotePostgrestValue(variant)}`
                : `username.like.${quotePostgrestValue(pattern)}`,
            ];
          }
          return [`${field}.ilike.${quotePostgrestValue(pattern)}`];
        });
      });

      // استعلام مستقل لكل درجة صلة، كلها مرتّبة من القاعدة (username ثم id)
      // ليكون كل صف جالب هو الأفضل داخل درجته تحت نفس فاصل التعادل.
      const runTier = async (
        fields: readonly string[],
        match: 'exact' | 'prefix' | 'contains',
      ): Promise<Profile[]> => {
        const { data, error } = await supabase
          .from('profiles')
          .select(SEARCH_PROFILE_COLUMNS)
          .eq('is_deactivated', false)
          .or(buildFilters(fields, match).join(','))
          .order('username', { ascending: true })
          .order('id', { ascending: true })
          .limit(SEARCH_TIER_LIMIT);
        if (error) throw error;
        return (data || []) as Profile[];
      };

      // ست درجات مطابقة، لا تشترك في أي سقف:
      //   6 username exact · 5 username prefix · 4 name exact
      //   3 name prefix · 2 username contains · 1 name contains
      const tiers = await Promise.all([
        runTier(USERNAME_SEARCH_FIELDS, 'exact'),
        runTier(USERNAME_SEARCH_FIELDS, 'prefix'),
        runTier(NAME_SEARCH_FIELDS, 'exact'),
        runTier(NAME_SEARCH_FIELDS, 'prefix'),
        runTier(USERNAME_SEARCH_FIELDS, 'contains'),
        runTier(NAME_SEARCH_FIELDS, 'contains'),
      ]);

      if (requestId !== searchRequestRef.current) return;

      // لا إعادة ترتيب على العميل: تُحفظ درجة كل طبقة كما رتّبها الاستعلام
      // (username ثم id من قاعدة البيانات)، وترتيب tiers هو ترتيب الدرجات 6→1.
      // Map يضمن إزالة التكرار مع الحفاظ على هذا الترتيب.
      const profileById = new Map<string, Profile>();
      tiers.flat().forEach((profile) => {
        if (profileById.has(profile.id)) return;
        if (scoreProfileMatch(profile, normalizedQuery) > 0) profileById.set(profile.id, profile);
      });

      setProfiles([...profileById.values()].slice(0, SEARCH_TIER_LIMIT));
    } catch {
      if (requestId !== searchRequestRef.current) return;
      setProfiles([]);
      setSearchError('تعذر تحميل الحسابات. حاول مرة أخرى.');
    } finally {
      if (requestId === searchRequestRef.current) setLoading(false);
    }
  };

  const handleSearchInput = (nextTerm: string) => {
    setTerm(nextTerm);
    setSearchError(null);
    if (searchTimeoutRef.current !== null) window.clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = null;
    searchRequestRef.current += 1;

    if (!normalizeSearchQuery(nextTerm)) {
      setProfiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    searchTimeoutRef.current = window.setTimeout(() => {
      searchTimeoutRef.current = null;
      void handleSearch(nextTerm);
    }, 220);
  };

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searchTimeoutRef.current !== null) window.clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = null;
    void handleSearch(term);
  };

  return (
    <section className="new-view mx-auto w-full max-w-lg space-y-4 px-4" dir="rtl">
      <form className="flex w-full items-center gap-3" onSubmit={handleSearchSubmit}>
        <h1 className="shrink-0 text-xl font-bold text-white">بحث</h1>
        <div className="relative flex min-w-0 flex-1 items-center rounded-full border border-zinc-800 bg-zinc-950 shadow-inner">
          <input
            value={term}
            onChange={event => handleSearchInput(event.target.value)}
            placeholder="ابحث عن الاسم أو اسم المستخدم..."
            aria-label="ابحث عن الاسم أو اسم المستخدم"
            className="search-input bg-transparent text-sm font-medium text-white placeholder:text-zinc-500 touch-pan-y"
          />
          <button
            className="absolute left-2 flex h-8 w-8 items-center justify-center rounded-full text-[#FF007A] transition-colors hover:bg-pink-500/10 hover:text-pink-300"
            type="submit"
            aria-label="بحث عن الحسابات"
          >
            <Search size={20} />
          </button>
        </div>
      </form>

      {searchHistory.length > 0 && term.length === 0 && (
        <section className="space-y-2">
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
              <div key={profile.id} className="flex items-center gap-2 py-2">
                <Link
                  href={`/profile/${encodeURIComponent(profile.id)}?from=search`}
                  onClick={() => {
                    preserveSearchState();
                    addProfileToHistory(profile);
                  }}
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

      {loading && <ListSkeleton count={6} />}
      {searchError && !loading && (
        <div className="status-box">
          <span>{searchError}</span>
          <button
            type="button"
            onClick={() => void handleSearch(term)}
            className="mt-2 block text-xs font-semibold text-pink-400 transition-colors hover:text-pink-300"
          >
            إعادة المحاولة
          </button>
        </div>
      )}

      {!loading && !searchError && profiles.length > 0 && (
        <div className="card space-y-2 content-fade-in">
          {profiles.map(profile => (
            <Link
              key={profile.id}
              href={`/profile/${encodeURIComponent(profile.id)}?from=search`}
              onClick={() => {
                preserveSearchState();
                addProfileToHistory(profile);
              }}
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

      {!loading && !searchError && normalizeSearchQuery(term) && profiles.length === 0 && (
        <div className="card rounded-2xl py-3">
          <EmptyState className="py-4" />
          <p className="text-center text-xs text-zinc-500">جرّب اسماً آخر أو اسم مستخدم بدون @</p>
        </div>
      )}
    </section>
  );
}
