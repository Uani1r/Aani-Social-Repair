// لوحة تشخيص فشل النشر — تظهر في الإنتاج أيضاً (لا شرط import.meta.env.DEV).
//
// تُفتح من زر «التفاصيل» داخل تنبيه الخطأ، أو تلقائياً من زر عائم بعد أول فشل.
// تعرض لكل محاولة: المرحلة، تصنيف الفشل (رفع ImageKit أم كتابة Supabase)،
// code / message / details / hint، ورسالة الواجهة. وفيها زر نسخ للتقرير كاملاً.
//
// كل نص يمر عبر redactSecrets: لا access token ولا private key ولا signature
// ولا بيانات جلسة تخرج من هذه اللوحة.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, ClipboardCopy, X } from 'lucide-react';

import {
  buildPublishFailureReport,
  clearPublishFailures,
  closePublishErrorPanel,
  describePublishKind,
  getPublishFailures,
  openPublishErrorPanel,
  subscribePublishFailures,
  subscribePublishPanelOpen,
  type PublishFailureEntry,
} from '@/lib/publishDiagnostics';
import { copyTextToClipboard } from '@/lib/mediaDiagnostics';

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 2147483100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.78)',
    padding: 12,
  },
  panel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '88dvh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    borderRadius: 18,
    border: '1px solid rgba(244,63,94,0.35)',
    background: '#0d0f13',
    color: '#f4f4f5',
    fontSize: 12,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto' as const, padding: 14 },
  row: {
    padding: 10,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.09)',
    background: 'rgba(255,255,255,0.03)',
    marginBottom: 10,
  },
  field: { marginTop: 6, lineHeight: 1.65 },
  label: { color: '#a1a1aa' },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    fontSize: 10,
    wordBreak: 'break-word' as const,
    color: '#e4e4e7',
  },
  action: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '7px 11px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.06)',
    color: '#f4f4f5',
    fontSize: 11,
    fontWeight: 700,
  },
};

function kindColor(kind: PublishFailureEntry['kind']): string {
  if (kind === 'imagekit-upload') return '#7dd3fc';
  if (kind === 'supabase-write') return '#fbbf24';
  return '#a1a1aa';
}

function Field({ name, value, mono = false }: { name: string; value: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div style={styles.field}>
      <span style={styles.label}>{name}: </span>
      <span style={mono ? styles.mono : undefined}>{value}</span>
    </div>
  );
}

export default function PublishErrorPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PublishFailureEntry[]>(getPublishFailures);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubscribeEntries = subscribePublishFailures(setEntries);
    const unsubscribePanel = subscribePublishPanelOpen(setOpen);
    return () => {
      unsubscribeEntries();
      unsubscribePanel();
    };
  }, []);

  if (!open) return null;

  const handleCopy = () => {
    void copyTextToClipboard(buildPublishFailureReport(entries)).then(success => {
      setCopied(success);
      if (success) window.setTimeout(() => setCopied(false), 2500);
    });
  };

  return createPortal(
    <div style={styles.overlay} onClick={() => closePublishErrorPanel()}>
      <section dir="rtl" role="dialog" aria-modal="true" aria-label="تفاصيل فشل النشر" style={styles.panel} onClick={event => event.stopPropagation()}>
        <header style={styles.header}>
          <AlertCircle size={16} style={{ color: '#fb7185' }} />
          <strong style={{ flex: 1, fontSize: 13 }}>تفاصيل فشل النشر</strong>
          <button type="button" aria-label="إغلاق" onClick={() => closePublishErrorPanel()} style={{ ...styles.action, border: 'none', background: 'transparent', color: '#a1a1aa' }}>
            <X size={16} />
          </button>
        </header>

        <div style={styles.body}>
          <p style={{ margin: 0, color: '#a1a1aa', lineHeight: 1.7 }}>
            آخر محاولات النشر الفاشلة في هذه الجلسة. التفاصيل هنا للحجب الآمن: لا رموز جلسة ولا مفاتيح ولا توقيعات.
          </p>

          <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
            <button type="button" onClick={handleCopy} style={styles.action}>
              {copied ? <CheckCircle2 size={13} style={{ color: '#4ade80' }} /> : <ClipboardCopy size={13} />}
              {copied ? 'نُسخ' : 'نسخ التقرير'}
            </button>
            <button
              type="button"
              onClick={() => clearPublishFailures()}
              style={{ ...styles.action, color: '#a1a1aa' }}
            >
              مسح السجل
            </button>
          </div>

          {entries.length === 0 && (
            <p style={{ color: '#71717a', lineHeight: 1.7 }}>لا يوجد فشل نشر مسجل في هذه الجلسة.</p>
          )}

          {entries.map(entry => (
            <div key={entry.id} style={styles.row}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ flex: 1, minWidth: 0 }}>{entry.phase}</strong>
                <span
                  style={{
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: `1px solid ${kindColor(entry.kind)}55`,
                    color: kindColor(entry.kind),
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {entry.kind === 'imagekit-upload' ? 'ImageKit' : entry.kind === 'supabase-write' ? 'Supabase' : 'قبل الرفع/الحفظ'}
                </span>
              </div>
              <div style={{ marginTop: 4, color: '#a1a1aa', lineHeight: 1.6 }}>{describePublishKind(entry.kind)}</div>
              <div style={{ marginTop: 2, color: '#71717a', fontSize: 10 }}>
                {new Date(entry.at).toLocaleString('ar')} · التوقيع {entry.signingEnabled ? 'مفعّل' : 'غير مفعّل'}
                {entry.timedOut ? ' · انتهت المهلة' : ''}
              </div>
              <Field name="code" value={entry.code} mono />
              <Field name="message" value={entry.message} />
              <Field name="details" value={entry.details} />
              <Field name="hint" value={entry.hint} />
              <Field name="رسالة الواجهة" value={entry.userMessage} />
            </div>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** زر عائم صغير يظهر بعد أول فشل نشر — يفتح اللوحة من أي شاشة. */
export function PublishErrorBadge() {
  const [count, setCount] = useState(() => getPublishFailures().length);

  useEffect(() => subscribePublishFailures(next => setCount(next.length)), []);

  if (count === 0) return null;

  return createPortal(
    <button
      type="button"
      onClick={() => openPublishErrorPanel()}
      aria-label="تفاصيل فشل النشر"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 'calc(5.5rem + env(safe-area-inset-bottom))',
        zIndex: 2147482000,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        borderRadius: 999,
        border: '1px solid rgba(244,63,94,0.45)',
        background: 'rgba(18,10,12,0.94)',
        color: '#fb7185',
        fontSize: 11,
        fontWeight: 700,
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
      }}
    >
      <AlertCircle size={13} />
      تفاصيل فشل النشر ({count})
    </button>,
    document.body,
  );
}
