// لوحة تشخيص فشل نشر القصص — وحدة مستقلة تماماً (Standalone).
//
// المبادئ:
// - تُعرض عبر createPortal إلى document.body فوق جميع الطبقات (z 2147483647)
//   فتظهر داخل محرر القصة أي شكل كان، ولا تختفي تلقائياً.
// - أيقونة صغيرة "تشخيص" ثابتة أعلى الشاشة تفتح اللوحة يدوياً متى احتجت.
// - "فحص الخادم الآن": طلب حي إلى /api/media/upload و /api/media/imagekit-auth
//   يعرض حالة الخادم وإصداره الفعلي على الشاشة فوراً — يكشف عملية قديمة عالقة.
// - "نسخ تفاصيل الخطأ بالكامل": نسخ التقرير الكامل إلى الحافظة بتأكيد بصري.
// - لا يُطبع أو يُنسخ أي مفتاح سري أو توقيع كامل أو بيانات جلسة.
// - فشل أي شيء في هذه اللوحة لا يؤثر على النشر إطلاقاً (try/catch شامل).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, RefreshCw, X } from 'lucide-react';

// استيراد آمن: if (typeof x === 'function') قبل كل استدعاء — كاش المتصفح
// القديم قد يحمل نسخة من الوحدة بلا دالة جديدة، والخطأ هنا يُسقط الإقلاع كله
import * as mediaDiagnostics from '@/lib/mediaDiagnostics';

