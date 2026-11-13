import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// حاجز أخطاء React فقط (بلا أي مستمع عام لـ window): عند فشل الرسم تعرض
// واجهة استعادة وزنها "إعادة المحاولة" يعيد تركيب الشجرة عبر تصفير الحالة.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" storageKey="aani-theme">
      <App />
    </ThemeProvider>
  </ErrorBoundary>,
);
