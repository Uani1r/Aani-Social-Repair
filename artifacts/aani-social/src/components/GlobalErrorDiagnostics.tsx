// لوحة تشخيص الأخطاء الشاملة — مستقلة تماماً وتُعرض عبر createPortal
// فوق كل الطبقات. زر عائم دائم «لوحة التشخيص» يفتحها من أي شاشة، وتُفتح
// تلقائياً عند الضغط على «تشخيص الخطأ» بجانب أي رسالة خطأ حمراء.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, Copy, RefreshCw, X } from 'lucide-react';

import {
  buildFullErrorReport,
  clearGlobalErrors,
  closeGlobalErrorPanel,
  getGlobalErrorServerVersion,
  getGlobalErrors,
  setGlobalErrorServerVersion,
  subscribeGlobalErrors,
  subscribePanelOpen,
  type GlobalErrorEntry,
} from '@/lib/globalErrorStore';
// استيراد namespace آمن: تُقرأ دوال تشخيص الوسائط (checkMediaServers وغيرها)
// من وحدتها الصحيحة mediaDiagnostics — لا من globalErrorStore — مع فحص
// وجودها قبل النداء كي لا يُعطّل فشل التشخيص إقلاع التطبيق إطلاقاً.
import * as mediaDiagnostics from '@/lib/mediaDiagnostics';

