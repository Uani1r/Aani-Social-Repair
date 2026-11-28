import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useLocation } from 'wouter';

import { ProfileFormFields } from '@/components/auth/ProfileFormFields';
import { AUTH_GATE_MESSAGES } from '@/lib/authGate';
import { looksLikePlaceholderUsername } from '@/lib/onboarding';
import {
  EMPTY_PROFILE_DRAFT,
  PROFILE_COMPLETION_MESSAGES,
  completeOnboarding,
  validateProfileDraft,
  type ProfileDraft,
} from '@/lib/profileCompletion';
import { checkUsernameAvailability, type UsernameAvailability } from '@/lib/usernameAvailability';
import { validateUsername } from '@/lib/usernameRules';
import type { Profile } from '@/lib/types';

/**
 * إكمال التسجيل بعد Google — واجهة طبيعية لا بوابة تقنية.
 *
 * مستخدم Google الجديد لا يدخل التطبيق: يصل هنا بملف بديل من المشغّل وبلا
 * إكمال. الحقول: الاسم الكامل (معبأ من Google وقابل للتعديل)، اسم المستخدم
 * (بقواعد 1–32 مع تحقق توفر), تاريخ الميلاد، الجنس باختيار صريح، والموافقة.
 *
 * لا بريد ولا كلمة مرور: حساب Google لا يحتاجها. والحفظ يمر بدالة ذرية واحدة
 * تحفظ الموافقة ووقتها و`onboarding_completed_at`، فلا يستطيع العميل تجاوز
 * اسم محجوز أو ممنوع.
 *
 * بعد الحفظ يُعاد تحميل الملف من Supabase (يمر به onCompleted)، ولا يُنقل
 * المستخدم إلى /feed إلا بعد نجاح التحقق.
 */

export type OnboardingPageProps = {
  profile: Profile | null;
  userId: string;
  /** الاسم الكامل من Google لتعبئة أولية قابلة للتعديل. */
  providerFullName?: string;
  /** اقتراح اسم مستخدم من Google أو البريد — اقتراح فقط. */
  suggestedUsername?: string;
  /** يعيد تحميل الملف من قاعدة البيانات ويُبلغ عن اكتماله. */
  onCompleted: () => Promise<{ ok: boolean; message?: string }>;
  onSignOut: () => void;
};

function buildInitialDraft(
  profile: Profile | null,
  userId: string,
  providerFullName: string | undefined,
  suggestedUsername: string | undefined,
): ProfileDraft {
  const storedUsername = profile?.username ?? '';
  const storedIsPlaceholder = looksLikePlaceholderUsername(storedUsername, userId);
  const storedFullName = (providerFullName || profile?.full_name || '').trim();
  const gender = profile?.gender === 'female' ? 'female' : profile?.gender === 'male' ? 'male' : null;

  return {
    ...EMPTY_PROFILE_DRAFT,
    fullName: storedFullName.slice(0, 120),
    // الاسم البديل الذي أنشأه المشغّل ليس اختيار المستخدم: يُستبدل بالاقتراح.
    username: storedIsPlaceholder ? (suggestedUsername || '') : storedUsername,
    birthDate: profile?.birth_date || '',
    gender,
    // الموافقة محددة افتراضياً وقابلة لإلغاء التحديد قبل الحفظ.
    termsAccepted: true,
  };
}

