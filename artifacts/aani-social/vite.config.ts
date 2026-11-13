import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

const appDir = path.resolve(import.meta.dirname);
// The pnpm workspace root. A .env file may live here as well as in the app
// directory, so both locations are honoured when inlining VITE_* values.
const repoRootDir = path.resolve(import.meta.dirname, '..', '..');

const PUBLIC_ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_STORAGE_BUCKET',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_VAPID_KEY',
] as const;

export default defineConfig(async ({ mode }) => {
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

  // منع تخزين HTML فقط — على كل استجابة HTML فعلية (شاملة مسارات SPA مثل
  // /feed و /profile و /messages التي يُقدَّم فيها index.html). يُضبط
  // الترويس قبل إرسالها عبر اعتراض setHeader/writeHead/end عند اكتمال
  // Content-Type = text/html. JS/CSS/الصور المعماة بـhash تبقى بتخزينها
  // الطويل — لا تغيير عليها، وHMR كما هو.
  function injectHtmlNoStore(server: ViteDevServer): void {
    server.middlewares.use((_req, res, next) => {
      try {
        const isHtmlContentType = (): boolean => {
          const contentType = res.getHeader('Content-Type');
          return typeof contentType === 'string' && contentType.includes('text/html');
        };
        const coerceCacheControl = (): void => {
          if (res.headersSent || !isHtmlContentType()) return;
          res.setHeader('Cache-Control', 'no-store');
        };

        const originalSetHeader = res.setHeader.bind(res) as typeof res.setHeader;
        res.setHeader = ((name: string, value: unknown) => {
          const lowered = name.toLowerCase();
          if (lowered === 'cache-control' && isHtmlContentType()) {
            // إجبار no-store لأي استجابة HTML فعلية
            value = 'no-store';
          } else if (lowered === 'content-type' && typeof value === 'string' && value.includes('text/html')) {
            // عند ضبط النوع HTML، أي كاش-كونترول سابق يرقى إلى no-store
            if (res.getHeader('Cache-Control')) value = 'no-store';
          }
          return originalSetHeader(name, value);
        }) as typeof res.setHeader;

        const originalWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
        res.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
          coerceCacheControl();
          return originalWriteHead(...args);
        }) as typeof res.writeHead;

        const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
        res.end = ((...args: unknown[]) => {
          coerceCacheControl();
          return originalEnd(...args);
        }) as typeof res.end;
      } catch {
        // الوسيط لا يفشل أي طلب أبداً
      }
      next();
    });
  }

  const htmlNoStorePlugin: Plugin = {
    name: 'aani-html-no-store',
    configureServer: injectHtmlNoStore,
    configurePreviewServer: injectHtmlNoStore,
  };

  return {
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      htmlNoStorePlugin,

      ...(process.env.NODE_ENV !== 'production' &&
      process.env.REPL_ID !== undefined
        ? [
            await import('@replit/vite-plugin-cartographer').then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, '..'),
              }),
            ),
            await import('@replit/vite-plugin-dev-banner').then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
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
      hmr: {
        // طبقة أخطاء Vite ظاهرة على الشاشة نفسها بدل شاشة بيضاء صامتة —
        // ضرورية للمعاينة من iPhone حيث لا يوجد Console مقروء.
        overlay: true,
      },
      fs: {
        strict: true,
      },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
