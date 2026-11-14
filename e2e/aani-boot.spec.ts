import { expect, test } from '@playwright/test';

import { blockExternalRequests, openApp } from './utils/network';

// ضجيج شبكة متوقع في بيئة معزولة (طلبات مقطوعة عمداً) — لا يُعد خطأ برمجياً.
const EXPECTED_NETWORK_NOISE = /(failed to fetch|load failed|networkerror|net::err_|aborted|aborterror|offline|err_|timed out|timeout|fetch failed)/i;

test.describe('إقلاع تطبيق آني', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('الصفحة تُقدَّم بإطار عربي من اليمين إلى اليسار', async ({ page }) => {
    await openApp(page);

    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'ar');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('meta[name="viewport"]')).toHaveCount(1);
  });

  test('واجهة React تُركَّب داخل #root بلا شاشة خطأ Vite', async ({ page }) => {
    await openApp(page);

    await expect(page.locator('#root')).toHaveCount(1);
    await expect(page.locator('#root > *').first()).toBeAttached({ timeout: 25_000 });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  });

  test('لا أخطاء JavaScript برمجية غير مُلتقطة أثناء الإقلاع', async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await openApp(page);
    await page.waitForTimeout(4_000);

    const programmingErrors = pageErrors.filter(message => !EXPECTED_NETWORK_NOISE.test(message));

    await testInfo.attach('page-errors', {
      body: pageErrors.join('\n') || 'لا أخطاء',
      contentType: 'text/plain',
    });

    expect(programmingErrors, programmingErrors.join('\n---\n')).toEqual([]);
  });
});
