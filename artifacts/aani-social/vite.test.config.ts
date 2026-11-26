import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Test-only Vite config: serves the Playwright harness with the real shared
// profile preview components. src/lib/supabase is replaced by a stub that
// reports an unconfigured client, so nothing reaches Supabase (or any network).
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@/lib/supabase': path.resolve(rootDir, 'src/test/supabaseStub.ts'),
      '@/components/SignedMedia': path.resolve(rootDir, 'src/test/signedMediaStub.tsx'),
      '@/lib/mediaPreload': path.resolve(rootDir, 'src/test/mediaPreloadStub.ts'),
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
});