const styles = {
  fab: {
    position: 'fixed' as const,
    top: 'calc(max(8px, env(safe-area-inset-top)) + 8px)',
    insetInlineStart: 10,
    zIndex: 2147483647,
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 5,
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 999,
    padding: '6px 12px',
    background: 'rgba(0,0,0,0.55)',
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
    background: 'rgba(0,0,0,0.55)',
    display: 'flex' as const,
    alignItems: 'flex-start' as const,
    justifyContent: 'center' as const,
    padding: 'max(12px, env(safe-area-inset-top)) 12px 12px',
  },
  panel: {
    background: '#101014',
    color: '#f5f5f5',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 14,
    width: '100%',
    maxWidth: 560,
    maxHeight: '88vh',
    overflowY: 'auto' as const,
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
  title: {
    fontWeight: 800,
    fontSize: 15,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 800,
    margin: '12px 0 6px',
    color: '#93c5fd',
  },
  versionBox: {
    background: '#000',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.7,
    direction: 'ltr' as const,
    textAlign: 'left' as const,
    wordBreak: 'break-all' as const,
  },
  monoBox: {
    background: '#000',
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
    lineHeight: 1.5,
    maxHeight: 170,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    direction: 'ltr' as const,
    textAlign: 'left' as const,
  },
  buttonRow: {
    display: 'flex' as const,
    gap: 8,
    marginTop: 12,
    flexWrap: 'wrap' as const,
  },
  primaryButton: {
    flex: '1 1 180px',
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
    flex: '1 1 180px',
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
  verdict: {
    marginTop: 10,
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.6,
  },
};

const SERVER_OK_COLOR = '#14532d';
const SERVER_STALE_COLOR = '#7f1d1d';

function describeServerCheck(check: ServerCheckResult | null): { text: string; color: string } | null {
  if (!check) return null;
  if (check.error) return { text: `فحص الخادم فشل: ${check.error}`, color: SERVER_STALE_COLOR };
  const upload = check.uploadCheck;
  const auth = check.authCheck;
  if (upload?.ok && upload.serverBuildVersion) {
    return {
      text: `الخادم حيّ ويحتوي المسارات الجديدة (HTTP ${upload.status}) — إصدار الخادم: ${upload.serverBuildVersion}${getLastKnownServerBuildVersion() === upload.serverBuildVersion ? '' : ' (لاحظ: هذا الإصدار من الاستجابة الحية)'}`,
      color: SERVER_OK_COLOR,
    };
  }
  if (auth?.provesRouteExists) {
    return { text: `نقطة التوقيع حيّة (HTTP 401 يطالب بالمصادقة) لكن نقطة الرفع الاحتياطي أعادت HTTP ${upload?.status ?? '?'} — الخادم يعمل ببناء قديم، أعد التشغيل/النشر.`, color: SERVER_STALE_COLOR };
  }
  if (upload && upload.status === 404) {
    return { text: `HTTP 404 من نقطة الرفع الاحتياطي — الخادم يعمل ببناء قديم عالق لا يحتوي المسار. أعد التشغيل (Run) ثم أعد الفحص.`, color: SERVER_STALE_COLOR };
  }
  if (upload && upload.status >= 500 && upload.status <= 599) {
    return { text: `HTTP ${upload.status} من نقطة الرفع الاحتياطي — الخادم غير مستجيب حالياً؛ غالباً إعادة التشغيل ما زالت تجري (pnpm install + build) أو العملية توقفت. انتظر دقيقة واضغط "فحص الخادم الآن" مجدداً.`, color: SERVER_STALE_COLOR };
  }
  if (upload && upload.status === 0) {
    return { text: 'لا استجابة من الخادم على 8080 — عملية الخادم متوقفة. شغّل التطبيق (Run) ثم أعد الفحص.', color: SERVER_STALE_COLOR };
  }
  return { text: `حالة غير معروفة: رفع=${upload ? `HTTP ${upload.status}` : '—'} توقيع=${auth ? `HTTP ${auth.status}` : '—'}`, color: SERVER_STALE_COLOR };
}

export default function StoryErrorDiagnosticPanel() {
  const [open, setOpen] = useState(false);
  const [latestFailure, setLatestFailure] = useState<MediaDiagnosticEvent | null>(null);
  const [serverCheck, setServerCheck] = useState<ServerCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [serverVersionLive, setServerVersionLive] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      // اشتراك دائم: آخر فشل يبقى في اللوحة حتى لو أُغلق المحرر أو أعيد فتحه
      if (typeof mediaDiagnostics.subscribeMediaDiagnostics !== 'function') return undefined;
      return mediaDiagnostics.subscribeMediaDiagnostics(event => {
        if (!event.ok) setLatestFailure(event);
      });
    } catch {
      return undefined;
    }
  }, []);

  const handleCheck = () => {
    setChecking(true);
    if (typeof mediaDiagnostics.checkMediaServers !== 'function') {
      setChecking(false);
      return;
    }
    void mediaDiagnostics.checkMediaServers()
      .then(result => {
        setServerCheck(result);
        const live = result.uploadCheck?.serverBuildVersion || null;
        setServerVersionLive(live);
      })
      .catch(() => setServerCheck(null))
      .finally(() => setChecking(false));
  };

  const handleCopy = () => {
    const events = typeof mediaDiagnostics.getMediaDiagnosticEvents === 'function'
      ? mediaDiagnostics.getMediaDiagnosticEvents()
      : [];
    const lastFailure = [...events].reverse().find(event => !event.ok) || null;
    const parts: string[] = [];
    parts.push('تقرير تشخيص نشر القصص — كامل');
    parts.push(`ختم الواجهة: ${mediaDiagnostics.MEDIA_DIAGNOSTICS_BUILD_STAMP}`);
    parts.push(`إصدار الخادم (آخر مُلاحَظ): ${mediaDiagnostics.getLastKnownServerBuildVersion?.() || 'غير معروف'}`);
    if (serverVersionLive) parts.push(`إصدار الخادم (من الفحص الحي): ${serverVersionLive}`);
    if (serverCheck) {
      parts.push(`فحص حي: ${describeServerCheck(serverCheck)?.text || ''}`);
      if (serverCheck.uploadCheck) {
        parts.push(`  نقطة الرفع الاحتياطي: HTTP ${serverCheck.uploadCheck.status} → ${serverCheck.uploadCheck.bodyPreview}`);
      }
      if (serverCheck.authCheck) {
        parts.push(`  نقطة التوقيع: HTTP ${serverCheck.authCheck.status} → ${serverCheck.authCheck.bodyPreview}`);
      }
    }
    const target = lastFailure || latestFailure;
    if (target) {
      parts.push('--- آخر فشل ---');
      parts.push(mediaDiagnostics.buildMediaDiagnosticReport(target));
    } else {
      parts.push('لا يوجد حدث فشل مسجل بعد.');
    }
    void mediaDiagnostics.copyTextToClipboard(parts.join('\n')).then(success => {
      setCopied(success);
      if (success) window.setTimeout(() => setCopied(false), 3000);
    });
  };

  // أدوات التشخيص للتطوير فقط — لا زر عائم ولا لوحة للمستخدم النهائي في الإنتاج.
  // يبقى تسجيل الأخطاء الداخلية (Console/mediaDiagnostics) كما هو.
  if (!import.meta.env.DEV) return null;

  if (!open) {
    return createPortal(
      <button type="button" style={styles.fab} onClick={() => setOpen(true)} aria-label="تشخيص">
        <Activity size={14} />
        تشخيص
      </button>,
      document.body,
    );
  }

  const verdict = describeServerCheck(serverCheck);

  return createPortal(
    <div style={styles.overlay} onClick={event => { if (event.target === event.currentTarget) return; }}>
      <div style={styles.panel} dir="rtl">
        <div style={styles.headerRow}>
          <span style={styles.title}>لوحة تشخيص نشر القصص</span>
          <button type="button" style={styles.closeButton} onClick={() => setOpen(false)} aria-label="إغلاق">
            <X size={16} />
          </button>
        </div>

        <div style={styles.sectionTitle}>الإصدارات — Story Diagnostics / Versions</div>
        <div style={styles.versionBox}>
          <div>client (واجهة): {mediaDiagnostics.MEDIA_DIAGNOSTICS_BUILD_STAMP}</div>
          <div>server (خادم، آخر مُلاحَظ): {mediaDiagnostics.getLastKnownServerBuildVersion?.() || 'غير معروف'}</div>
          {serverVersionLive ? <div>server (فحص حي): {serverVersionLive}</div> : null}
          <div style={{ color: '#9ca3af' }}>إذا اختلفت نسختا الواجهة والخادم فالعملية القديمة لا تزال تعمل</div>
        </div>

        <div style={styles.sectionTitle}>آخر فشل — Last Failure</div>
        {latestFailure ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={styles.versionBox}>
              <div>المرحلة: [{latestFailure.stage}]</div>
              <div>HTTP: {mediaDiagnostics.describeHttpStatusLabel?.(latestFailure) ?? '؟'}</div>
              <div>{latestFailure.method} {latestFailure.endpoint}</div>
            </div>
            {latestFailure.rawResponse ? <pre style={styles.monoBox}>{latestFailure.rawResponse}</pre> : null}
            {latestFailure.networkError ? <pre style={styles.monoBox}>{latestFailure.networkError}</pre> : null}
          </div>
        ) : (
          <div style={styles.versionBox}>لا يوجد فشل مسجل في هذه الجلسة بعد.</div>
        )}

        {verdict ? (
          <div style={{ ...styles.verdict, background: verdict.color, color: '#fff' }}>{verdict.text}</div>
        ) : null}

        <div style={styles.buttonRow}>
          <button type="button" style={styles.primaryButton} onClick={handleCheck} disabled={checking}>
            <RefreshCw size={15} />
            {checking ? 'جارٍ الفحص…' : 'فحص الخادم الآن'}
          </button>
          <button type="button" style={styles.copyButton} onClick={handleCopy}>
            {copied ? 'تم النسخ ✓' : 'نسخ تفاصيل الخطأ بالكامل'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
