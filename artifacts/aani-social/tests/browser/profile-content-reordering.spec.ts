import { expect, test, type Locator, type Page } from '@playwright/test';

// Real pointer drag & drop: press, hold past the 450ms long press, move onto the
// target, release. The components use pointer events and elementFromPoint, so the
// drag has to be a genuine pointer sequence instead of synthetic events.
async function longPressDrag(page: Page, from: Locator, to: Locator) {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error('drag endpoints must be visible');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

// The title of each highlight circle: the last direct span of its own button, so
// every collection yields exactly one title instead of the page's last span.
const highlightTitles = (page: Page) => page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"] > span:last-of-type');
const gridIds = (page: Page) => page.locator('section[aria-label="media grid"] [data-profile-reorder-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id')));
const log = (page: Page) => page.evaluate(() => window.__profileReorderLog ?? []);

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(`${error.name}: ${error.message}`));

  await page.addInitScript(() => {
    if (!sessionStorage.getItem('profile-reorder-init')) {
      localStorage.clear();
      sessionStorage.setItem('profile-reorder-init', '1');
    }
  });
  await page.goto('/profile-reorder-test.html');

  // The harness renders either its content or the mount error it captured.
  await page.waitForSelector('[data-testid="harness-ready"], [data-testid="harness-error"]', { timeout: 15_000 });
  const errorPanel = page.locator('[data-testid="harness-error"]');
  if (await errorPanel.count()) {
    const text = await errorPanel.innerText();
    const consoleText = consoleErrors.length ? `\nconsole errors:\n${consoleErrors.join('\n')}` : '';
    throw new Error(`${text}${consoleText}`);
  }
});

test('renders the same fixed order for highlights and the media grid', async ({ page }) => {
  await expect(highlightTitles(page)).toHaveCount(2);
  expect(await highlightTitles(page).allTextContents()).toEqual(['الثانية', 'الأولى']);
  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);

  const repost = page.locator('[data-testid="excluded"]');
  expect(await repost.getAttribute('data-text')).toBe('p-text');
  await expect(page.locator('[data-profile-reorder-id="p-text"]')).toHaveCount(0);

  const grid = page.locator('section[aria-label="media grid"] > div').first();
  await expect(grid).toHaveClass(/grid-cols-3/);
  await expect(page.locator('[data-profile-reorder-id="p-one"]')).toBeVisible();
});

test('reorders a highlight collection and records the new id order', async ({ page }) => {
  const circles = page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"]');
  await longPressDrag(page, circles.nth(0), circles.nth(1));

  expect(await highlightTitles(page).allTextContents()).toEqual(['الأولى', 'الثانية']);
  const entries = await log(page);
  expect(entries.at(-1)).toEqual({ kind: 'highlights', nextIds: ['c-one', 'c-two'], previousIds: ['c-two', 'c-one'] });
});

test('opens a collection and reorders its stories', async ({ page }) => {
  // The aria-label changes with the reorder mode, so open it by its stable id.
  await page.locator('[data-profile-reorder-id="c-one"]').click();
  const stories = page.locator('section[aria-label="collection stories"] [data-profile-reorder-kind="stories"]');
  await expect(stories).toHaveCount(3);

  await longPressDrag(page, stories.nth(2), stories.nth(0));

  expect(await stories.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id'))))
    .toEqual(['s-one-3', 's-one-1', 's-one-2']);
  const entries = await log(page);
  expect(entries.at(-1)?.kind).toBe('stories');
  expect(entries.at(-1)?.nextIds).toEqual(['s-one-3', 's-one-1', 's-one-2']);
});

test('reorders owned posts and leaves the repost untouched', async ({ page }) => {
  const posts = page.locator('section[aria-label="media grid"] [data-profile-reorder-kind="posts"]');
  await longPressDrag(page, posts.nth(2), posts.nth(0));

  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
  const entries = await log(page);
  expect(entries.at(-1)).toEqual({ kind: 'posts', nextIds: ['p-three', 'p-one', 'p-two'], previousIds: ['p-one', 'p-two', 'p-three'] });

  // The repost tile is the last grid button and has no reorder attributes.
  await expect(page.locator('[data-profile-reorder-id="p-repost"]')).toHaveCount(0);
  const repost = page.locator('section[aria-label="media grid"] > div > button').last();
  await longPressDrag(page, repost, posts.nth(0));
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
});

test('restores the previous order when the save fails', async ({ page }) => {
  await page.evaluate(() => { window.__profileReorderFailNext = true; });
  const posts = page.locator('section[aria-label="media grid"] [data-profile-reorder-kind="posts"]');
  await longPressDrag(page, posts.nth(0), posts.nth(1));

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  const entries = await log(page);
  expect(entries.at(-1)?.nextIds).toEqual(['p-one', 'p-two', 'p-three']);
});

test('keeps the saved order after a reload', async ({ page }) => {
  const posts = page.locator('section[aria-label="media grid"] [data-profile-reorder-kind="posts"]');
  await longPressDrag(page, posts.nth(2), posts.nth(0));
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);

  await page.reload();
  await expect(page.locator('section[aria-label="media grid"]')).toBeVisible();
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
});