const styles = {
  fab: {
    position: 'fixed' as const,
    bottom: 'calc(env(safe-area-inset-bottom) + 78px)',
    insetInlineStart: 10,
    zIndex: 2147483646,
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 5,
    border: '1px solid rgba(255,255,255,0.22)',
    borderRadius: 999,
    padding: '7px 13px',
    background: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    backdropFilter: 'blur(6px)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 2147483647,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex' as const,
    alignItems: 'flex-start' as const,
    justifyContent: 'center' as const,
    padding: 'max(12px, env(safe-area-inset-top)) 12px 12px',
  },
  panel: {
    background: '#0c0c10',
    color: '#f5f5f5',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 14,
    width: '100%',
    maxWidth: 580,
    maxHeight: '88vh',
    display: 'flex' as const,
    flexDirection: 'column' as const,
    padding: 14,
    boxShadow: '0 20px 48px rgba(0,0,0,0.6)',
    fontFamily: 'inherit',
  },
  headerRow: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    gap: 8,
    marginBottom: 10,
  },
  title: { fontWeight: 800, fontSize: 15 },
  meta: {
    background: '#000',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.7,
    direction: 'ltr' as const,
    textAlign: 'left' as const,
    wordBreak: 'break-all' as const,
  },
  list: {
    flex: 1,
    minHeight: 120,
    overflowY: 'auto' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 8,
    margin: '10px 0',
  },
  card: {
    background: '#16161c',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 10,
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.6,
  },
  codeChip: {
    display: 'inline-block' as const,
    background: 'rgba(244,63,94,0.15)',
    color: '#fb7185',
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 700,
    direction: 'ltr' as const,
  },
  target: { color: '#9ca3af', direction: 'ltr' as const, textAlign: 'left' as const, wordBreak: 'break-all' as const },
  raw: {
    background: '#000',
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
    maxHeight: 130,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    direction: 'ltr' as const,
    textAlign: 'left' as const,
    marginTop: 4,
  },
  buttonRow: {
    display: 'flex' as const,
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  primaryButton: {
    flex: '1 1 160px',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    border: 'none',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 13,
    fontWeight: 800,
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  copyButton: {
    flex: '1 1 200px',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    border: 'none',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 13,
    fontWeight: 800,
    background: '#22c55e',
    color: '#04140a',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  closeButton: {
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 10,
    padding: '8px 10px',
    background: 'transparent',
    color: '#f5f5f5',
    cursor: 'pointer',
    display: 'flex' as const,
    alignItems: 'center' as const,
    fontFamily: 'inherit',
  },
  empty: { color: '#9ca3af', fontSize: 13, padding: '14px 2px' },
};

export default function GlobalErrorDiagnostics() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<GlobalErrorEntry[]>([]);
  const [serverCheck, setServerCheck] = useState<{ text: string; ok: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const unsubscribeErrors = subscribeGlobalErrors(() => {
        setEntries([...getGlobalErrors()]);
      });
      const unsubscribePanel = subscribePanelOpen(isOpen => setOpen(isOpen));
      setEntries([...getGlobalErrors()]);
      return () => {
        unsubscribeErrors();
        unsubscribePanel();
      };
    } catch {
      return undefined;
    }
  }, []);

  const handleCheckServer = () => {
    setChecking(true);
    if (typeof mediaDiagnostics.checkMediaServers !== 'function') {
      setChecking(false);
      setServerCheck({ text: 'وحدة تشخيص الوسائط غير متوفرة في هذه النسخة — لا يؤثر ذلك على التطبيق.', ok: false });
      return;
    }
    void mediaDiagnostics.checkMediaServers()
      .then(result => {
        const version = result.uploadCheck?.serverBuildVersion || null;
        setGlobalErrorServerVersion(version);
        const text = version
          ? `الخادم حيّ (HTTP ${result.uploadCheck?.status}) — الإصدار: ${version}${result.authCheck ? ` — نقطة التوقيع: HTTP ${result.authCheck.status}` : ''}`
          : `الخادم غير مستجيب (رفع=HTTP ${result.uploadCheck?.status ?? '؟'}، توقيع=HTTP ${result.authCheck?.status ?? '؟'}) — انتظر انتهاء إقلاع الخادم ثم أعد الفحص`;
        setServerCheck({ text, ok: Boolean(version) });
      })
      .catch(() => setServerCheck({ text: 'فشل الفحص الحي.', ok: false }))
      .finally(() => setChecking(false));
  };

  const handleCopy = () => {
    const copy = typeof mediaDiagnostics.copyTextToClipboard === 'function'
      ? mediaDiagnostics.copyTextToClipboard
      : null;
    if (!copy) return;
    void copy(buildFullErrorReport()).then(success => {
      setCopied(success);
      if (success) window.setTimeout(() => setCopied(false), 3000);
    });
  };

  // لوحة التشخيص للتطوير فقط — لا زر عائم ولا نافذة للمستخدم النهائي في الإنتاج.
  // يبقى تخزين الأخطاء وتسجيلها في Console كما هو.
  if (!import.meta.env.DEV) return null;

  if (!open) {
    return createPortal(
      <button type="button" style={styles.fab} onClick={() => { setOpen(true); setEntries([...getGlobalErrors()]); }} aria-label="لوحة التشخيص">
        <Bug size={14} />
        لوحة التشخيص
      </button>,
      document.body,
    );
  }

  return createPortal(
    <div style={styles.overlay}>
      <div style={styles.panel} dir="rtl">
        <div style={styles.headerRow}>
          <span style={styles.title}>لوحة تشخيص الأخطاء الشاملة</span>
          <button
            type="button"
            style={styles.closeButton}
            aria-label="إغلاق"
            onClick={() => { setOpen(false); closeGlobalErrorPanel(); }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={styles.meta}>
          <div>client (واجهة): {mediaDiagnostics.MEDIA_DIAGNOSTICS_BUILD_STAMP}</div>
          <div>server (خادم): {getGlobalErrorServerVersion() || 'غير معروف — اضغط فحص الخادم الآن'}</div>
          <div style={{ color: '#9ca3af' }}>آخر {getGlobalErrors().length || 0} خطأ مسجل من كل الشاشات</div>
        </div>

        {serverCheck ? (
          <div style={{ ...styles.card, marginTop: 8, color: serverCheck.ok ? '#4ade80' : '#f87171' }}>
            {serverCheck.text}
          </div>
        ) : null}

        <div style={styles.list}>
          {entries.length === 0 ? (
            <p style={styles.empty}>لا توجد أخطاء مسجلة بعد. عند حدوث أي فشل في أي شاشة سيظهر هنا تلقائياً.</p>
          ) : (
            entries.map(entry => (
              <div key={entry.id} style={styles.card}>
                <div><span style={styles.codeChip}>{entry.code}</span> <strong>{entry.screen}</strong></div>
                <div style={styles.target}>{entry.target}</div>
                <div style={styles.raw}>{entry.message}{entry.details ? `\nالتفاصيل: ${entry.details}` : ''}{entry.hint ? `\nالتلميح: ${entry.hint}` : ''}</div>
                <div style={{ color: '#6b7280', marginTop: 3 }}>{new Date(entry.at).toLocaleString('ar')}</div>
              </div>
            ))
          )}
        </div>

        <div style={styles.buttonRow}>
          <button type="button" style={styles.primaryButton} onClick={handleCheckServer} disabled={checking}>
            <RefreshCw size={15} />
            {checking ? 'جارٍ الفحص…' : 'فحص الخادم الآن'}
          </button>
          <button type="button" style={styles.copyButton} onClick={handleCopy}>
            <Copy size={15} />
            {copied ? 'تم النسخ ✓' : 'نسخ التقرير الكامل'}
          </button>
        </div>

        {entries.length > 0 ? (
          <button
            type="button"
            style={{ ...styles.closeButton, marginTop: 8, justifyContent: 'center' }}
            onClick={() => { clearGlobalErrors(); setEntries([]); }}
          >
            تفريغ السجل
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
