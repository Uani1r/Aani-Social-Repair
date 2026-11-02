import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

const appDir = path.resolve(import.meta.dirname);
// The pnpm workspace root. A .env file may live here as well as in the app
// directory, so both locations are honoured when inlining VITE_* values.
const repoRootDir = path.resolve(import.meta.dirname, '..', '..');

const PUBLIC_ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_STORAGE_BUCKET',
] as const;

export default defineConfig(async ({ command, mode }) => {
  // Precedence: real process env (hosting platform / Docker ARG) > app .env > root .env.
  // Values found in files are pushed into process.env so Vite's own env loader
  // picks them up for import.meta.env.
  const appEnv = loadEnv(mode, appDir, 'VITE_');
  const rootEnv = loadEnv(mode, repoRootDir, 'VITE_');
  for (const key of PUBLIC_ENV_KEYS) {
    const value = appEnv[key] || rootEnv[key];
    if (value && !process.env[key]) process.env[key] = value;
  }

  if (!process.env.VITE_SUPABASE_URL || !(
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  )) {
    console.warn(
      '[vite] Supabase env missing at build time: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
    );
  }

  const rawPort = process.env.PORT || '5000';
  const port = Number(rawPort) || 5000;

  // إضافات Replit التطويرية فقط. لا يجوز أن تُسقط خادم التطوير أو البناء إذا
  // تعذّر تحميلها، ولا أن تُحقن في بناء الإنتاج (تضيف عناوين تخص خادم التطوير
  // وحده، وقد تترك الصفحة فارغة في النسخة المنشورة).
  const replitDevPlugins = async () => {
    if (
      command !== 'serve' ||
      process.env.NODE_ENV === 'production' ||
      process.env.REPL_ID === undefined
    ) {
      return [];
    }

    try {
      const [cartographer, devBanner] = await Promise.all([
        import('@replit/vite-plugin-cartographer'),
        import('@replit/vite-plugin-dev-banner'),
      ]);

      return [
        cartographer.cartographer({
          root: path.resolve(import.meta.dirname, '..'),
        }),
        devBanner.devBanner(),
      ];
    } catch (error) {
      console.warn(
        '[vite] Replit dev plugins unavailable; starting without them.',
        error,
      );
      return [];
    }
  };

  return {
    base: '/',
    plugins: [react(), tailwindcss(), ...(await replitDevPlugins())],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: appDir,
    // Read .env from the app directory; root-level values were merged into
    // process.env above.
    envDir: appDir,
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      // أخطاء الترجمة تُعرض في الصفحة بدل شاشة بيضاء صامتة.
      hmr: {
        overlay: true,
      },
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
