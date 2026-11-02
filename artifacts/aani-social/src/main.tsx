import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

declare global {
  interface Window {
    /** حارس الإقلاع المعرَّف في index.html. */
    aaniBootFail?: (detail?: string) => void;
    /** يصبح true بعد نجاح الإقلاع، فيتوقف الحارس عن العرض. */
    aaniBooted?: boolean;
  }
}

const container = document.getElementById('root');

/**
 * يعرض سبب تعذّر الإقلاع بدل ترك الصفحة فارغة (شاشة بيضاء).
 * الأنماط مستخدمة في index.html أيضاً.
 */
function showBootError(error: unknown): void {
  console.error('[aani] failed to start', error);

  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  if (typeof window.aaniBootFail === 'function') {
    window.aaniBootFail(message);
    return;
  }

  const target = container ?? document.body;
  target.textContent = '';

  const box = document.createElement('div');
  box.className = 'aani-boot';

  const title = document.createElement('strong');
  title.textContent = 'آني Aani';

  const note = document.createElement('small');
  note.textContent = 'تعذّر تشغيل الواجهة. أعد تحميل الصفحة.';

  const info = document.createElement('pre');
  info.textContent = message;

  box.append(title, note, info);
  target.appendChild(box);
}

if (!container) {
  showBootError(new Error('عنصر #root غير موجود في الصفحة.'));
} else {
  try {
    createRoot(container, {
      // Keeps caught errors off reportError(), which would raise the dev overlay.
      onCaughtError: (error, errorInfo) => {
        console.error(error, errorInfo.componentStack);
      },
    }).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    );

    // الإقلاع نجح: يتوقف حارس index.html عن اعتراض الأخطاء اللاحقة.
    window.aaniBooted = true;
  } catch (error) {
    showBootError(error);
  }
}
