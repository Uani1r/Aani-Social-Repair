/**
 * شاشة تحدي التحقق بخطوتين (TOTP) — تُعرض بدل التطبيق كله.
 *
 * - لا تُعرض أي شاشة داخل التطبيق قبل `verify` ناجح وتحويل الجلسة إلى aal2.
 * - لا SMS ولا رقم هاتف: تطبيق مصادقة فقط.
 * - عند فقدان الجهاز لا تُخترع آلية استرداد: تُعرض رسالة واضحة وتُترك المراجعة
 *   للدعم، مع إمكانية تسجيل الخروج فقط.
 */
import { useState, type CSSProperties, type FormEvent } from 'react';

import { MFA_CODE_INVALID_MESSAGE, MFA_LOST_DEVICE_MESSAGE, MFA_UNAVAILABLE_MESSAGE } from '@/lib/accountMfa';
import { supabase } from '@/lib/supabase';

type Props = {
  factorId: string;
  onVerified: () => void;
  onSignOut: () => void;
};

export default function MfaChallengePage({ factorId, onVerified, onSignOut }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLostDevice, setShowLostDevice] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setError(MFA_CODE_INVALID_MESSAGE);
      return;
    }

    setBusy(true);
    setError('');
    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error || !challenge.data?.id) throw new Error(MFA_UNAVAILABLE_MESSAGE);

      const verified = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code: value,
      });
      if (verified.error) throw new Error(MFA_CODE_INVALID_MESSAGE);

      const accessToken = verified.data?.access_token;
      const refreshToken = verified.data?.refresh_token;
      if (typeof accessToken === 'string' && typeof refreshToken === 'string') {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (sessionError) throw new Error(MFA_UNAVAILABLE_MESSAGE);
      }

      setCode('');
      onVerified();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : MFA_CODE_INVALID_MESSAGE);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.page}>
      <main style={styles.card}>
        <h1 style={styles.title}>التحقق بخطوتين</h1>
        <p style={styles.note}>
          أدخل الرمز المكوّن من ستة أرقام من تطبيق المصادقة (Google Authenticator أو Apple Passwords أو ما يعادلهما).
        </p>

        <form onSubmit={submit} style={styles.form}>
          <label style={styles.label} htmlFor="mfa-code">رمز التحقق</label>
          <input
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            dir="ltr"
            value={code}
            onChange={event => { setCode(event.target.value.replace(/\D/g, '')); setError(''); }}
            style={styles.input}
            disabled={busy}
          />

          {error && <div style={styles.error} role="alert">{error}</div>}

          <button type="submit" disabled={busy || code.length !== 6} style={{ ...styles.primary, ...(busy ? styles.disabled : {}) }}>
            {busy ? 'جارٍ التحقق...' : 'تحقق'}
          </button>
        </form>

        <button type="button" style={styles.secondary} onClick={() => setShowLostDevice(prev => !prev)}>
          فقدت جهاز المصادقة؟
        </button>
        {showLostDevice && <p style={styles.note} role="status">{MFA_LOST_DEVICE_MESSAGE}</p>}

        <button type="button" style={styles.linkButton} onClick={onSignOut} disabled={busy}>
          تسجيل الخروج
        </button>
      </main>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a2b27',
    direction: 'rtl',
    padding: '24px 18px',
    boxSizing: 'border-box',
    fontFamily: "'Tajawal', sans-serif",
  },
  card: {
    width: '100%',
    maxWidth: '420px',
    backgroundColor: '#f5f6f4',
    borderRadius: '16px',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  title: { fontSize: '22px', fontWeight: 800, color: '#243b35', margin: 0 },
  note: { fontSize: '14px', lineHeight: 1.8, color: '#3c4f48', margin: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' },
  label: { fontSize: '14px', fontWeight: 700, color: '#243b35' },
  input: {
    width: '100%',
    padding: '14px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    fontSize: '22px',
    letterSpacing: '8px',
    textAlign: 'center',
    color: '#243b35',
    boxSizing: 'border-box',
  },
  error: {
    padding: '10px 12px',
    border: '1px solid #e8c5a5',
    borderRadius: '8px',
    backgroundColor: '#fff5eb',
    color: '#74442e',
    fontSize: '14px',
    lineHeight: 1.7,
  },
  primary: {
    padding: '14px',
    border: 'none',
    borderRadius: '12px',
    backgroundColor: '#243b35',
    color: '#ffffff',
    fontSize: '16px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  disabled: { cursor: 'wait', opacity: 0.65 },
  secondary: {
    padding: '12px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    color: '#243b35',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  linkButton: {
    padding: '10px',
    border: 'none',
    background: 'none',
    color: '#6266C7',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
};
