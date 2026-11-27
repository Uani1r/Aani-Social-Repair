import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { registerNativeOAuthListener } from '@/lib/oauthNative';

import './index.css';

if (typeof window !== 'undefined' && (window as any)?.Capacitor?.isNativePlatform?.()) {
  registerNativeOAuthListener();
}

// حاجز أخطاء React فقط (بلا أي مستمع عام لـ window): عند فشل الرسم تعرض
// واجهة استعادة وزنها "إعادة المحاولة" يعيد تركيب الشجرة عبر تصفير الحالة.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" storageKey="aani-theme">
      <App />
    </ThemeProvider>
  </ErrorBoundary>,
);
