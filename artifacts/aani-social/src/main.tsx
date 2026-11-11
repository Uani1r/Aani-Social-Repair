import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { installGlobalUnlockListener } from '@/audio/AudioEngine';

import './index.css';

// Aani Media Engine: capture-phase audio unlock on the root + visibility
// auto-pause/resume. Installed once, synchronously, before the first render.
installGlobalUnlockListener();

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
