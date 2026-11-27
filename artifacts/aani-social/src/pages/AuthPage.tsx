import { useState, useEffect, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePhoneToE164 } from '@/lib/accountAuth';
import { FemaleDefaultAvatar, MaleDefaultAvatar } from '@/components/DefaultAvatar';

type CityLookupResult = { ok: true; city: string } | { ok: false; message: string };

/**
 * التحديد الإجباري التلقائي للموقع عند التسجيل:
 * يطلب إذن الموقع من الجهاز (HTML5 Geolocation API) ويستخرج اسم المدينة/المحافظة
 * منه عبر خدمة ترميز جغرافي عكسي مجانية. لا يمكن تخطيها — يفشل إنشاء الحساب
 * بدون إذن الموقع أو عند تعذر استخراج المدينة.
 */
const resolveCityFromDevice = (): Promise<CityLookupResult> => new Promise(resolve => {
  if (!('geolocation' in navigator) || !navigator.geolocation) {
    resolve({ ok: false, message: 'متصفحك لا يدعم تحديد الموقع تلقائياً. افتح التسجيل من متصفح حديث يسمح بالوصول إلى الموقع.' });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async position => {
      try {
        const { latitude, longitude } = position.coords;
        const response = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=ar`,
        );
        if (!response.ok) throw new Error('reverse-geocode-failed');
        const details = await response.json() as {
          city?: unknown;
          principalSubdivision?: unknown;
          locality?: unknown;
          countryName?: unknown;
        };
        const city = [details.city, details.principalSubdivision, details.locality, details.countryName]
          .map(value => (typeof value === 'string' ? value.trim() : ''))
          .find(value => Boolean(value)) || '';
        if (!city) {
          resolve({ ok: false, message: 'تعذر استخراج اسم المدينة من موقعك. تأكد من اتصال الإنترنت ثم أعد المحاولة.' });
          return;
        }
        resolve({ ok: true, city: city.slice(0, 100) });
      } catch {
        resolve({ ok: false, message: 'تعذر استخراج اسم المدينة من موقعك. تأكد من اتصال الإنترنت ثم أعد المحاولة.' });
      }
    },
    () => resolve({ ok: false, message: 'لا يمكن إنشاء الحساب دون السماح بتحديد الموقع. اسمح بالوصول إلى الموقع في المتصفح ثم أعد المحاولة.' }),
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 },
  );
});

const Spinner = () => <span style={styles.spinner} aria-hidden="true" />;

const GoogleIcon = () => (
  <svg style={styles.providerIcon} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

const AppleIcon = () => (
  <svg style={styles.providerIcon} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M18.71 18.86c-.57.48-.93 1.11-.93 1.84 0 .73.36 1.36.93 1.84-.42.07-.83.17-1.23.29-.26.23-.5.48-.72.75-.22.27-.43.55-.62.84-.34.51-.64 1.06-.91 1.64-.27.59-.51 1.2-.72 1.84-.15.44-.27.89-.36 1.36-.09.47-.16.95-.2.1-.43-.03-.85-.08-1.26-.15-.42-.07-.83-.16-1.24-.26-.41-.09-.8-.2-1.18-.32-.43-.15-.84-.33-1.24-.54-.39-.2-.77-.42-1.12-.67-.2-.14-.39-.29-.57-.44-.19-.16-.36-.33-.51-.52-.15-.19-.28-.39-.39-.61-.1-.21-.18-.43-.24-.66-.06-.22-.09-.45-.09-.68 0-.23.03-.45.09-.66.06-.23.14-.44.24-.64.12-.22.25-.42.39-.6.11-.2.23-.4.4-.58.18-.18.37-.35.57-.5.21-.15.4-.29.6-.43.36-.25.74-.47 1.13-.66.42-.2.84-.39 1.25-.56.41-.17.82-.32 1.23-.45.41-.13.83-.24 1.24-.32.42-.09.83-.15 1.25-.19.42-.04.84-.07 1.26-.09.42-.02.84.04 1.25.12.4.08.79.18 1.17.3.39.13.76.28 1.12.45.35.16.68.34.99.53.31.19.6.4.87.63.27.23.51.48.73.75.22.27.41.56.58.86.17.3.32.6.45.9.12.3.21.61.28.92.07.31.12.62.14.94.02.31.02.63.01.94 0 .31-.01.62-.03.93-.02.31-.05.61-.09.9-.04.3-.1.59-.17.87-.08.29-.17.57-.27.84-.1.28-.21.55-.33.81-.12.26-.25.51-.39.75-.14.24-.29.47-.45.69-.16.22-.33.43-.51.63-.18.2-.37.39-.57.57-.2.18-.41.35-.63.5-.22.15-.44.29-.67.42-.23.13-.47.24-.72.33-.25.09-.5.16-.76.22-.26.06-.52.1-.78.13-.26.03-.51.04-.77.04-.26 0-.52-.01-.77-.04-.26-.03-.52-.07-.77-.13-.25-.05-.49-.11-.73-.19-.24-.08-.47-.17-.69-.28-.22-.11-.43-.23-.63-.36-.2-.13-.39-.27-.57-.42-.18-.15-.35-.31-.51-.48-.16-.17-.3-.35-.43-.54-.13-.19-.24-.39-.33-.6-.09-.21-.16-.43-.21-.65-.05-.22-.08-.44-.08-.67 0-.22.03-.43.08-.64.05-.21.12-.41.21-.6.09-.19.19-.37.3-.54.11-.17.23-.33.36-.48.13-.15.27-.29.41-.42.14-.13.28-.25.42-.36.14-.11.28-.21.42-.3.14-.09.27-.17.4-.24.13-.07.25-.13.37-.19.12-.06.23-.11.34-.16.11-.05.21-.09.31-.12.1-.03.2-.05.29-.07.09-.02.17-.03.26-.04.09 0 .18.01.26.01.08 0 .16.01.24.02.08.01.15.02.23.04.08.02.15.05.22.08.07.03.13.07.19.11.06.04.11.08.16.13.05.05.09.1.12.16.03.06.05.12.06.18.01.06.02.11.02.17 0 .06-.01.11-.02.16-.01.05-.02.1-.04.14-.02.04-.04.08-.06.12-.02.04-.04.07-.07.11-.03.04-.04-.07-.07.11-.03.03-.06-.05-.09-.08-.03-.03-.06-.05-.09-.08-.03-.03-.05-.05-.08-.07-.03-.02-.05-.03-.08-.04-.03-.01-.06-.02-.09-.02-.03 0-.05-.01-.08-.01-.03 0-.05.01-.08-.01-.03-.02-.05-.03-.08-.05-.03-.02-.05-.04-.08-.06-.03-.02-.05-.03-.08-.05-.03-.02-.05-.04-.08-.06-.03-.02-.05-.03-.08-.05-.03-.02-.06-.03-.09-.04-.03-.01-.05-.02-.08-.03-.03-.01-.05-.02-.08-.03-.03-.01-.06-.02-.09-.03-.03-.01-.05-.02-.08-.03-.03-.01-.05-.02-.08-.03-.03-.01-.06-.02-.09-.03-.03-.01-.05-.02-.08-.03"/>
  </svg>
);

const SupportIcon = () => (
  <svg style={styles.supportIcon} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M17 9h-5a2 2 0 0 0-2 2v3" />
  </svg>
);

const ChevronIcon = ({ rotated }: { rotated: boolean }) => (
  <svg style={{ ...styles.chevronIcon, transform: rotated ? 'rotate(180deg)' : 'rotate(0deg)' }} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function AuthPage({ mode, afterAuth }: { mode: 'login' | 'signup'; afterAuth: () => void }) {
  const isSignup = mode === 'signup';
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [statusNotice, setStatusNotice] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [showFallbackForm, setShowFallbackForm] = useState(false);
  const [fallbackIdentifier, setFallbackIdentifier] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState('');

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) { setError('إعدادات Supabase غير مكتملة في Secrets.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      if (isSignup) {
        setStatusNotice('نحدد موقعك تلقائياً الآن لضبط مدينتك — اسمح بالوصول إلى الموقع عند طلب المتصفح لإكمال التسجيل.');
        const geo = await resolveCityFromDevice();
        setStatusNotice('');
        if (!geo.ok) { setError(geo.message); return; }
        const city = geo.city;

        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim().toLowerCase(), full_name: fullName.trim(), gender, city } },
        });

        if (authError) throw authError;

        const signedUpUserId = data.session?.user?.id;
        if (signedUpUserId) {
          const { error: cityError } = await supabase
            .from('profiles')
            .update({ city, location: city })
            .eq('id', signedUpUserId);
          if (cityError) console.error('تعذر حفظ المدينة المستخرجة من الموقع:', cityError);
        }

        if (data.session) {
          afterAuth();
          setLocation('/feed');
        } else {
          setSuccess('تم إنشاء الحساب. افتح رسالة التفعيل التي أرسلناها إلى بريدك الإلكتروني، ثم سجّل الدخول.');
        }
      }
    } catch (reason: any) {
      const message = reason?.message || '';
      if (/profiles_username_lower_idx|duplicate key|unique constraint/i.test(message)) {
        setError('اسم المستخدم مستخدم بالفعل. اختر اسمًا آخر ثم حاول مجددًا.');
      } else if (/invalid path|request url|redirect/i.test(message)) {
        setError('رابط التفعيل غير مسموح في إعدادات Supabase. أضف نطاق الموقع المنشور إلى Auth ثم URL Configuration ثم Redirect URLs.');
      } else if (/database error saving new user/i.test(message)) {
        setError('تعذر إنشاء ملف الحساب. جرّب اسم مستخدم آخر، وإذا استمر الخطأ فتحقق من تطبيق مخطط profiles ومشغّل إنشاء الحساب في Supabase.');
      } else {
        setError(message || 'حدث خطأ في الاتصال. حاول مرة أخرى.');
      }
    } finally { setBusy(false); }
  };

  const signInWithProvider = async (provider: 'google' | 'apple') => {
    if (!supabaseConfigured || busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (authError) throw authError;
    } catch (reason: any) {
      setError(reason?.message || `تعذر المتابعة باستخدام ${provider === 'google' ? 'Google' : 'Apple'}.`);
      setBusy(false);
    }
  };

  const handleFallbackLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured || fallbackBusy) return;
    setFallbackBusy(true); setFallbackError('');

    const identifier = fallbackIdentifier.trim();
    const pwd = fallbackPassword;

    if (!identifier || !pwd) {
      setFallbackError('أدخل المعرف وكلمة المرور.');
      setFallbackBusy(false);
      return;
    }

    try {
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
      const normalizedPhone = normalizePhoneToE164(identifier);
      const isPhone = normalizedPhone !== null;

      if (isEmail) {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: identifier.toLowerCase(),
          password: pwd,
        });
        if (authError) throw authError;
      } else if (isPhone) {
        const { error: authError } = await supabase.auth.signInWithPassword({
          phone: normalizedPhone,
          password: pwd,
        });
        if (authError) throw authError;
      } else {
        const usernameIdentifier = identifier.replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_.]{3,32}$/.test(usernameIdentifier)) {
          throw new Error('أدخل بريدًا إلكترونيًا أو اسم مستخدم صالحًا أو رقم هاتف عراقيًا (مثلاً: 07701234567 أو +9647701234567).');
        }
        const { data, error: functionError } = await supabase.functions.invoke('login-with-username', {
          body: { username: usernameIdentifier, password: pwd },
        });
        if (functionError) {
          const context = (functionError as { context?: unknown }).context;
          if (context instanceof Response) {
            let responseBody: { error?: unknown; message?: unknown } | null = null;
            try {
              responseBody = await context.clone().json() as { error?: unknown; message?: unknown };
            } catch {
            }
            if (context.status === 401) {
              throw new Error(typeof responseBody?.error === 'string' ? responseBody.error : 'بيانات تسجيل الدخول غير صحيحة.');
            }
            const responseMessage = typeof responseBody?.error === 'string'
              ? responseBody.error
              : typeof responseBody?.message === 'string' ? responseBody.message : '';
            if (responseMessage) throw new Error(responseMessage);
          }
          throw functionError;
        }
        if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string') {
          throw new Error('تعذر إكمال تسجيل الدخول. حاول مرة أخرى.');
        }
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        });
        if (sessionError) throw sessionError;
      }

      afterAuth();
      setLocation('/feed');
    } catch (reason: any) {
      const message = reason?.message || '';
      if (/invalid.*(login|credentials)|wrong.*password|incorrect.*password/i.test(message)) {
        setFallbackError('المعرف أو كلمة المرور غير صحيحة.');
      } else if (/phone_exists|already.*(registered|in use)|duplicate/i.test(message)) {
        setFallbackError('هذا الرقم مرتبط بحساب آخر. استخدم رقماً مختلفاً.');
      } else if (/sms|phone provider|not enabled|phone signups?/i.test(message)) {
        setFallbackError('تسجيل الدخول برقم الهاتف غير متمكّن في إعدادات Supabase.');
      } else {
        setFallbackError(message || 'حدث خطأ في الاتصال. حاول مرة أخرى.');
      }
    } finally {
      setFallbackBusy(false);
    }
  };

  const openSupportEmail = () => {
    const subject = encodeURIComponent('تواصل مع دعم آني Aani');
    const body = encodeURIComponent('مرحباً فريق دعم آني،\n\nأود التواصل بخصوص: \n\n---\n\nمعلومات حسابي (إن وجدت):\n- البريد الإلكتروني: \n- اسم المستخدم: \n\nوصف المشكلة/الاستفسار:\n');
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <div style={styles.pageContainer}>
      <div style={styles.card}>
        <div style={styles.heroSection}>
          <div style={styles.sunWrapper} aria-hidden="true">
            <div style={styles.sunRipples} />
            <div style={styles.sunCore} />
          </div>
          <div style={styles.heroTextContent}>
            <span style={styles.badgeText}>مكانك هنا</span>
            <h1 style={styles.mainTitle}>
              كن حاضراً.<br />
              كن أنت.
            </h1>
            <p style={styles.subTitle}>تواصل، شارك، واترك أثرك.</p>
          </div>
        </div>

        <main style={styles.formSection}>
          {!supabaseConfigured && <div style={styles.noticeError} role="alert">أضف إعدادات Supabase للاتصال.</div>}
          {statusNotice && <div style={styles.noticeInfo} role="status">{statusNotice}</div>}
          {error && <div style={styles.noticeError} role="alert">{error}</div>}
          {success && <div style={styles.noticeSuccess} role="status">{success}</div>}

          <div style={styles.providerButtonsGrid} role="group" aria-label={isSignup ? 'إنشاء حساب سريع' : 'تسجيل الدخول السريع'}>
            <button
              type="button"
              disabled={busy || fallbackBusy || !supabaseConfigured}
              onClick={() => void signInWithProvider('google')}
              style={{ ...styles.providerBtn, ...styles.googleBtn, ...(busy || fallbackBusy || !supabaseConfigured ? styles.btnDisabled : {}) }}
              aria-busy={busy || fallbackBusy}
            >
              {busy ? (<><Spinner /><span>جاري التوجيه...</span></>) : (<><GoogleIcon /><span>{isSignup ? 'المتابعة عبر Google' : 'الدخول باستخدام Google'}</span></>)}
            </button>
            <button
              type="button"
              disabled={busy || fallbackBusy || !supabaseConfigured}
              onClick={() => void signInWithProvider('apple')}
              style={{ ...styles.providerBtn, ...styles.appleBtn, ...(busy || fallbackBusy || !supabaseConfigured ? styles.btnDisabled : {}) }}
              aria-busy={busy || fallbackBusy}
            >
              {busy ? (<><Spinner /><span>جاري التوجيه...</span></>) : (<><AppleIcon /><span>{isSignup ? 'المتابعة عبر Apple' : 'الدخول باستخدام Apple'}</span></>)}
            </button>
          </div>

          {isSignup ? (
            <>
              <form onSubmit={submit} style={styles.signupForm}>
                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="full-name">الاسم الكامل</label>
                  <input
                    id="full-name"
                    type="text"
                    required
                    maxLength={80}
                    autoComplete="name"
                    value={fullName}
                    onChange={event => setFullName(event.target.value)}
                    style={styles.input}
                    disabled={busy}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="username">اسم المستخدم</label>
                  <input
                    id="username"
                    type="text"
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9_.]+"
                    autoComplete="username"
                    dir="ltr"
                    placeholder="username"
                    value={username}
                    onChange={event => setUsername(event.target.value)}
                    style={styles.input}
                    disabled={busy}
                  />
                </div>
                <div style={styles.formGroup}>
                  <span style={styles.label}>الجنس — يحدد صورتك الافتراضية</span>
                  <div style={styles.genderRow}>
                    <button
                      type="button"
                      onClick={() => setGender('male')}
                      style={{ ...styles.genderCard, borderColor: gender === 'male' ? '#6266C7' : '#d8dfdb' }}
                      disabled={busy}
                    >
                      <MaleDefaultAvatar className="h-20 w-20" />
                      <span style={styles.genderLabel}>ذكر</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGender('female')}
                      style={{ ...styles.genderCard, borderColor: gender === 'female' ? '#6266C7' : '#d8dfdb' }}
                      disabled={busy}
                    >
                      <FemaleDefaultAvatar className="h-20 w-20" />
                      <span style={styles.genderLabel}>أنثى</span>
                    </button>
                  </div>
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="email">البريد الإلكتروني</label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    dir="ltr"
                    placeholder="أدخل بريدك الإلكتروني"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    style={styles.input}
                    disabled={busy}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="password">كلمة المرور</label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder="أدخل كلمة المرور"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    style={styles.input}
                    disabled={busy}
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy || !supabaseConfigured}
                  style={{ ...styles.btnSubmit, ...(busy || !supabaseConfigured ? styles.btnDisabled : {}) }}
                >
                  {busy ? 'جاري إنشاء الحساب...' : 'إنشاء حساب'}
                </button>
              </form>

              <div style={styles.switchLink}>
                لديك حساب؟ <Link href="/login" style={styles.link}>تسجيل الدخول</Link>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                style={styles.fallbackTriggerBtn}
                onClick={() => setShowFallbackForm(prev => !prev)}
                disabled={busy || fallbackBusy}
                aria-expanded={showFallbackForm}
                aria-controls="fallback-form"
              >
                <span style={styles.fallbackTriggerText}>
                  {showFallbackForm ? 'إخفاء التسجيل الاحتياطي' : 'التسجيل الاحتياطي'}
                </span>
                <ChevronIcon rotated={showFallbackForm} />
              </button>

              <div id="fallback-form" style={showFallbackForm ? styles.fallbackFormVisible : styles.fallbackFormHidden} role="region" aria-label="نموذج التسجيل الاحتياطي">
                <form onSubmit={handleFallbackLogin} style={styles.fallbackForm}>
                  <div style={styles.formGroup}>
                    <label style={styles.label} htmlFor="fallback-identifier">
                      رقم الهاتف أو اسم المستخدم أو البريد الإلكتروني
                    </label>
                    <input
                      id="fallback-identifier"
                      type="text"
                      required
                      autoComplete="username"
                      dir="ltr"
                      placeholder="07701234567 أو username أو email@example.com"
                      value={fallbackIdentifier}
                      onChange={event => { setFallbackIdentifier(event.target.value); setFallbackError(''); }}
                      style={styles.input}
                      disabled={fallbackBusy}
                    />
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label} htmlFor="fallback-password">كلمة المرور</label>
                    <input
                      id="fallback-password"
                      type="password"
                      required
                      minLength={6}
                      autoComplete="current-password"
                      placeholder="أدخل كلمة المرور"
                      value={fallbackPassword}
                      onChange={event => { setFallbackPassword(event.target.value); setFallbackError(''); }}
                      style={styles.input}
                      disabled={fallbackBusy}
                    />
                  </div>

                  {fallbackError && <div style={styles.noticeError} role="alert">{fallbackError}</div>}

                  <button
                    type="submit"
                    disabled={fallbackBusy || !supabaseConfigured}
                    style={{ ...styles.btnSubmit, ...(fallbackBusy || !supabaseConfigured ? styles.btnDisabled : {}) }}
                  >
                    {fallbackBusy ? 'جاري تسجيل الدخول...' : 'تسجيل الدخول'}
                  </button>
                </form>
              </div>

              <div style={styles.switchLink}>
                جديد هنا؟ <Link href="/signup" style={styles.link}>إنشاء حساب</Link>
              </div>
            </>
          )}

          <button
            type="button"
            style={styles.supportBtn}
            onClick={openSupportEmail}
            disabled={busy || fallbackBusy}
          >
            <SupportIcon />
            <span>تواصل مع الدعم</span>
          </button>
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  pageContainer: {
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
    maxWidth: '420px',
    minHeight: '100dvh',
    background: 'linear-gradient(180deg, #243b35 0%, #36534b 32%, #f5f6f4 58%, #f5f6f4 100%)',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  heroSection: {
    position: 'relative',
    padding: '70px 28px 30px 28px',
    overflow: 'hidden',
  },
  sunWrapper: {
    position: 'absolute',
    top: '-60px',
    right: '-50px',
    width: '260px',
    height: '260px',
    pointerEvents: 'none',
  },
  sunCore: {
    position: 'absolute',
    width: '160px',
    height: '160px',
    background: 'linear-gradient(135deg, #e58b66, #c26746)',
    borderRadius: '50%',
    top: '50px',
    right: '50px',
    zIndex: 2,
  },
  sunRipples: {
    position: 'absolute',
    width: '160px',
    height: '160px',
    borderRadius: '50%',
    top: '50px',
    right: '50px',
    boxShadow: '0 0 0 25px rgba(229, 139, 102, 0.22), 0 0 0 60px rgba(229, 139, 102, 0.12), 0 0 0 100px rgba(229, 139, 102, 0.05)',
    zIndex: 1,
  },
  heroTextContent: {
    position: 'relative',
    zIndex: 3,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: '18px',
    fontWeight: '700',
    display: 'block',
    marginBottom: '18px',
  },
  mainTitle: {
    color: '#ffffff',
    fontSize: '38px',
    fontWeight: '800',
    lineHeight: '1.25',
    marginBottom: '20px',
  },
  subTitle: {
    color: '#a2b7ae',
    fontSize: '15px',
    fontWeight: '500',
  },
  formSection: {
    padding: '20px 28px 40px 28px',
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  signupForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  formGroup: {
    marginBottom: '18px',
  },
  label: {
    display: 'block',
    fontSize: '14px',
    fontWeight: '700',
    color: '#243b35',
    marginBottom: '8px',
  },
  input: {
    width: '100%',
    padding: '16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    fontSize: '14px',
    color: '#243b35',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'Tajawal', sans-serif",
  },
  btnSubmit: {
    width: '100%',
    backgroundColor: '#243b35',
    color: '#ffffff',
    padding: '16px',
    border: 'none',
    borderRadius: '12px',
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    marginTop: '8px',
    fontFamily: "'Tajawal', sans-serif",
  },
  btnDisabled: { cursor: 'wait', opacity: 0.65 },
  genderRow: {
    display: 'flex',
    gap: '12px',
  },
  genderCard: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    padding: '16px 8px',
    border: '2px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    cursor: 'pointer',
  },
  genderLabel: {
    fontSize: '14px',
    fontWeight: 700,
    color: '#243b35',
  },
  noticeError: {
    marginBlock: '12px',
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
    marginBlock: '12px',
    padding: '11px 13px',
    border: '1px solid #b9c9e8',
    borderRadius: '8px',
    backgroundColor: '#eef3fc',
    color: '#2c4a7c',
    fontSize: '14px',
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  noticeSuccess: {
    marginBlock: '12px',
    padding: '11px 13px',
    border: '1px solid #b7d4be',
    borderRadius: '8px',
    backgroundColor: '#edf7ef',
    color: '#28553a',
    fontSize: '14px',
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  providerButtonsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    marginTop: '8px',
  },
  providerBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    height: '56px',
    padding: '0 16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    background: '#fff',
    color: '#243b35',
    fontSize: '15px',
    fontWeight: '700',
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
    transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease',
    minWidth: 0,
  },
  googleBtn: { borderColor: '#d8dfdb' },
  appleBtn: { borderColor: '#d8dfdb' },
  providerIcon: { width: '22px', height: '22px', flexShrink: 0 },
  spinner: {
    width: '20px',
    height: '20px',
    border: '2px solid #d8dfdb',
    borderTopColor: '#243b35',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  fallbackTriggerBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '14px 16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    background: '#f5f6f4',
    color: '#243b35',
    fontSize: '15px',
    fontWeight: '700',
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    marginTop: '4px',
  },
  fallbackTriggerText: { fontSize: '15px', fontWeight: '700' },
  chevronIcon: {
    width: '20px',
    height: '20px',
    flexShrink: 0,
    color: '#65716c',
    transition: 'transform 0.2s ease',
  },
  fallbackFormVisible: { animation: 'slideDown 0.3s ease-out' },
  fallbackFormHidden: { display: 'none' },
  fallbackForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingTop: '8px',
  },
  switchLink: {
    textAlign: 'center',
    marginTop: '16px',
    fontSize: '14px',
    color: '#243b35',
    fontWeight: '500',
  },
  link: {
    color: '#6266C7',
    fontWeight: '700',
    textDecoration: 'none',
  },
  supportBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: '14px 16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    background: '#fff',
    color: '#243b35',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'Tajawal', sans-serif",
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    marginTop: '8px',
  },
  supportIcon: {
    width: '22px',
    height: '22px',
    flexShrink: 0,
    color: '#6266C7',
  },
};