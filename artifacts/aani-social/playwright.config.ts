import { defineConfig, devices } from '@playwright/test';

// Browser tests for the shared profile content preview. The page is served by
// vite.test.config.ts, which swaps src/lib/supabase for an unconfigured stub:
// no Supabase project (and no other network endpoint) is contacted.
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --config vite.test.config.ts',
    url: 'http://127.0.0.1:4179/profile-reorder-test.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
