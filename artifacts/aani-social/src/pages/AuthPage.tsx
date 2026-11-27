import { useState, useEffect, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePhoneToE164 } from '@/lib/accountAuth';

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

// --- صفحة تسجيل الدخول وإنشاء الحساب ---
export function AuthPage({ mode, afterAuth }: { mode: 'login' | 'signup'; afterAuth: () => void }) {
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // حالة رسالة أثناء تحديد الموقع الإجباري عند التسجيل
  const [statusNotice, setStatusNotice] = useState('');
  // الجنس المختار عند إنشاء الحساب — يحدد الأيقونة الشخصية الافتراضية
  const [gender, setGender] = useState<'male' | 'female'>('male');
  // حالة النموذج الاحتياطي (Accordion)
  const [showFallbackForm, setShowFallbackForm] = useState(false);
  // قيمة حقل المعرف الموحد في النموذج الاحتياطي
  const [fallbackIdentifier, setFallbackIdentifier] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState('');

  // حقن keyframes للرسوم المتحركة البسيطة
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      @keyframes slideDown {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) { setError('إعدادات Supabase غير مكتملة في Secrets.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      if (mode === 'signup') {
        // التحديد الإجباري التلقائي للموقع: لا يكتمل إنشاء الحساب بدون إذن الموقع ومدينة مستخرجة
        setStatusNotice('نحدد موقعك تلقائياً الآن لضبط مدينتك — اسمح بالوصول إلى الموقع عند طلب المتصفح لإكمال التسجيل.');
        const geo = await resolveCityFromDevice();
        setStatusNotice('');
        if (!geo.ok) {
          setError(geo.message);
          return;
        }
        const city = geo.city;

        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim().toLowerCase(), full_name: fullName.trim(), gender, city } },
        });

        if (authError) throw authError;

        // اكتب المدينة مباشرة في الملف أيضاً (احتياط إن لم يكن مشغّل إنشاء الملف محدثاً بعد)
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

  // معالجة تسجيل الدخول بالنموذج الاحتياطي
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
      // كشف نوع المعرف: بريد إلكتروني، رقم هاتف، أو اسم مستخدم
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
      const normalizedPhone = normalizePhoneToE164(identifier);
      const isPhone = normalizedPhone !== null;

      if (isEmail) {
        // مسار البريد الإلكتروني
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: identifier.toLowerCase(),
          password: pwd,
        });
        if (authError) throw authError;
      } else if (isPhone) {
        // مسار رقم الهاتف
        const { error: authError } = await supabase.auth.signInWithPassword({
          phone: normalizedPhone,
          password: pwd,
        });
        if (authError) throw authError;
      } else {
        // مسار اسم المستخدم
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
              // Keep the SDK error when the function response is not JSON.
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

      // نجاح تسجيل الدخول
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

  // فتح عميل البريد للتواصل مع الدعم
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

          {/* القسم الأول: الدخول السريع عبر Google و Apple */}
          <div style={styles.providerButtonsGrid} role="group" aria-label="تسجيل الدخول السريع">
            <button
              type="button"
              disabled={busy || fallbackBusy || !supabaseConfigured}
              onClick={() => void signInWithProvider('google')}
              style={{ ...styles.providerBtn, ...styles.googleBtn, ...(busy || fallbackBusy || !supabaseConfigured ? styles.btnDisabled : {}) }}
              aria-busy={busy || fallbackBusy}
            >
              {busy ? (
                <>
                  <span style={styles.spinner} aria-hidden="true" />
                  <span>جاري التوجيه...</span>
                </>
              ) : (
                <>
                  <svg style={styles.providerIcon} viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span>المتابعة عبر Google</span>
                </>
              )}
            </button>
            <button
              type="button"
              disabled={busy || fallbackBusy || !supabaseConfigured}
              onClick={() => void signInWithProvider('apple')}
              style={{ ...styles.providerBtn, ...styles.appleBtn, ...(busy || fallbackBusy || !supabaseConfigured ? styles.btnDisabled : {}) }}
              aria-busy={busy || fallbackBusy}
            >
              {busy ? (
                <>
                  <span style={styles.spinner} aria-hidden="true" />
                  <span>جاري التوجيه...</span>
                </>
              ) : (
                <>
                  <svg style={styles.providerIcon} viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M17.05 20.65c-.98.98-2.22 1.47-3.57 1.47-2.57 0-4.88-1.29-6.21-3.25C5.57 17.43 4.3 15.28 4.3 12.83c0-1.13.27-2.19.78-3.14.37-.68.83-1.3 1.36-1.83l.02-.02c.02-.02.04-.04.07-.05.33-.18.68-.31 1.06-.38.6-.1.85-.36.85-.97 0-.87-.59-1.47-1.41-1.47-.38 0-.73.12-1.03.34-.06.04-.13.07-.2.11-.09.05-.19.11-.28.16-.28.15-.57.27-.87.35-.08.03-.16.07-.25.1-.28.09-.56.17-.85.22-.38.07-.76.11-1.15.11-1.07 0-1.96-.54-2.36-1.34C1.04 3.8.75 2.62.71 2.53.55 2.12.46 1.7.44 1.26.42.89.46.48.57.12.85-.57 1.23-1.37 1.7-2.44.38-3.14 1.58-3.42 2.57-3.17 3.26-2.53 4.27-1.58 5.12-.35 6.22 1.19 7.54 3.1 8.59 5.08 9.47 6.73 10.75 8.06 12.5 8.13 12.66 8.12 12.85 8.04 13.04c-.23.5-.38 1.03-.44 1.58-.03.28.03.58.13.84.2.55.5 1.05.9 1.49.39.43.85.79 1.35 1.07.5.27 1.04.43 1.6.43.6 0 1.15-.18 1.63-.5.28-.18.54-.39.78-.62.07-.06.14-.12.21-.19.45-.44.81-.95 1.05-1.53.21-.5.32-1.03.32-1.58 0-1.2-.43-2.24-1.13-2.99-.39-.42-.85-.78-1.37-1.06-.5-.27-1.03-.43-1.59-.43-.47 0-.93.11-1.35.32-.3.15-.59.33-.86.54-.43.34-.82.72-1.15 1.15-.22.28-.41.58-.57.9-.04.09-.08.18-.11.28-.04.13-.07.26-.1.4-.02.09-.04.18-.05.27 0 .11.02.21.05.3.1.31.27.58.5.8.57.52 1.27.86 2.09.98.44.07.88.11 1.32.11.7 0 1.32-.16 1.84-.47.38-.23.71-.52.99-.84.19-.22.36-.45.5-.7.04-.07.08-.14.11-.21 0-.04-.01-.07-.01-.11 0-.07.01-.14.03-.2.03-.1.06-.2.1-.29.1-.23.22-.44.35-.65.15-.26.31-.5.48-.73.17-.23.35-.45.54-.65.09-.1.19-.2.29-.29.08-.07.16-.13.25-.19.03-.02.07-.03.1-.04.08-.04.16-.07.24-.1.13-.06.26-.1.39-.14.08-.02.17-.03.25-.04.32-.04.65-.04.97-.03.19.01.38.02.56.03.13 0 .26-.01.39-.02.21-.02.42-.05.62-.1.35-.08.67-.2 1-.37.35-.18.68-.4 1-.66.33-.27.62-.57.88-.9.13-.17.25-.34.36-.52.08-.12.16-.24.23-.36.05-.08.11-.15.17-.22.12-.13.24-.26.37-.38.04-.04.08-.08.12-.12.14-.13.29-.25.44-.36.21-.16.43-.31.65-.45.09-.05.18-.1.27-.14.1-.05.2-.09.3-.12.11-.04.22-.07.33-.1.22-.07.43-.13.64-.18.38-.09.76-.16 1.13-.2.21-.03.41-.05.62-.06.34 0 .68.02 1.02.06.11.01.22.02.33.04.11.01.22.03.33.04.22.02.44.03.66.03.1 0 .2-.01.29-.01.22-.01.44-.03.65-.06.18-.02.36-.05.53-.08.3-.05.59-.1.87-.17.37-.1.71-.23 1.04-.38.22-.1.43-.2.64-.3.09-.04.17-.08.26-.12.25-.12.49-.25.72-.38.33-.19.63-.4.92-.6.27-.19.53-.39.78-.58.08-.06.16-.12.24-.18.35-.27.67-.56.96-.87.1-.1.2-.2.3-.3.31-.31.62-.62.92-.93.17-.17.33-.34.5-.5.39-.36.78-.72 1.15-1.07.46-.44.9-.88 1.33-1.31.24-.24.47-.48.7-.71.2-.2.4-.39.6-.58.1-.1.19-.2.29-.29.05-.05.1-.1.15-.15.16-.16.32-.32.47-.48.14-.15.28-.29.41-.43.21-.22.43-.43.64-.64.18-.18.35-.36.52-.54.18-.18.37-.35.55-.52.12-.11.25-.21.37-.31.03-.03.06-.06.09-.09.09-.09.18-.18.27-.27.17-.17.33-.33.5-.5.3-.3.59-.59.88-.88.22-.22.44-.43.65-.64.09-.09.18-.17.27-.25.05-.04.1-.08.14-.12.16-.17.33-.33.49-.5.06-.05.11-.1.17-.14.17-.14.35-.28.52-.41.09-.07.18-.13.27-.19.19-.13.38-.25.57-.37.24-.15.48-.29.72-.42.36-.21.72-.41 1.07-.6.15-.08.3-.15.45-.22.12-.06.25-.11.37-.16.07-.03.13-.06.2-.08.27-.09.54-.17.81-.24.37-.1.74-.19 1.11-.25.21-.04.43-.07.64-.1.16-.02.32-.04.48-.05.06 0 .12-.01.18-.01.16-.01.31-.02.47-.02.15 0 .3-.01.45-.01.19 0 .38-.01.57-.01.09 0 .18 0 .27 0 .23 0 .45 0 .68.01.11 0 .22-.01.33-.01.22-.01.43-.03.65-.04.16-.01.32-.02.48-.04.12-.01.24-.01.36-.01.27-.01.53-.01.8-.01.1 0 .2 0 .3 0 .2 0 .39 0 .59.01.15 0 .29.01.44.01.21 0 .42-.01.63-.01.09 0 .18 0 .26 0 .09 0 .18 0 .27 0 .2 0 .4-.01.59-.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01.14 0 .27.01.41.01.2.01.4.01.59.01.1 0 .2-.01.3-.01.05 0 .1 0 .15 0 .18 0 .35 0 .53.01"/>
                  </svg>
                  <span>المتابعة عبر Apple</span>
                </>
              )}
            </button>
          </div>

          {/* القسم الثاني: التسجيل الاحتياطي */}
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
            <svg style={{ ...styles.chevronIcon, transform: showFallbackForm ? 'rotate(180deg)' : 'rotate(0deg)' }} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {/* نموذج التسجيل الاحتياطي (Accordion) */}
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

          {/* القسم الثالث: التواصل مع الدعم */}
          <button
            type="button"
            style={styles.supportBtn}
            onClick={openSupportEmail}
            disabled={busy || fallbackBusy}
          >
            <svg style={styles.supportIcon} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <path d="M17 9h-5a2 2 0 0 0-2 2v3" />
            </svg>
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
  googleBtn: {
    borderColor: '#d8dfdb',
  },
  appleBtn: {
    borderColor: '#d8dfdb',
  },
  providerIcon: {
    width: '22px',
    height: '22px',
    flexShrink: 0,
  },
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
  fallbackTriggerText: {
    fontSize: '15px',
    fontWeight: '700',
  },
  chevronIcon: {
    width: '20px',
    height: '20px',
    flexShrink: 0,
    color: '#65716c',
    transition: 'transform 0.2s ease',
  },
  fallbackFormVisible: {
    animation: 'slideDown 0.3s ease-out',
  },
  fallbackFormHidden: {
    display: 'none',
  },
  fallbackForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingTop: '8px',
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