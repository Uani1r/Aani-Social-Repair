// لوحة تشخيص مؤقتة لاختبار توقيع ImageKit قبل تفعيل التوقيع الإلزامي.
//
// تُعرض فقط لمستخدم مسجّل: App.tsx يركّبها داخل فرع `user ?` وحده، وتستخدم
// جلسة Supabase نفسها التي يستخدمها التطبيق.
//
// للحذف بعد الاختبار: احذف هذا الملف وsrc/lib/imagekitSignCheck.ts، وأزل
// سطر الاستيراد والعنصر من App.tsx. التفاصيل في docs/IMAGEKIT_SIGN_TEST_AR.md.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Bug, CheckCircle2, Loader2, X } from 'lucide-react';

import {
  collectOwnImageKitCandidates,
  runImageKitSignCheck,
  toCandidateFromInput,
  type ImageKitSignCandidate,
  type ImageKitSignCheckResult,
  type ImageKitSignStep,
} from '@/lib/imagekitSignCheck';
import { isImageKitSigningEnabled } from '@/lib/mediaAccess';

type Row = {
  candidate: ImageKitSignCandidate;
  running: boolean;
  result: ImageKitSignCheckResult | null;
};

function stepColor(step: ImageKitSignStep): string {
  if (step.state === 'ok') return '#4ade80';
  if (step.state === 'failed') return '#fb7185';
  return '#fbbf24';
}

function StepLine({ label, step }: { label: string; step: ImageKitSignStep }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4 }}>
      <span style={{ color: stepColor(step), flexShrink: 0 }}>
        {step.state === 'ok' ? <CheckCircle2 size={13} /> : step.state === 'failed' ? <AlertCircle size={13} /> : '•'}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: '#d4d4d8', lineHeight: 1.6 }}>
        <span style={{ color: '#a1a1aa' }}>{label}: </span>
        {step.message}
      </span>
    </div>
  );
}

