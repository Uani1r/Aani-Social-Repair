// نافذة تنبيه تشخيص الوسائط — مكوّن مستقل تماماً: يُستمع لأحداث
// mediaDiagnostics فقط، ولا يلمس أي منطق نشر أو ضغط أو تنظيف.
// يظهر تلقائياً عند فشل أي نداء وسائط مُرصود (HTTP ≥ 400 أو فشل شبكة).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  buildMediaDiagnosticReport,
  copyTextToClipboard,
  describeHttpStatusLabel,
  MEDIA_DIAGNOSTICS_BUILD_STAMP,
  subscribeMediaDiagnostics,
  type MediaDiagnosticEvent,
} from '@/lib/mediaDiagnostics';

const ALERT_HIDE_AFTER_MS = 90 * 1000;

const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 'max(12px, env(safe-area-inset-top))',
    left: 12,
    right: 12,
    zIndex: 2147483000,
    background: '#101014',
    color: '#f5f5f5',
    border: '1px solid rgba(244,63,94,0.45)',
    borderRadius: 14,
    padding: 12,
    boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
    fontFamily: 'inherit',
    maxWidth: 520,
    marginInline: 'auto',
  },
  headerRow: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  title: {
    fontWeight: 700,
    fontSize: 14,
  },
  statusChip: {
    background: 'rgba(244,63,94,0.16)',
    color: '#fb7185',
    borderRadius: 999,
    padding: '2px 10px',
    fontSize: 12,
    fontWeight: 700,
    direction: 'ltr' as const,
  },
  stage: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: 600,
  },
  endpoint: {
    marginTop: 2,
    fontSize: 11,
    color: '#9ca3af',
    direction: 'ltr' as const,
    wordBreak: 'break-all' as const,
  },
  stamp: {
    marginTop: 2,
    fontSize: 10,
    color: '#6b7280',
    direction: 'ltr' as const,
    textAlign: 'left' as const,
  },
  raw: {
    margin: '8px 0',
    padding: 8,
    background: '#000',
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 1.5,
    maxHeight: 150,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    direction: 'ltr' as const,
    textAlign: 'left' as const,
  },
  buttonRow: {
    display: 'flex' as const,
    gap: 8,
    marginTop: 4,
  },
  copyButton: {
    flex: 1,
    border: 'none',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 13,
    fontWeight: 700,
    background: '#22c55e',
    color: '#04140a',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  closeButton: {
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 10,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    background: 'transparent',
    color: '#f5f5f5',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};

export default function MediaDiagnosticAlert() {
  const [event, setEvent] = useState<MediaDiagnosticEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      return subscribeMediaDiagnostics(next => {
        setEvent(next);
        setCopied(false);
        if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
          setEvent(null);
          hideTimerRef.current = null;
        }, ALERT_HIDE_AFTER_MS);
      });
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  }, []);

  if (!event) return null;

  const handleCopy = () => {
    void copyTextToClipboard(buildMediaDiagnosticReport(event)).then(success => {
      setCopied(success);
      if (success) {
        window.setTimeout(() => setCopied(false), 2500);
      }
    });
  };

  // Portal إلى document.body: تنبيه مستقل عن شجرة App — يظهر فوق محرر القصة
  // (الذي يُعرض عبر createPortal بطبقته الخاصة) ولا يخفيه إغلاق المحرر أو
  // إعادة فتحه. z-index أعلى من أقصى طبقات المحرر (z-[130]).
  return createPortal(
    <div style={styles.overlay} role="alert">
      <div style={styles.headerRow}>
        <span style={styles.title}>تشخيص الوسائط</span>
        <span style={styles.statusChip}>
          {describeHttpStatusLabel(event)}
        </span>
      </div>
      <div style={styles.stage}>المرحلة: [{event.stage}]</div>
      <div style={styles.endpoint}>{event.method} {event.endpoint}</div>
      <div style={styles.stamp}>ختم البناء: {MEDIA_DIAGNOSTICS_BUILD_STAMP} — إن كان قديماً فالمتصفح يخدّم حزمة سابقة</div>
      {event.rawResponse ? <pre style={styles.raw}>{event.rawResponse}</pre> : null}
      {event.networkError ? <pre style={styles.raw}>{event.networkError}</pre> : null}
      <div style={styles.buttonRow}>
        <button type="button" style={styles.copyButton} onClick={handleCopy}>
          {copied ? 'تم نسخ التفاصيل ✓' : 'نسخ تفاصيل الخطأ'}
        </button>
        <button type="button" style={styles.closeButton} onClick={() => setEvent(null)}>
          إغلاق
        </button>
      </div>
    </div>,
    document.body,
  );
}
