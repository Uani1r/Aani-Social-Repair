import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, MapPin } from 'lucide-react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useLocation } from 'wouter';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { Switch } from '@/components/ui/switch';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { releaseOverlayBackForNavigation } from '@/lib/overlayBack';
import { registerRealtimeReconnect } from '@/lib/realtimeReconnect';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

type NearbyUsersSheetProps = {
  open: boolean;
  onClose: () => void;
  currentUserId: string;
  /** مدينة المستخدم الحالي (profiles.city) — أساس فلترة الأشخاص القريبين */
  currentCity: string | null;
  /** ملف المستخدم الحالي — منه يُقرأ مفتاح الظهور في القائمة */
  currentProfile: Profile | null;
  /** مزامنة ملف المستخدم بعد تغيير مفتاح الظهور */
  onProfileUpdate: (next: Profile) => void;
};

type NearbyUser = Pick<
  Profile,
  'id' | 'username' | 'full_name' | 'display_name' | 'avatar_url' | 'city'
>;

type NearbyProfileRow = {
  city?: string | null;
  location?: string | null;
  is_nearby_visible?: boolean | null;
};

type NearbyUsersState =
  | { status: 'loading'; people: NearbyUser[]; errorText: '' }
  | { status: 'ready'; people: NearbyUser[]; errorText: '' }
  | { status: 'no-city'; people: NearbyUser[]; errorText: '' }
  | { status: 'error'; people: NearbyUser[]; errorText: string };

// مفتاح الكاش المحلي لمنطقة المستخدم — لكل حساب على حدة.
// الغرض: استعادة المنطقة فوراً عند فتح الشاشة أو العودة إليها، دون انتظار الشبكة.
const CITY_CACHE_PREFIX = 'aani_nearby_city_';

// فحص دوري صامت أثناء فتح الشاشة والتبويب ظاهر.
const REFRESH_INTERVAL_MS = 6000;
// جمع تحديثات Realtime المتقاربة في طلب واحد.
const REALTIME_DEBOUNCE_MS = 600;
// أقل مدة بين محاولتي إعادة بناء قناة Realtime.
const CHANNEL_REBUILD_COOLDOWN_MS = 5000;

function readCachedCity(userId: string): string | null {
  try {
    const value = window.localStorage.getItem(`${CITY_CACHE_PREFIX}${userId}`);
    const trimmed = value?.trim() || '';
    return trimmed || null;
  } catch {
    return null;
  }
}

function writeCachedCity(userId: string, city: string | null): void {
  try {
    const key = `${CITY_CACHE_PREFIX}${userId}`;
    if (city) window.localStorage.setItem(key, city);
    else window.localStorage.removeItem(key);
  } catch {
    /* التخزين المحلي اختياري — لا يفشل الشاشة */
  }
}