export default function ImageKitSignDiagnostics({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [collected, setCollected] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [manualError, setManualError] = useState('');

  const updateRow = (index: number, patch: Partial<Row>) => {
    setRows(previous => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  const testRow = async (index: number) => {
    const row = rows[index];
    if (!row || row.running) return;
    updateRow(index, { running: true, result: null });
    const result = await runImageKitSignCheck(row.candidate);
    updateRow(index, { running: false, result });
  };

  const testAll = async () => {
    for (let index = 0; index < rows.length; index += 1) {
      // تسلسل متعمد: كل طلب توقيع يستهلك جلسة/حدّاً على الخادم، ولا فائدة من
      // إغراقه بستة طلبات متوازية في اختبار يدوي.
      // eslint-disable-next-line no-await-in-loop
      await testRow(index);
    }
  };

  const collect = async () => {
    if (collecting) return;
    setCollecting(true);
    setManualError('');
    const outcome = await collectOwnImageKitCandidates(userId);
    setProblems(outcome.problems);
    setRows(outcome.candidates.map(candidate => ({ candidate, running: false, result: null })));
    setCollected(true);
    setCollecting(false);
  };

  const addManual = () => {
    const candidate = toCandidateFromInput(manualPath);
    if (!candidate) {
      setManualError('ألصق رابط ImageKit كاملاً (https://ik.imagekit.io/...) أو مساراً مطلقاً يبدأ بـ"/".');
      return;
    }
    setManualError('');
    setManualPath('');
    setRows(previous => [...previous, { candidate, running: false, result: null }]);
  };

  const signingEnabled = isImageKitSigningEnabled();

  const button = createPortal(
    <button
      type="button"
      onClick={() => setOpen(value => !value)}
      aria-label="اختبار توقيع ImageKit"
      style={{
        position: 'fixed',
        left: 12,
        bottom: 'calc(5.5rem + env(safe-area-inset-bottom))',
        zIndex: 2147482000,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        borderRadius: 999,
        border: '1px solid rgba(56,189,248,0.45)',
        background: 'rgba(12,18,26,0.92)',
        color: '#7dd3fc',
        fontSize: 11,
        fontWeight: 700,
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
      }}
    >
      <Bug size={13} />
      تشخيص التوقيع
    </button>,
    document.body,
  );

  if (!open) return button;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147482500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.75)',
        padding: 12,
      }}
      onClick={() => setOpen(false)}
    >
      <section
        dir="rtl"
        onClick={event => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 460,
          maxHeight: '86dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 18,
          border: '1px solid rgba(255,255,255,0.12)',
          background: '#0d0f13',
          color: '#f4f4f5',
          fontSize: 12,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <Bug size={16} style={{ color: '#7dd3fc' }} />
          <strong style={{ flex: 1, fontSize: 13 }}>اختبار توقيع ImageKit</strong>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={() => setOpen(false)}
            style={{ color: '#a1a1aa', background: 'transparent', border: 'none' }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
          <p style={{ margin: 0, color: '#a1a1aa', lineHeight: 1.7 }}>
            أداة مؤقتة — تُحذف بعد الاختبار. تعرض فقط حالة الاستجابة: لا مفاتيح ولا رموز جلسة ولا روابط موقّعة.
          </p>
          <p style={{ margin: '8px 0 0', color: signingEnabled ? '#4ade80' : '#a1a1aa', lineHeight: 1.7 }}>
            {signingEnabled
              ? 'VITE_IMAGEKIT_SIGNED_URLS=true في هذه الحزمة: التوقيع مفعّل للعرض المباشر.'
              : 'VITE_IMAGEKIT_SIGNED_URLS غير مفعّل في هذه الحزمة — الاختبار يطلب التوقيع من الخادم مباشرة بغض النظر عن ذلك.'}
          </p>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void collect()}
              disabled={collecting}
              style={{
                flex: 1,
                minWidth: 130,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(56,189,248,0.35)',
                background: 'rgba(56,189,248,0.12)',
                color: '#7dd3fc',
                fontWeight: 700,
              }}
            >
              {collecting ? <Loader2 size={14} className="animate-spin" /> : null}
              جمع مساراتي
            </button>
            <button
              type="button"
              onClick={() => void testAll()}
              disabled={rows.length === 0 || rows.some(row => row.running)}
              style={{
                flex: 1,
                minWidth: 130,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.06)',
                color: rows.length === 0 ? '#71717a' : '#f4f4f5',
                fontWeight: 700,
              }}
            >
              اختبر الكل
            </button>
          </div>

          <div style={{ marginTop: 12 }}>
            <input
              value={manualPath}
              onChange={event => setManualPath(event.target.value)}
              placeholder="مسار يدوي: رابط ImageKit أو /endpoint/aani/<id>/file.jpg"
              dir="ltr"
              style={{
                width: '100%',
                padding: '9px 11px',
                borderRadius: 11,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                color: '#f4f4f5',
                fontSize: 11,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                onClick={addManual}
                style={{
                  padding: '8px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.14)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#f4f4f5',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                أضف المسار
              </button>
              {manualError ? <span style={{ color: '#fb7185', lineHeight: 1.6 }}>{manualError}</span> : null}
            </div>
          </div>

          {problems.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                borderRadius: 11,
                border: '1px solid rgba(251,191,36,0.3)',
                background: 'rgba(251,191,36,0.07)',
                color: '#fbbf24',
                lineHeight: 1.7,
              }}
            >
              {problems.map(problem => (
                <div key={problem}>• {problem}</div>
              ))}
            </div>
          )}

          {rows.length === 0 && !collecting && (
            <p style={{ marginTop: 14, color: '#71717a', lineHeight: 1.7 }}>
              {collected
                ? 'لم يُعثر على رابط ImageKit واحد في صورة ملفك وغلافه ومنشوراتك وقصصك. إن كانت وسائطك القديمة على Supabase Storage فهي غير مشمولة بهذا الاختبار — ألصق مسار ImageKit في الحقل أعلاه.'
                : 'اضغط «جمع مساراتي» لقراءة صورة ملفك وغلافه ومنشوراتك وقصصك من القاعدة، ثم اختبر توقيع أي منها.'}
            </p>
          )}

          <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            {rows.map((row, index) => (
              <div
                key={`${row.candidate.path}-${index}`}
                style={{
                  padding: 10,
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.09)',
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>{row.candidate.source}</span>
                  <button
                    type="button"
                    onClick={() => void testRow(index)}
                    disabled={row.running}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '6px 10px',
                      borderRadius: 9,
                      border: '1px solid rgba(255,255,255,0.14)',
                      background: 'rgba(255,255,255,0.06)',
                      color: row.running ? '#71717a' : '#f4f4f5',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {row.running ? <Loader2 size={12} className="animate-spin" /> : null}
                    {row.running ? 'جارٍ' : 'اختبر'}
                  </button>
                </div>
                <div
                  dir="ltr"
                  style={{
                    marginTop: 6,
                    color: '#71717a',
                    fontSize: 10,
                    wordBreak: 'break-all',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  }}
                >
                  {row.candidate.path}
                </div>
                {row.result && (
                  <div style={{ marginTop: 6 }}>
                    <StepLine label="التوقيع" step={row.result.sign} />
                    <StepLine label="الفتح" step={row.result.open} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
