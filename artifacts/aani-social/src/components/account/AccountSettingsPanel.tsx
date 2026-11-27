/**
 * إعدادات الحساب: البريد، الهاتف، كلمة المرور، التحقق بخطوتين، الأجهزة
 * والجلسات، تعطيل الحساب، وحذفه نهائياً.
 *
 * - كل زر يعمل فعلياً عبر المنطق المختبَر في `accountEmailChange` و`accountMfa`
 *   و`accountSessions` و`accountLifecycle`، بلا نجاح قبل تأكيد الخادم.
 * - لا تُعرض رموز ولا عناوين IP ولا أخطاء SDK تقنية.
 * - الهاتف يبقى وسيلة دخول إضافية بلا SMS ولا OTP (إدارته في إعدادات الملف).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';

import {
  describeEmailChangeState,
  requestEmailChange,
  type EmailChangeOutcome,
} from '@/lib/accountEmailChange';
import {
  MFA_LOST_DEVICE_MESSAGE,
  confirmTotpEnrollment,
  disableTotp,
  readMfaStatus,
  startTotpEnrollment,
  type AssuranceLevel,
  type MfaFactor,
} from '@/lib/accountMfa';
import {
  ACCOUNT_SESSIONS_SINGLE_REVOKE_LIMITATION,
  loadAccountSessions,
  signOutOtherDevices,
  type AccountSessionView,
} from '@/lib/accountSessions';
import {
  ACCOUNT_DELETE_CONFIRM_WORD,
  deactivateAccount,
  deleteAccount,
} from '@/lib/accountLifecycle';
import { supabase } from '@/lib/supabase';

type Notice = { tone: 'ok' | 'error' | 'info'; message: string } | null;

export default function AccountSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [emailPending, setEmailPending] = useState<string | null>(null);

  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaLevel, setMfaLevel] = useState<AssuranceLevel>('unknown');
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [enrollment, setEnrollment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const [sessions, setSessions] = useState<AccountSessionView[]>([]);
  const [sessionsUnavailable, setSessionsUnavailable] = useState(false);

  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState<Notice>(null);

  const loadMfa = useCallback(async () => {
    const [levelResult, factorsResult, userResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
      supabase.auth.getUser(),
    ]);
    const current = levelResult.data?.currentLevel;
    setMfaLevel(current === 'aal2' ? 'aal2' : current === 'aal1' ? 'aal1' : 'unknown');
    const appMetadata = userResult.data?.user?.app_metadata as { mfa_enabled?: unknown } | undefined;
    setMfaEnabled(appMetadata?.mfa_enabled === true);
    const all = (factorsResult.data as { all?: unknown } | undefined)?.all;
    const list = Array.isArray(all) ? all : [];
    setMfaFactors(list.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const record = item as { id?: unknown; factor_type?: unknown; status?: unknown; friendly_name?: unknown; created_at?: unknown };
      if (typeof record.id !== 'string') return [];
      return [{
        id: record.id,
        factorType: typeof record.factor_type === 'string' ? record.factor_type : '',
        status: record.status === 'verified' ? 'verified' as const : 'unverified' as const,
        friendlyName: typeof record.friendly_name === 'string' ? record.friendly_name : 'تطبيق المصادقة',
        createdAt: typeof record.created_at === 'string' ? record.created_at : '',
      }];
    }));
  }, []);

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const result = await loadAccountSessions({
      listSessions: async () => await supabase.rpc('aani_account_sessions'),
      signOutOthers: () => supabase.auth.signOut({ scope: 'others' }),
      getCurrentSessionId: async () => null,
    });
    if (result.status === 'ok') {
      setSessions(result.sessions);
      setSessionsUnavailable(false);
    } else {
      setSessions([]);
      setSessionsUnavailable(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!active) return;
      setUserId(data.user?.id ?? '');
      setEmail(data.user?.email ?? '');
      await Promise.all([loadMfa(), loadSessions()]);
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [loadMfa, loadSessions]);

  const run = async (key: string, action: () => Promise<Notice>) => {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      setNotice(await action());
    } finally {
      setBusy('');
    }
  };

  const changeEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run('email', async () => {
      const outcome: EmailChangeOutcome = await requestEmailChange(email, emailDraft, {
        updateUser: payload => supabase.auth.updateUser(payload),
      });
      if (!outcome.ok) return { tone: 'error', message: outcome.message };
      setEmailPending(outcome.email);
      setEmailDraft('');
      return { tone: 'ok', message: outcome.message };
    });
  };

  const refreshServerMfaState = async (accessToken: string) => {
    const { data, error } = await supabase.functions.invoke('account-mfa', {
      body: { action: 'sync' },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (error) return { ok: false as const, message: 'تعذر تحديث حالة التحقق بخطوتين على الخادم.' };
    return { ok: true as const, mfaEnabled: Boolean((data as { mfaEnabled?: unknown })?.mfaEnabled) };
  };

  const beginEnrollment = () => {
    void run('mfa-enroll', async () => {
      const result = await startTotpEnrollment({
        enroll: options => supabase.auth.mfa.enroll(options),
        challenge: options => supabase.auth.mfa.challenge(options),
        verify: options => supabase.auth.mfa.verify(options),
        unenroll: options => supabase.auth.mfa.unenroll(options),
        setSession: tokens => supabase.auth.setSession(tokens),
        syncServerState: refreshServerMfaState,
      });
      if (!result.ok) return { tone: 'error', message: result.message };
      setEnrollment(result.enrollment);
      return { tone: 'info', message: 'امسح رمز QR بتطبيق المصادقة، ثم أدخل الرمز لتأكيد التفعيل.' };
    });
  };

  const confirmEnrollment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrollment) return;
    void run('mfa-confirm', async () => {
      const result = await confirmTotpEnrollment({
        enroll: options => supabase.auth.mfa.enroll(options),
        challenge: options => supabase.auth.mfa.challenge(options),
        verify: options => supabase.auth.mfa.verify(options),
        unenroll: options => supabase.auth.mfa.unenroll(options),
        setSession: tokens => supabase.auth.setSession(tokens),
        syncServerState: refreshServerMfaState,
      }, enrollment.factorId, enrollCode);
      if (!result.ok) return { tone: 'error', message: result.message };
      setEnrollment(null);
      setEnrollCode('');
      await loadMfa();
      return { tone: 'ok', message: 'تم تفعيل التحقق بخطوتين. ستحتاج الرمز عند كل دخول جديد.' };
    });
  };

  const disable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const factor = mfaFactors.find(item => item.factorType === 'totp' && item.status === 'verified');
    if (!factor) return;
    void run('mfa-disable', async () => {
      const result = await disableTotp({
        enroll: options => supabase.auth.mfa.enroll(options),
        challenge: options => supabase.auth.mfa.challenge(options),
        verify: options => supabase.auth.mfa.verify(options),
        unenroll: options => supabase.auth.mfa.unenroll(options),
        setSession: tokens => supabase.auth.setSession(tokens),
        syncServerState: refreshServerMfaState,
      }, factor.id, disableCode);
      if (!result.ok) return { tone: 'error', message: result.message };
      setDisableCode('');
      await loadMfa();
      return { tone: 'ok', message: 'تم تعطيل التحقق بخطوتين بعد إثبات الرمز.' };
    });
  };

  const signOutOthers = () => {
    void run('sessions', async () => {
      const { data } = await supabase.auth.getSession();
      const result = await signOutOtherDevices({
        listSessions: async () => await supabase.rpc('aani_account_sessions'),
        signOutOthers: () => supabase.auth.signOut({ scope: 'others' }),
        getCurrentSessionId: async () => null,
      });
      await loadSessions();
      return { tone: result.ok ? 'ok' : 'error', message: result.message };
    });
  };

  const deactivate = () => {
    void run('deactivate', async () => {
      const result = await deactivateAccount({
        deactivate: async () => await supabase.rpc('aani_deactivate_account'),
        signOutLocal: () => supabase.auth.signOut({ scope: 'local' }),
      });
      if (result.ok) window.location.assign('/login');
      return { tone: result.ok ? 'ok' : 'error', message: result.message };
    });
  };

  const removeAccount = () => {
    void run('delete', async () => {
      const result = await deleteAccount(deleteConfirmation, {
        deleteAccount: () => supabase.functions.invoke('delete-account', { body: { confirmation: 'delete' } }),
        signOutLocal: () => supabase.auth.signOut({ scope: 'local' }),
      });
      if (result.ok) window.location.assign('/login');
      return { tone: result.ok ? 'ok' : 'error', message: result.message };
    });
  };

  const status = readMfaStatus({ enabled: mfaEnabled, level: mfaLevel, factors: mfaFactors });
  const emailState = describeEmailChangeState({ currentEmail: email, pendingEmail: emailPending });
  const verifiedFactor = mfaFactors.find(item => item.factorType === 'totp' && item.status === 'verified');

  if (loading) {
    return <div style={styles.page}><p style={styles.note}>جارٍ تحميل إعدادات الحساب...</p></div>;
  }

  return (
    <div style={styles.page}>
      <main style={styles.card}>
        <h1 style={styles.title}>إعدادات الحساب</h1>
        {notice && (
          <div role={notice.tone === 'error' ? 'alert' : 'status'} style={notice.tone === 'error' ? styles.error : styles.ok}>
            {notice.message}
          </div>
        )}

        <section style={styles.section}>
          <h2 style={styles.heading}>البريد الإلكتروني</h2>
          <p style={styles.note}>البريد الحالي: <span dir="ltr">{emailState.currentEmail}</span></p>
          {emailState.hasPending && (
            <p style={styles.note}>طلب معلّق: <span dir="ltr">{emailState.pendingEmail}</span> — لم يتغيّر البريد بعد.</p>
          )}
          <form onSubmit={changeEmail} style={styles.form}>
            <input
              type="email"
              dir="ltr"
              required
              placeholder="البريد الجديد"
              value={emailDraft}
              onChange={event => setEmailDraft(event.target.value)}
              style={styles.input}
              disabled={busy === 'email'}
            />
            <button type="submit" style={styles.button} disabled={busy === 'email'}>
              {busy === 'email' ? 'جارٍ الإرسال...' : 'إرسال رابط التأكيد'}
            </button>
          </form>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>كلمة المرور</h2>
          <p style={styles.note}>
            تغيير كلمة المرور يبقى في مكان واحد: إعدادات الملف الشخصي، بالتحقق من
            كلمة المرور الحالية ثم التحديث. لا نُكرّر النموذج هنا لتفادي واجهتين
            متعارضتين، وقد بقي سلوكه كما هو.
          </p>
          <Link href="/profile" style={styles.button}>فتح إعدادات الملف الشخصي لتغيير كلمة المرور</Link>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>رقم الهاتف الإضافي</h2>
          <p style={styles.note}>يُدار من إعدادات الملف الشخصي: دخول بالرقم وكلمة المرور، بلا SMS وبلا OTP.</p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>التحقق بخطوتين</h2>
          <p style={styles.note}>
            الحالة: {status.enabled ? 'مفعّل' : 'غير مفعّل'} · العوامل المؤكدة: {status.verifiedCount} · المستوى: {mfaLevel}
          </p>
          {status.enabled && status.needsChallenge && (
            <p style={styles.note}>يلزم إكمال التحقق (aal2) لتعديل الإعدادات الحساسة.</p>
          )}

          {!verifiedFactor && !enrollment && (
            <button type="button" style={styles.button} onClick={beginEnrollment} disabled={busy === 'mfa-enroll'}>
              {busy === 'mfa-enroll' ? 'جارٍ التحضير...' : 'تفعيل التحقق بخطوتين'}
            </button>
          )}

          {enrollment && (
            <form onSubmit={confirmEnrollment} style={styles.form}>
              {enrollment.qrCode && <img src={enrollment.qrCode} alt="رمز QR لتطبيق المصادقة" style={styles.qr} />}
              <p style={styles.note}>السر: <span dir="ltr" style={styles.secret}>{enrollment.secret}</span></p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                dir="ltr"
                placeholder="الرمز المكوّن من 6 أرقام"
                value={enrollCode}
                onChange={event => setEnrollCode(event.target.value.replace(/\D/g, ''))}
                style={styles.input}
                disabled={busy === 'mfa-confirm'}
              />
              <button type="submit" style={styles.button} disabled={busy === 'mfa-confirm' || enrollCode.length !== 6}>
                {busy === 'mfa-confirm' ? 'جارٍ التحقق...' : 'تأكيد التفعيل'}
              </button>
            </form>
          )}

          {verifiedFactor && (
            <form onSubmit={disable} style={styles.form}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                dir="ltr"
                placeholder="الرمز الحالي لتعطيل العامل"
                value={disableCode}
                onChange={event => setDisableCode(event.target.value.replace(/\D/g, ''))}
                style={styles.input}
                disabled={busy === 'mfa-disable'}
              />
              <button type="submit" style={styles.danger} disabled={busy === 'mfa-disable' || disableCode.length !== 6}>
                {busy === 'mfa-disable' ? 'جارٍ التعطيل...' : 'تعطيل التحقق بخطوتين'}
              </button>
            </form>
          )}

          <p style={styles.note}>{MFA_LOST_DEVICE_MESSAGE}</p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>الأجهزة والجلسات</h2>
          {sessionsUnavailable && <p style={styles.error}>تعذر تحميل الجلسات الآن.</p>}
          <ul style={styles.list}>
            {sessions.map(session => (
              <li key={session.id} style={styles.listItem}>
                <span>{session.device}</span>
                {session.current && <span style={styles.badge}>الجلسة الحالية</span>}
                <span style={styles.muted}>آخر نشاط: {new Date(session.lastActiveAt).toLocaleString('ar')}</span>
              </li>
            ))}
          </ul>
          <button type="button" style={styles.button} onClick={signOutOthers} disabled={busy === 'sessions'}>
            {busy === 'sessions' ? 'جارٍ إنهاء الجلسات...' : 'تسجيل الخروج من جميع الأجهزة الأخرى'}
          </button>
          <p style={styles.note}>{ACCOUNT_SESSIONS_SINGLE_REVOKE_LIMITATION}</p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>تعطيل الحساب مؤقتاً</h2>
          <p style={styles.note}>يُنهي الجلسات الأخرى، ويُعاد التفعيل عند الدخول التالي بعد التحقق.</p>
          <button type="button" style={styles.danger} onClick={deactivate} disabled={busy === 'deactivate' || !userId}>
            {busy === 'deactivate' ? 'جارٍ التعطيل...' : 'تعطيل الحساب'}
          </button>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>حذف الحساب نهائياً</h2>
          <p style={styles.note}>اكتب «{ACCOUNT_DELETE_CONFIRM_WORD}» للتأكيد. الوسائط تدخل طابور الحذف بعد حذف الحساب.</p>
          <input
            type="text"
            value={deleteConfirmation}
            onChange={event => setDeleteConfirmation(event.target.value)}
            style={styles.input}
            disabled={busy === 'delete'}
          />
          <button
            type="button"
            style={styles.danger}
            onClick={removeAccount}
            disabled={busy === 'delete' || deleteConfirmation.trim() !== ACCOUNT_DELETE_CONFIRM_WORD}
          >
            {busy === 'delete' ? 'جارٍ الحذف...' : 'حذف نهائي'}
          </button>
        </section>
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100dvh', backgroundColor: '#1a2b27', direction: 'rtl' as const, padding: '24px 16px', fontFamily: "'Tajawal', sans-serif" },
  card: { maxWidth: '520px', margin: '0 auto', backgroundColor: '#f5f6f4', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column' as const, gap: '16px' },
  title: { fontSize: '22px', fontWeight: 800, color: '#243b35', margin: 0 },
  heading: { fontSize: '16px', fontWeight: 700, color: '#243b35', margin: '0 0 8px' },
  section: { borderTop: '1px solid #d8dfdb', paddingTop: '14px' },
  note: { fontSize: '13px', lineHeight: 1.8, color: '#3c4f48', margin: '4px 0' },
  muted: { fontSize: '12px', color: '#65716c' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: '8px', marginTop: '8px' },
  input: { width: '100%', padding: '12px', border: '1px solid #d8dfdb', borderRadius: '10px', backgroundColor: '#ffffff', fontSize: '14px', color: '#243b35', boxSizing: 'border-box' as const },
  button: { padding: '12px', border: 'none', borderRadius: '10px', backgroundColor: '#243b35', color: '#ffffff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' },
  danger: { padding: '12px', border: '1px solid #e2b3a0', borderRadius: '10px', backgroundColor: '#fff5eb', color: '#8c3b22', fontSize: '14px', fontWeight: 700, cursor: 'pointer' },
  ok: { padding: '10px 12px', border: '1px solid #b7d4be', borderRadius: '8px', backgroundColor: '#edf7ef', color: '#28553a', fontSize: '13px', lineHeight: 1.7 },
  error: { padding: '10px 12px', border: '1px solid #e8c5a5', borderRadius: '8px', backgroundColor: '#fff5eb', color: '#74442e', fontSize: '13px', lineHeight: 1.7 },
  list: { listStyle: 'none', padding: 0, margin: '8px 0', display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  listItem: { display: 'flex', flexDirection: 'column' as const, gap: '2px', border: '1px solid #d8dfdb', borderRadius: '10px', padding: '10px', backgroundColor: '#ffffff', fontSize: '13px', color: '#243b35' },
  badge: { fontSize: '11px', fontWeight: 700, color: '#28553a' },
  qr: { width: '180px', height: '180px', margin: '0 auto', display: 'block', backgroundColor: '#ffffff', padding: '8px', borderRadius: '10px' },
  secret: { fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all' as const },
};
