import { expect, test } from '@playwright/test';

import { blockExternalRequests, openApp } from './utils/network';

test.describe('تخطيط الواجهة', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('لا تمرير أفقي على مستوى الصفحة', async ({ page }) => {
    await openApp(page);
    await page.waitForTimeout(2_000);

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body ? document.body.scrollWidth : 0,
    }));

    expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('لقطة شاشة مرجعية لكل بيئة', async ({ page }, testInfo) => {
    await openApp(page);
    await page.waitForTimeout(2_000);

    const screenshotPath = `quality-audit-results/screenshots/${testInfo.project.name}-home.png`;
    await page.screenshot({ path: screenshotPath });

    await testInfo.attach('home-screenshot', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });
});
