import { useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';

import { dismissAppError, getAppErrorNotices, subscribeAppErrors } from '@/lib/appErrors';
import { openPublishErrorPanel } from '@/lib/publishDiagnostics';

/** هل التنبيه يخص النشر/حفظ المنشور؟ هو وحده ما له لوحة تفاصيل مخصصة. */
function isPublishNotice(operation: string): boolean {
  return /نشر|حفظ المنشور/.test(operation);
}

export default function GlobalErrorToast() {
  const [notices, setNotices] = useState(getAppErrorNotices);

  useEffect(() => subscribeAppErrors(setNotices), []);

  useEffect(() => {
    if (notices.length === 0) return undefined;
    const ids = notices.map(notice => notice.id);
    const timer = window.setTimeout(() => {
      ids.forEach(dismissAppError);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [notices]);

  if (notices.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-[10000] mx-auto flex w-[min(420px,calc(100vw-24px))] flex-col gap-2"
      dir="rtl"
      aria-live="assertive"
      aria-relevant="additions"
    >
      {notices.map(notice => (
        <section
          key={notice.id}
          role="alert"
          className="pointer-events-auto overflow-hidden rounded-2xl border border-rose-400/25 bg-[#121214] text-white shadow-[0_14px_44px_rgba(0,0,0,0.55)]"
          style={{ fontFamily: "'Tajawal', 'Cairo', sans-serif" }}
        >
          <div className="flex items-start gap-3 p-3.5">
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">{notice.operation}</p>
              <p className="mt-0.5 text-xs leading-5 text-zinc-300">{notice.userMessage}</p>
              {/* التفاصيل التقنية كانت مخفية في الإنتاج (import.meta.env.DEV) فكان
                  تشخيص فشل النشر مستحيلاً على المستخدم. صارت أخطاء النشر تفتح لوحة
                  تفاصيل كاملة مع نسخ في الإنتاج أيضاً؛ وغيرها يبقى كما كان. */}
              {isPublishNotice(notice.operation) && notice.diagnostic ? (
                <button
                  type="button"
                  onClick={openPublishErrorPanel}
                  className="mt-2 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11px] font-bold text-zinc-200 transition hover:bg-white/10 hover:text-white"
                >
                  عرض التفاصيل التقنية ونسخها
                </button>
              ) : import.meta.env.DEV && notice.diagnostic ? (
                <div className="mt-2 rounded-xl border border-white/[0.07] bg-black/30 px-2.5 py-2">
                  <p className="mb-1 text-[10px] font-semibold text-amber-300">التشخيص التقني</p>
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-zinc-400">{notice.diagnostic}</pre>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="إغلاق التنبيه"
              onClick={() => dismissAppError(notice.id)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <X size={15} />
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
