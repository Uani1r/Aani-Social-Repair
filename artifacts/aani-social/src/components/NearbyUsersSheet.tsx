import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, MapPin } from 'lucide-react';
import { useLocation } from 'wouter';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { releaseOverlayBackForNavigation } from '@/lib/overlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

type NearbyUsersSheetProps = {
  open: boolean;
  onClose: () => void;
  currentUserId: string;
  /** مدينة المستخدم الحالي (profiles.city) — أساس فلترة الأشخاص القريبين */
  currentCity: string | null;
};

type NearbyUser = Pick<
  Profile,
  'id' | 'username' | 'full_name' | 'display_name' | 'avatar_url' | 'city'
>;

type NearbyUsersState =
  | { status: 'loading'; people: NearbyUser[]; errorText: '' }
  | { status: 'ready'; people: NearbyUser[]; errorText: '' }
  | { status: 'no-city'; people: NearbyUser[]; errorText: '' }
  | { status: 'error'; people: NearbyUser[]; errorText: string };

/**
 * شاشة «الأشخاص القريبون»: تعرض مستخدمي نفس المدينة المسجلة في
 * الملف الشخصي (profiles.city). تفتح من زر الدبوس في أعلى الشاشة الرئيسية.
 */
export default function NearbyUsersSheet({ open, onClose, currentUserId, currentCity }: NearbyUsersSheetProps) {
  // زر الرجوع (الهاتف/المتصفح) يغلق الشاشة ويعيدك لنفس المكان
  useOverlayBack(open, onClose);
  const [, navigate] = useLocation();
  const [state, setState] = useState<NearbyUsersState>({ status: 'loading', people: [], errorText: '' });

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setState({ status: 'loading', people: [], errorText: '' });

    const city = currentCity?.trim() || '';

    if (!supabaseConfigured) {
      setState({ status: 'error', people: [], errorText: 'إعدادات الاتصال بقاعدة البيانات غير مكتملة.' });
      return undefined;
    }
    if (!city) {
      setState({ status: 'no-city', people: [], errorText: '' });
      return undefined;
    }

    const load = async () => {
      const columns = 'id, username, full_name, display_name, avatar_url, city, is_deactivated';
      let result = await supabase
        .from('profiles')
        .select(columns)
        .eq('city', city)
        .neq('id', currentUserId)
        .eq('is_deactivated', false)
        .order('created_at', { ascending: false })
        .limit(60);

      // قاعدة بيانات بلا عمود is_deactivated بعد → أعد المحاولة بدونه
      if (
        result.error
        && (result.error.code === '42703' || result.error.code === 'PGRST204')
        && /is_deactivated/i.test(result.error.message || '')
      ) {
        result = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url, city')
          .eq('city', city)
          .neq('id', currentUserId)
          .order('created_at', { ascending: false })
          .limit(60);
      }
      return result;
    };

    void (async () => {
      try {
        const { data, error } = await load();
        if (!active) return;
        if (error) throw error;
        const people = ((data || []) as NearbyUser[]).filter(person => Boolean(person.id));
        setState({ status: 'ready', people, errorText: '' });
      } catch {
        if (active) {
          setState({ status: 'error', people: [], errorText: 'تعذر تحميل الأشخاص القريبين. حاول مرة أخرى.' });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [open, currentCity, currentUserId]);

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
        {currentCity?.trim() ? (
          <span className="nearby-users-city">
            <MapPin size={13} />
            {currentCity}
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
