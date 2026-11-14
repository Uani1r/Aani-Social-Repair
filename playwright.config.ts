import { defineConfig, devices } from '@playwright/test';

/**
 * إعداد AANI Quality Audit — الأساس الآلي لفحص واجهة تطبيق آني.
 *
 * البيئات الثلاث المفحوصة في كل تشغيل:
 *   1) chromium-desktop : Chromium على مقاس سطح المكتب.
 *   2) chromium-iphone  : محرك Chromium مع محاكاة iPhone كاملة.
 *   3) webkit-iphone    : محرك WebKit (محرك Safari) مع محاكاة iPhone كاملة.
 *
 * لا يتصل الفحص بأي خدمة خارجية: اختبارات e2e تمنع كل طلب غير محلي
 * (Supabase، خطوط Google، ImageKit …) عبر e2e/utils/network.ts.
 */

const APP_PORT = 4173;

// يمكن تمرير AANI_BASE_URL لتشغيل الفحص على خادم قائم بدل تشغيل Vite محلياً.
const BASE_URL = process.env.AANI_BASE_URL ?? `http://127.0.0.1:${APP_PORT}`;

const IS_CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: IS_CI ? 1 : undefined,

  // التقرير العربي يُبنى من results.json عبر scripts/quality-audit/report-ar.mjs
  reporter: [
    ['list'],
    ['json', { outputFile: 'quality-audit-results/results.json' }],
    ['html', { open: 'never', outputFolder: 'quality-audit-results/html' }],
  ],

  use: {
    baseURL: BASE_URL,
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // Chromium مع ملف جهاز iPhone — لفحص سلوك عرض المحرك على مقاس الآيفون.
      name: 'chromium-iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
      },
    },
    {
      // WebKit مع ملف جهاز iPhone — أقرب محاكاة لمتصفح Safari على الآيفون.
      name: 'webkit-iphone',
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],

  webServer: process.env.AANI_BASE_URL
    ? undefined
    : {
        command: `pnpm --filter @workspace/aani-social exec vite --config vite.config.ts --port ${APP_PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !IS_CI,
        timeout: 180_000,
        env: { PORT: String(APP_PORT) },
      },
});
