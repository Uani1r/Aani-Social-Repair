import type { Page } from '@playwright/test';

/**
 * أدوات مشتركة لاختبارات AANI Quality Audit.
 *
 * مهم: الفحص معزول تماماً — لا اتصال بـ Supabase ولا بأي خدمة خارجية.
 * كل طلب إلى نطاق غير محلي يُقطع قبل أن يخرج من المتصفح.
 */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function blockExternalRequests(page: Page): Promise<void> {
  await page.route('**/*', route => {
    let hostname = '';
    try {
      hostname = new URL(route.request().url()).hostname;
    } catch {
      // رابط غير صالح (data: أو about:) — يُقطع أيضاً
      return route.abort();
    }
    return LOCAL_HOSTNAMES.has(hostname) ? route.continue() : route.abort();
  });
}

export async function openApp(page: Page, pathname = '/'): Promise<void> {
  await page.goto(pathname, { waitUntil: 'domcontentloaded' });
  await page.locator('#root').waitFor({ state: 'attached', timeout: 30_000 });
}