/** مدينة الصف: city أولاً ثم location (نفس مصدر مدينة التسجيل). */
function pickCity(row: NearbyProfileRow | null | undefined): string | null {
  for (const value of [row?.city, row?.location]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * جلب القائمة من المصدر المعتمد aani_nearby_people (يحترم المدينة والظهور
 * والحسابات المعطلة وRLS).
 *
 * لم يبقَ رجوع للاستعلام المباشر على profiles: منذ ترحيل 20270206000000
 * سُحبت قراءة city و location و city_key من المستخدم المسجّل (لأنها محكومة
 * بـ show_city)، فأي استعلام مباشر عليها يفشل بـ42501. الدالة هي المصدر
 * الوحيد، وهي تُعيد city فارغة لمن أخفى مدينته وتستثنيه من القائمة.
 */
async function fetchNearbyPeople(city: string, currentUserId: string): Promise<NearbyUser[]> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('aani_nearby_people', { p_limit: 200 });
  if (rpcError) {
    const rpcMissing = rpcError.code === 'PGRST202'
      || rpcError.code === '42883'
      || /aani_nearby_people|could not find the function|schema cache/i.test(rpcError.message || '');
    if (rpcMissing) {
      throw new Error('ميزة «الأشخاص القريبون» تحتاج تطبيق ترحيل قاعدة البيانات 20270201000000 (أو 20270206000000 إن سبقه).');
    }
    throw rpcError;
  }

  void city;
  void currentUserId;
  return ((rpcData || []) as NearbyUser[]).filter(person => Boolean(person?.id));
}

/**
 * شاشة «الأشخاص القريبون»: تعرض مستخدمي نفس المدينة المسجلة في الملف الشخصي
 * (profiles.city) الذين يسمحون بالظهور في القائمة (is_nearby_visible = true).
 * تفتح من زر الدبوس في أعلى الشاشة الرئيسية، ويظهر بجانب عنوانها مفتاح
 * تشغيل/إيقاف يتحكم بظهور المستخدم الحالي في قائمة الآخرين.
 *
 * المنطقة: تُستعاد فوراً من الكاش المحلي ثم يُعاد التحقق منها من profiles بنفس
 * معرّف المستخدم؛ ولا تُصفَّر منطقة محفوظة بسبب تأخر الطلب أو خطأ اتصال مؤقت.
 *
 * القائمة: اشتراك Realtime على public.profiles + فحص دوري صامت كل 6 ثوانٍ
 * أثناء الفتح والتبويب ظاهر، مع تجميع التحديثات وتجاهل نتائج الطلبات القديمة.
 */
export default function NearbyUsersSheet({
  open,
  onClose,
  currentUserId,
  currentCity,
  currentProfile,
  onProfileUpdate,
}: NearbyUsersSheetProps) {
  // زر الرجوع (الهاتف/المتصفح) يغلق الشاشة ويعيدك لنفس المكان
  useOverlayBack(open, onClose);
  const [, navigate] = useLocation();
  const [state, setState] = useState<NearbyUsersState>({ status: 'loading', people: [], errorText: '' });
  // المنطقة المستخدمة فعلياً في العرض والجلب (كاش ← ملف محمّل ← تأكيد من profiles)
  const [resolvedCity, setResolvedCity] = useState<string | null>(() => currentCity?.trim() || null);
  // مفتاح الظهور في قائمة الأشخاص القريبين (profiles.is_nearby_visible)
  const [nearbyVisible, setNearbyVisible] = useState(() => currentProfile?.is_nearby_visible !== false);
  const [togglingVisible, setTogglingVisible] = useState(false);

  // القيمة الحالية للمنطقة في مرجع، حتى لا تُغلق الطلبات المتأخرة على قيمة قديمة
  const cityRef = useRef<string | null>(currentCity?.trim() || null);
  const hasPeopleRef = useRef(false);
  const requestSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // مزامنة المفتاح مع الملف الشخصي إذا تغيّر من مكان آخر
  useEffect(() => {
    if (togglingVisible) return;
    setNearbyVisible(currentProfile?.is_nearby_visible !== false);
  }, [currentProfile?.is_nearby_visible, togglingVisible]);

  const commitPeople = useCallback((people: NearbyUser[]) => {
    hasPeopleRef.current = people.length > 0;
    // تحديث مباشر للقائمة دون إعادة الشاشة إلى loading — فلا يهتز التمرير
    setState({ status: 'ready', people, errorText: '' });
  }, []);

  const refresh = useCallback(async () => {
    if (!supabaseConfigured) {
      setState(previous => previous.status === 'ready'
        ? previous
        : { status: 'error', people: [], errorText: 'إعدادات الاتصال بقاعدة البيانات غير مكتملة.' });
      return;
    }

    const city = cityRef.current;
    if (!city) return;

    // رقم متزايد: أي نتيجة تصل بعد طلب أحدث تُتجاهل
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    try {
      const people = await fetchNearbyPeople(city, currentUserId);
      if (seq !== requestSeqRef.current) return;
      commitPeople(people);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      console.warn('[nearby] تعذر تحديث قائمة الأشخاص القريبين:', error);
      // فشل التحديث لا يمسح قائمة معروضة، ولا يحوّل الصفحة إلى «لا توجد منطقة»
      if (!hasPeopleRef.current) {
        setState(previous => previous.status === 'ready'
          ? previous
          : { status: 'error', people: [], errorText: 'تعذر تحميل الأشخاص القريبين. حاول مرة أخرى.' });
      }
    }
  }, [commitPeople, currentUserId]);

  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void refresh();
    }, REALTIME_DEBOUNCE_MS);
  }, [refresh]);

  // ===== استعادة المنطقة: كاش فوري ثم إعادة تحقق من profiles =====
  // القاعدة:
  //   - عند الفتح: تُقرأ المدينة من localStorage وتُعرض فوراً إن وُجدت.
  //   - فشل الاتصال/تعذر التحقق: تُحتفظ المدينة الموجودة في الكاش ولا تُمسح.
  //   - نجاح الاستعلام مع city أو location: تُحدَّث المدينة والكاش بالقيمة الجديدة.
  //   - نجاح الاستعلام وتأكّد أن city و location فارغان معاً: يُمسح مفتاح المدينة
  //     من localStorage، وتُصفَّر المدينة المعروضة، وتظهر حالة «لا توجد منطقة».
  useEffect(() => {
    if (!open) return undefined;
    let active = true;

    const cached = readCachedCity(currentUserId) || currentCity?.trim() || null;
    cityRef.current = cached;
    setResolvedCity(cached);
    // لا نُعيد الحالة إلى loading إذا كانت هناك قائمة معروضة بالفعل
    setState(previous => (previous.status === 'ready' ? previous : { status: 'loading', people: [], errorText: '' }));
    if (cached) void refresh();

    void (async () => {
      if (!supabaseConfigured) {
        // تعذّر التحقق (لا إعدادات اتصال): لا نمسح الكاش
        if (!active || cached) return;
        setState({ status: 'error', people: [], errorText: 'إعدادات الاتصال بقاعدة البيانات غير مكتملة.' });
        return;
      }

      try {
        // city و location لم تعودا ممنوحتين للقراءة المباشرة (ترحيل 20270206000000
        // لأنهما محكومتان بـ show_city)، فتُقرأ مدينة المستخدم نفسه عبر الدالة
        // المصرّح بها التي تُعيدها له دائماً.
        const { data, error } = await supabase.rpc('aani_public_profile', { p_user_id: currentUserId });
        if (error) throw error;
        if (!active) return;

        const row = (Array.isArray(data) ? data[0] : data) as NearbyProfileRow | null;

        // null = لم تُرجع القاعدة صفاً: هذه ليست شهادة بأن المدينة محذوفة
        if (!row) {
          if (!cached) {
            setState({ status: 'error', people: [], errorText: 'تعذر التحقق من منطقتك. تحقق من الاتصال ثم أعد المحاولة.' });
          }
          return;
        }

        const confirmed = pickCity(row);

        // (3) نجاح الاستعلام مع مدينة/موقع صالح → تحديث المدينة والكاش
        if (confirmed) {
          writeCachedCity(currentUserId, confirmed);
          cityRef.current = confirmed;
          setResolvedCity(confirmed);
          void refresh();
          return;
        }

        // (4) نجاح الاستعلام وتأكّد أن city و location فارغان معاً
        writeCachedCity(currentUserId, null);
        cityRef.current = null;
        requestSeqRef.current += 1; // تجاهل أي نتيجة جلب سابقة لمنطقة قديمة
        hasPeopleRef.current = false;
        setResolvedCity(null);
        setState({ status: 'no-city', people: [], errorText: '' });
      } catch (error) {
        // (2) فشل الشبكة/RLS ليس دليلاً على انعدام المنطقة: نحتفظ بالكاش والقائمة
        if (!active) return;
        console.warn('[nearby] تعذر إعادة التحقق من منطقة الحساب:', error);
        if (!cached) {
          setState({ status: 'error', people: [], errorText: 'تعذر التحقق من منطقتك. تحقق من الاتصال ثم أعد المحاولة.' });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [open, currentUserId, currentCity, refresh]);

  // ===== التحديث التلقائي: Realtime + فحص دوري صامت + عودة التبويب =====
  useEffect(() => {
    if (!open || !supabaseConfigured) return undefined;

    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let lastRebuildAt = 0;

    const buildChannel = () => {
      if (disposed) return;
      channel = supabase
        .channel(`aani-nearby-${currentUserId}`)
        // INSERT وUPDATE فقط: تغييرات الملف التي تُدخل شخصاً في القائمة أو تُخرجه
        // منها (مدينة/ظهور/تعطيل). أحداث DELETE لا تُشترك عمداً — الفحص الدوري
        // كل 6 ثوانٍ هو ما يلتقط الحذف واختفاء من أوقف الظهور.
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'profiles' },
          () => scheduleRefresh(),
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'profiles' },
          () => scheduleRefresh(),
        )
        .subscribe(status => {
          // فشل القناة صامت: الفحص الدوري يستمر، ونعيد بناء الاشتراك عند الحاجة
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') rebuildChannel();
        });
    };

    const rebuildChannel = () => {
      if (disposed) return;
      // ChannelState يحمل قيم realtime-js الفعلية (joined/joining) لا أسماء
      // حالات الإشتراك (SUBSCRIBED). التوسيع إلى string يجعل المقارنة صريحة.
      const channelState: string = channel ? channel.state : '';
      if (channelState === 'joined' || channelState === 'joining') return;
      const now = Date.now();
      if (now - lastRebuildAt < CHANNEL_REBUILD_COOLDOWN_MS) return;
      lastRebuildAt = now;
      if (channel) void supabase.removeChannel(channel);
      channel = null;
      buildChannel();
    };

    buildChannel();

    // إعادة الاتصال وإعادة الفحص فوراً عند العودة للتبويب أو عودة الشبكة
    const offReconnect = registerRealtimeReconnect(() => {
      rebuildChannel();
      void refresh();
    });

    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const interval = window.setInterval(() => {
      // الفحص الدوري يعمل فقط والتبويب ظاهر
      if (!isVisible()) return;
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      offReconnect();
      window.clearInterval(interval);
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (channel) void supabase.removeChannel(channel);
    };
  }, [open, currentUserId, refresh, scheduleRefresh]);

  // مفتاح الظهور: إيقافه يخفي ملف المستخدم من قائمة الأشخاص القريبين عند الجميع
  const handleToggleNearbyVisible = async (next: boolean) => {
    if (togglingVisible || !supabaseConfigured || !currentProfile) return;
    const previous = nearbyVisible;

    // تتفاؤلي: نحدّث الواجهة فوراً ونتراجع عند الفشل
    setNearbyVisible(next);
    setTogglingVisible(true);

    const { error } = await supabase
      .from('profiles')
      .update({ is_nearby_visible: next })
      .eq('id', currentUserId);
    setTogglingVisible(false);

    if (error) {
      setNearbyVisible(previous);
      toast.error(
        next
          ? 'تعذر تشغيل الظهور في الأشخاص القريبين. حاول مرة أخرى.'
          : 'تعذر إيقاف الظهور في الأشخاص القريبين. حاول مرة أخرى.',
      );
      return;
    }

    onProfileUpdate({ ...currentProfile, is_nearby_visible: next });
    toast.success(
      next
        ? 'أصبح ملفك ظاهراً في قائمة الأشخاص القريبين في مدينتك.'
        : 'تم إخفاء ملفك من قائمة الأشخاص القريبين عند الجميع.',
    );
  };

  // فتح الملف الشخصي: حرر مدخل حرس الرجوع ثم أغلق الشاشة ثم انتقل
  const openProfile = (personId: string) => {
    releaseOverlayBackForNavigation();
    onClose();
    navigate(`/profile/${encodeURIComponent(personId)}`);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="nearby-users-screen"
      role="dialog"
      aria-modal="true"
      aria-label="الأشخاص القريبون"
      dir="rtl"
    >
      <header className="nearby-users-header">
        <button
          type="button"
          onClick={onClose}
          aria-label="رجوع"
          className="nearby-users-back"
        >
          <ArrowRight size={24} />
        </button>
        <h1 className="nearby-users-title">الأشخاص القريبون</h1>
        <div className="nearby-users-toggle">
          <span className="nearby-users-toggle-label">الظهور</span>
          <Switch
            dir="ltr"
            className="nearby-users-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors"
            checked={nearbyVisible}
            disabled={togglingVisible || !supabaseConfigured}
            onCheckedChange={value => void handleToggleNearbyVisible(value)}
            aria-label="الظهور في قائمة الأشخاص القريبين"
          />
        </div>
        {resolvedCity ? (
          <span className="nearby-users-city">
            <MapPin size={12} aria-hidden="true" />
            <span className="nearby-users-city-name">{resolvedCity}</span>
          </span>
        ) : null}
      </header>

      <div className="nearby-users-list">
        {state.status === 'loading' && (
          <ListSkeleton count={8} avatarClass="h-12 w-12" className="px-4 py-2" />
        )}

        {state.status === 'no-city' && (
          <div className="nearby-users-note">
            <MapPin size={26} />
            <p>حدّد مدينتك في ملفك الشخصي لعرض الأشخاص القريبين منك.</p>
          </div>
        )}

        {state.status === 'error' && (
          <p role="alert" className="nearby-users-error">{state.errorText}</p>
        )}

        {state.status === 'ready' && state.people.length === 0 && (
          <EmptyState className="py-10" />
        )}

        {state.status === 'ready' && state.people.length > 0 && (
          <ul>
            {state.people.map(person => (
              <li key={person.id}>
                <button
                  type="button"
                  className="nearby-users-row"
                  onClick={() => openProfile(person.id)}
                >
                  <Avatar profile={person} large />
                  <UserIdentity
                    name={displayName(person)}
                    username={person.username}
                    className="min-w-0 flex-1"
                    nameClassName="text-sm font-semibold text-white"
                    usernameClassName="text-xs text-zinc-400"
                  />
                  {person.city?.trim() ? (
                    <span className="nearby-users-chip">
                      <MapPin size={11} />
                      {person.city}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
