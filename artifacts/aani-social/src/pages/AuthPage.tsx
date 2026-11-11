import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';

import { supabase, supabaseConfigured } from '@/lib/supabase';
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

// --- صفحة تسجيل الدخول وإنشاء الحساب ---
export function AuthPage({ mode, afterAuth }: { mode: 'login' | 'signup'; afterAuth: () => void }) {
  const signUp = mode === 'signup';
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) { setError('إعدادات Supabase غير مكتملة في Secrets.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      if (signUp) {
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
      } else {
        const loginIdentifier = email.trim();
        const normalizedPhone = loginIdentifier.replace(/[\s()-]/g, '');
        if (loginIdentifier.includes('@')) {
          const { error: authError } = await supabase.auth.signInWithPassword({ email: loginIdentifier.toLowerCase(), password });
          if (authError) throw authError;
        } else if (/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
          const { error: authError } = await supabase.auth.signInWithPassword({ phone: normalizedPhone, password });
          if (authError) throw authError;
        } else {
          const usernameIdentifier = loginIdentifier.replace(/^@/, '').toLowerCase();
          if (!/^[a-z0-9_.]{3,32}$/.test(usernameIdentifier)) {
            throw new Error('أدخل بريدًا إلكترونيًا أو اسم مستخدم صالحًا أو رقم هاتف دوليًا يبدأ بـ +.');
          }
          const { data, error: functionError } = await supabase.functions.invoke('login-with-username', {
            body: { username: usernameIdentifier, password },
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
        afterAuth(); setLocation('/feed');
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

          <form onSubmit={submit}>
            {signUp && (
              <>
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
                  />
                </div>
                <div style={styles.formGroup}>
                  <span style={styles.label}>الجنس — يحدد صورتك الافتراضية</span>
                  <div style={styles.genderRow}>
                    <button
                      type="button"
                      onClick={() => setGender('male')}
                      style={{ ...styles.genderCard, borderColor: gender === 'male' ? '#6266C7' : '#d8dfdb' }}
                    >
                      <MaleDefaultAvatar className="h-20 w-20" />
                      <span style={styles.genderLabel}>ذكر</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGender('female')}
                      style={{ ...styles.genderCard, borderColor: gender === 'female' ? '#6266C7' : '#d8dfdb' }}
                    >
                      <FemaleDefaultAvatar className="h-20 w-20" />
                      <span style={styles.genderLabel}>أنثى</span>
                    </button>
                  </div>
                </div>
              </>
            )}

            <div style={styles.formGroup}>
              <label style={styles.label} htmlFor={signUp ? 'email' : 'login-identifier'}>
                {signUp ? 'البريد الإلكتروني' : 'البريد الإلكتروني أو اسم المستخدم أو رقم الهاتف'}
              </label>
              <input
                id={signUp ? 'email' : 'login-identifier'}
                type={signUp ? 'email' : 'text'}
                required
                autoComplete={signUp ? 'email' : 'username'}
                dir="ltr"
                placeholder={signUp ? 'أدخل بريدك الإلكتروني' : 'name@example.com أو username أو +9665XXXXXXXX'}
                value={email}
                onChange={event => setEmail(event.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label} htmlFor="password">كلمة المرور</label>
              <input
                id="password"
                type="password"
                required
                minLength={6}
                autoComplete={signUp ? 'new-password' : 'current-password'}
                placeholder="أدخل كلمة المرور"
                value={password}
                onChange={event => setPassword(event.target.value)}
                style={styles.input}
              />
            </div>

            <button
              type="submit"
              disabled={busy || !supabaseConfigured}
              style={{ ...styles.btnSubmit, ...(busy || !supabaseConfigured ? styles.btnDisabled : {}) }}
            >
              {busy ? 'جاري الدخول...' : signUp ? 'إنشاء حساب' : 'تسجيل الدخول'}
            </button>
          </form>

          <div aria-label="خيارات تسجيل الدخول عبر مزود خارجي" style={{ marginTop: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#65716c', fontSize: '12px', marginBottom: '10px' }}>
              <span style={{ height: '1px', flex: 1, background: '#d8dfdb' }} />
              <span>أو المتابعة باستخدام</span>
              <span style={{ height: '1px', flex: 1, background: '#d8dfdb' }} />
            </div>
            <button
              type="button"
              disabled={busy || !supabaseConfigured}
              onClick={() => void signInWithProvider('google')}
              style={{ width: '100%', marginTop: '8px', padding: '13px', border: '1px solid #d8dfdb', borderRadius: '12px', background: '#fff', color: '#243b35', fontSize: '14px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}
            >
              {signUp ? 'المتابعة باستخدام Google' : 'الدخول باستخدام Google'}
            </button>
            <button
              type="button"
              disabled={busy || !supabaseConfigured}
              onClick={() => void signInWithProvider('apple')}
              style={{ width: '100%', marginTop: '8px', padding: '13px', border: '1px solid #d8dfdb', borderRadius: '12px', background: '#fff', color: '#243b35', fontSize: '14px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}
            >
              {signUp ? 'المتابعة باستخدام Apple' : 'الدخول باستخدام Apple'}
            </button>
          </div>

          <div style={styles.signupLink}>
            {signUp ? 'لديك حساب؟ ' : 'جديد هنا؟ '}
            <Link href={signUp ? '/login' : '/signup'} style={styles.link}>
              {signUp ? 'تسجيل الدخول' : 'أنشئ حساباً'}
            </Link>
          </div>
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
  btnDisabled: { cursor: 'wait', opacity: 0.65 },
  signupLink: {
    textAlign: 'center',
    marginTop: '22px',
    fontSize: '14px',
    color: '#243b35',
    fontWeight: '500',
  },
  link: {
    color: '#243b35',
    fontWeight: '700',
    textDecoration: 'none',
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
};