export function OnboardingPage({
  profile,
  userId,
  providerFullName,
  suggestedUsername,
  onCompleted,
  onSignOut,
}: OnboardingPageProps) {
  const [, setLocation] = useLocation();
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    buildInitialDraft(profile, userId, providerFullName, suggestedUsername));
  const [availability, setAvailability] = useState<UsernameAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // تحقق التوفر بعد توقف الكتابة: لا طلب لكل محرف، ولا قرار إتاحة من الواجهة.
  useEffect(() => {
    const validation = validateUsername(draft.username);
    if (!validation.ok) {
      setAvailability(null);
      setChecking(false);
      return undefined;
    }

    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void checkUsernameAvailability(validation.username).then(result => {
        if (cancelled) return;
        setAvailability(result);
        setChecking(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setChecking(false);
    };
  }, [draft.username]);

  const usernameValidation = validateUsername(draft.username);
  const currentAvailability = availability && usernameValidation.ok
    && availability.username === usernameValidation.username
    ? availability
    : null;

  let usernameNotice = '';
  let usernameNoticeTone: 'neutral' | 'ok' | 'error' = 'neutral';
  if (!usernameValidation.ok) {
    usernameNotice = draft.username ? usernameValidation.message : '';
    usernameNoticeTone = draft.username ? 'error' : 'neutral';
  } else if (checking) {
    usernameNotice = 'جارٍ التحقق من توفر الاسم…';
  } else if (currentAvailability) {
    usernameNotice = currentAvailability.message;
    usernameNoticeTone = currentAvailability.verified && currentAvailability.available ? 'ok' : 'error';
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');

    const validation = validateProfileDraft(draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    // اسم متحقق منه وغير متاح: لا يُرسل طلب سيعرف الخادم رفضه.
    if (currentAvailability && currentAvailability.verified && !currentAvailability.available) {
      setError(currentAvailability.message);
      return;
    }

    setBusy(true);
    try {
      const outcome = await completeOnboarding(draft);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      const verification = await onCompleted();
      if (!verification.ok) {
        setError(verification.message || PROFILE_COMPLETION_MESSAGES.verifyFailed);
        return;
      }

      setLocation('/feed');
    } finally {
      setBusy(false);
    }
  };

  const missingProfile = profile === null;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.hero}>
          <div style={styles.sun} aria-hidden="true" />
          <div style={styles.heroText}>
            <span style={styles.badge}>خطوة أخيرة</span>
            <h1 style={styles.title}>أكمل ملفك</h1>
            <p style={styles.subtitle}>
              دخولك عبر Google تم. نكمل الآن اسمك واسم المستخدم وتاريخ ميلادك — بلا بريد ولا كلمة مرور.
            </p>
          </div>
        </div>

        <main style={styles.formSection}>
          {error && <div style={styles.noticeError} role="alert">{error}</div>}

          {missingProfile && (
            <div style={styles.noticeInfo} role="status">
              لا يوجد ملف شخصي بعد. حفظ هذا النموذج ينشئه ببياناتك.
            </div>
          )}

          <form onSubmit={submit} style={styles.form}>
            <ProfileFormFields
              draft={draft}
              onChange={patch => {
                setError('');
                setDraft(previous => ({ ...previous, ...patch }));
              }}
              disabled={busy}
              usernameNotice={usernameNotice}
              usernameNoticeTone={usernameNoticeTone}
            />

            <button
              type="submit"
              disabled={busy}
              style={{ ...styles.submit, ...(busy ? styles.submitDisabled : {}) }}
            >
              {busy ? 'جارٍ الحفظ…' : 'حفظ ومتابعة'}
            </button>
          </form>

          <p style={styles.hint}>{AUTH_GATE_MESSAGES.loading}</p>

          <button type="button" style={styles.signOut} onClick={onSignOut} disabled={busy}>
            {AUTH_GATE_MESSAGES.signOut}
          </button>
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    width: '100%',
    minHeight: '100dvh',
    backgroundColor: '#1a2b27',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    direction: 'rtl',
    fontFamily: "'Tajawal', sans-serif",
  },
  card: {
    width: '100%',
    maxWidth: '460px',
    minHeight: '100dvh',
    background: 'linear-gradient(180deg, #243b35 0%, #36534b 26%, #f5f6f4 52%, #f5f6f4 100%)',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
  },
  hero: {
    position: 'relative',
    padding: '64px 28px 26px',
    overflow: 'hidden',
  },
  sun: {
    position: 'absolute',
    top: '-40px',
    left: '-40px',
    width: '170px',
    height: '170px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #e58b66, #c26746)',
    opacity: 0.55,
    pointerEvents: 'none',
  },
  heroText: { position: 'relative', zIndex: 2 },
  badge: { display: 'block', color: '#ffffff', fontSize: '16px', fontWeight: 700, marginBottom: '14px' },
  title: { margin: 0, color: '#ffffff', fontSize: '32px', fontWeight: 800, lineHeight: 1.3 },
  subtitle: { margin: '12px 0 0', color: '#a2b7ae', fontSize: '14px', fontWeight: 500, lineHeight: 1.9 },
  formSection: {
    padding: '20px 28px 40px',
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  form: { display: 'flex', flexDirection: 'column', gap: '4px' },
  submit: {
    width: '100%',
    marginTop: '8px',
    padding: '16px',
    border: 'none',
    borderRadius: '12px',
    backgroundColor: '#243b35',
    color: '#ffffff',
    fontSize: '16px',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
  },
  submitDisabled: { cursor: 'wait', opacity: 0.65 },
  noticeError: {
    marginBlock: '4px',
    padding: '11px 13px',
    border: '1px solid #e8c5a5',
    borderRadius: '8px',
    backgroundColor: '#fff5eb',
    color: '#74442e',
    fontSize: '14px',
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  noticeInfo: {
    marginBlock: '4px',
    padding: '11px 13px',
    border: '1px solid #b9c9e8',
    borderRadius: '8px',
    backgroundColor: '#eef3fc',
    color: '#2c4a7c',
    fontSize: '13px',
    lineHeight: 1.7,
  },
  hint: {
    margin: 0,
    textAlign: 'center',
    fontSize: '12px',
    color: '#65716c',
  },
  signOut: {
    width: '100%',
    padding: '13px 16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    color: '#243b35',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
  },
};

export default OnboardingPage;
