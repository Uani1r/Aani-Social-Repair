import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowUpLeft } from 'lucide-react';

import { supabase, supabaseConfigured } from '@/lib/supabase';

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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) { setError('إعدادات Supabase غير مكتملة في Secrets.'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      if (signUp) {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim().toLowerCase(), full_name: fullName.trim() } },
        });

        if (authError) throw authError;

        if (data.session) { 
          afterAuth(); 
          setLocation('/feed'); 
        } else { 
          setSuccess('تم إنشاء الحساب. افتح رسالة التفعيل التي أرسلناها إلى بريدك الإلكتروني، ثم سجّل الدخول.');
        }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
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

  return (
    <div className="auth-page">
      <div className="auth-scenery">
        <div className="sun-disc" />
        <div className="scenery-copy">
          <span>أهلًا بك في آني</span>
          <h2>هنا،<br />يبدأ الحديث<br /><em>ببساطة.</em></h2>
          <p>مساحة عربية للحظاتك وأحاديثك اليومية.</p>
        </div>
        <div className="scenery-lines" />
      </div>
      <section className="auth-panel">
        <Link href="/login" className="brand auth-brand">
          <span className="brand-mark">آ</span><span>آني <small>Aani</small></span>
        </Link>
        <div className="auth-form-wrap fade-up">
          <span className="eyebrow">{signUp ? 'انضم إلى آني' : 'سعدنا بعودتك'}</span>
          <h1>{signUp ? 'ابدأ مساحتك.' : 'أكمل حديثك.'}</h1>
          <p className="auth-lede">{signUp ? 'أنشئ حسابك وشارك ما يجعل يومك يومًا.' : 'سجّل الدخول لتعود إلى مجتمعك.'}</p>
          {!supabaseConfigured && <div className="notice notice-error" role="alert">أضف إعدادات Supabase للاتصال.</div>}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {success && <div className="notice notice-success" role="status">{success}</div>}
          <form className="auth-form" onSubmit={submit}>
            {signUp && (
              <>
                <label className="field">
                  <span>الاسم الكامل</span>
                  <input required maxLength={80} value={fullName} onChange={e => setFullName(e.target.value)} autoComplete="name" />
                </label>
                <label className="field">
                  <span>اسم المستخدم</span>
                  <input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.]+" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" dir="ltr" placeholder="username" />
                </label>
              </>
            )}
            <label className="field">
              <span>البريد الإلكتروني</span>
              <input required type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" dir="ltr" />
            </label>
            <label className="field">
              <span>كلمة المرور</span>
              <input required type="password" minLength={6} value={password} onChange={e => setPassword(e.target.value)} autoComplete={signUp ? 'new-password' : 'current-password'} dir="ltr" />
            </label>
            <button className="button-primary auth-submit" type="submit" disabled={busy || !supabaseConfigured}>
              {busy ? 'جارٍ المتابعة…' : signUp ? 'إنشاء حساب' : 'تسجيل الدخول'}
              <ArrowUpLeft size={17} />
            </button>
          </form>
          <p className="auth-switch">
            {signUp ? 'لديك حساب؟' : 'جديد هنا؟'} <Link href={signUp ? '/login' : '/signup'}>{signUp ? 'تسجيل الدخول' : 'أنشئ حسابًا'}</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
