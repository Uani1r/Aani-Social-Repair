import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" storageKey="aani-theme">
      <App />
    </ThemeProvider>
  </ErrorBoundary>,
);
