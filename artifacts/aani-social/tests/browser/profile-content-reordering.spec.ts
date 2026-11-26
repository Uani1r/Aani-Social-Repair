import { expect, test, type Locator, type Page } from '@playwright/test';

// Real pointer drag & drop: press, hold past the 450ms long press, move onto the
// target, release. The components use pointer events and elementFromPoint, so
// the drag has to be a genuine pointer sequence instead of synthetic events.
// `from` is the drag handle: the item itself never captures the pointer.
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

// The title of each highlight circle: the last direct span of its own item, so
// every collection yields exactly one title instead of the page's last span.
const highlightTitles = (page: Page) => page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"] > span:last-of-type');
const gridIds = (page: Page) => page.locator('section[aria-label="media grid"] [data-profile-reorder-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id')));
const storyIds = (page: Page) => page.locator('section[aria-label="collection stories"] [data-profile-reorder-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id')));
const log = (page: Page) => page.evaluate(() => window.__profileReorderLog ?? []);

// Every reorderable item carries its own drag handle; the item itself does not.
const handleOf = (item: Locator) => item.locator('.profile-reorder-drag-handle');
const posts = (page: Page) => page.locator('section[aria-label="media grid"] [data-profile-reorder-kind="posts"]');
const circles = (page: Page) => page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"]');
const stories = (page: Page) => page.locator('section[aria-label="collection stories"] [data-profile-reorder-kind="stories"]');
const openFirstCollection = (page: Page) => page.locator('[data-profile-reorder-id="c-one"] .profile-reorder-circle-action').click();
const announcement = (page: Page) => page.locator('[data-testid="reorder-announcement"]');
const movePrevious = { name: 'نقل العنصر إلى الموضع السابق' };
const moveNext = { name: 'نقل العنصر إلى الموضع التالي' };

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

// The handle is the only drag surface: items keep touch-action: auto so the
// rows and the grid still scroll with a finger, and only handle blocks it.
test('shows a drag handle on reorderable items only and keeps items scrollable', async ({ page }) => {
  await expect(page.locator('section[aria-label="highlights"] .profile-reorder-drag-handle')).toHaveCount(2);
  await expect(page.locator('section[aria-label="media grid"] .profile-reorder-drag-handle')).toHaveCount(3);

  // The repost tile is not reorderable: a plain tile button, no handle.
  const repost = page.locator('section[aria-label="media grid"] > div > button');
  await expect(repost).toHaveCount(1);
  await expect(repost.locator('.profile-reorder-drag-handle')).toHaveCount(0);
  await expect(page.locator('[data-profile-reorder-id="p-repost"]')).toHaveCount(0);

  const itemTouchAction = await page.locator('[data-profile-reorder-id="p-one"]').evaluate(node => getComputedStyle(node).touchAction);
  expect(itemTouchAction).toBe('auto');
  const handleTouchAction = await page.locator('[data-profile-reorder-id="p-one"] .profile-reorder-drag-handle').evaluate(node => getComputedStyle(node).touchAction);
  expect(handleTouchAction).toBe('none');

  // The stories strip only exists inside an opened collection, and every story
  // in it has its own handle too.
  await expect(page.locator('section[aria-label="collection stories"]')).toHaveCount(0);
  await openFirstCollection(page);
  await expect(stories(page)).toHaveCount(3);
  await expect(page.locator('section[aria-label="collection stories"] .profile-reorder-drag-handle')).toHaveCount(3);
});

// Same pointer sequence as a drag, but pressed on the tile instead of its
// handle: nothing moves, and the click never becomes a reorder.
test('does not reorder when the gesture starts outside the handle', async ({ page }) => {
  await longPressDrag(page, posts(page).nth(2), posts(page).nth(0));
  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  expect(await log(page)).toEqual([]);

  await longPressDrag(page, circles(page).nth(0), circles(page).nth(1));
  expect(await highlightTitles(page).allTextContents()).toEqual(['الثانية', 'الأولى']);
  expect(await log(page)).toEqual([]);
});

test('reorders a highlight collection and records the new id order', async ({ page }) => {
  await longPressDrag(page, handleOf(circles(page).nth(0)), circles(page).nth(1));

  expect(await highlightTitles(page).allTextContents()).toEqual(['الأولى', 'الثانية']);
  const entries = await log(page);
  expect(entries.at(-1)).toEqual({ kind: 'highlights', nextIds: ['c-one', 'c-two'], previousIds: ['c-two', 'c-one'] });
});

test('opens a collection and reorders its stories', async ({ page }) => {
  await openFirstCollection(page);
  await expect(stories(page)).toHaveCount(3);

  await longPressDrag(page, handleOf(stories(page).nth(2)), stories(page).nth(0));

  expect(await storyIds(page)).toEqual(['s-one-3', 's-one-1', 's-one-2']);
  const entries = await log(page);
  expect(entries.at(-1)?.kind).toBe('stories');
  expect(entries.at(-1)?.nextIds).toEqual(['s-one-3', 's-one-1', 's-one-2']);
});

test('reorders owned posts and leaves the repost untouched', async ({ page }) => {
  await longPressDrag(page, handleOf(posts(page).nth(2)), posts(page).nth(0));

  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
  const entries = await log(page);
  expect(entries.at(-1)).toEqual({ kind: 'posts', nextIds: ['p-three', 'p-one', 'p-two'], previousIds: ['p-one', 'p-two', 'p-three'] });

  // The repost tile has no handle and no reorder attributes, so dragging it
  // onto the grid changes nothing.
  const repost = page.locator('section[aria-label="media grid"] > button');
  await longPressDrag(page, repost, posts(page).nth(0));
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
});

test('moves posts, highlight collections and stories with the previous and next buttons', async ({ page }) => {
  await posts(page).nth(0).getByRole('button', moveNext).click();
  expect(await gridIds(page)).toEqual(['p-two', 'p-one', 'p-three']);
  expect((await log(page)).at(-1)).toEqual({ kind: 'posts', nextIds: ['p-two', 'p-one', 'p-three'], previousIds: ['p-one', 'p-two', 'p-three'] });
  await expect(announcement(page)).toContainText('الموضع 2 من 3');

  // The first item cannot go back, the last cannot go forward, and neither
  // adds a save attempt.
  await posts(page).nth(0).getByRole('button', movePrevious).click();
  expect(await gridIds(page)).toEqual(['p-two', 'p-one', 'p-three']);
  await posts(page).nth(2).getByRole('button', moveNext).click();
  expect(await gridIds(page)).toEqual(['p-two', 'p-one', 'p-three']);
  expect((await log(page)).length).toBe(1);

  await circles(page).nth(0).getByRole('button', moveNext).click();
  expect(await highlightTitles(page).allTextContents()).toEqual(['الأولى', 'الثانية']);
  await expect(announcement(page)).toContainText('الموضع 2 من 2');

  await openFirstCollection(page);
  await stories(page).nth(0).getByRole('button', moveNext).click();
  expect(await storyIds(page)).toEqual(['s-one-2', 's-one-1', 's-one-3']);
  expect((await log(page)).at(-1)).toEqual({
    kind: 'stories',
    nextIds: ['s-one-2', 's-one-1', 's-one-3'],
    previousIds: ['s-one-1', 's-one-2', 's-one-3'],
  });
});

test('restores the previous order when the save fails', async ({ page }) => {
  await page.evaluate(() => { window.__profileReorderFailNext = true; });
  await longPressDrag(page, handleOf(posts(page).nth(0)), posts(page).nth(1));

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  const entries = await log(page);
  expect(entries.at(-1)?.nextIds).toEqual(['p-one', 'p-two', 'p-three']);
});

test('restores the order when a previous/next save fails', async ({ page }) => {
  await page.evaluate(() => { window.__profileReorderFailNext = true; });
  await posts(page).nth(0).getByRole('button', moveNext).click();

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  const entries = await log(page);
  expect(entries.at(-1)).toEqual({ kind: 'posts', nextIds: ['p-one', 'p-two', 'p-three'], previousIds: ['p-two', 'p-one', 'p-three'] });
  await expect(announcement(page)).toContainText('فشل حفظ الترتيب');
});

test('keeps the saved order after a reload', async ({ page }) => {
  await longPressDrag(page, handleOf(posts(page).nth(2)), posts(page).nth(0));
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);

  await page.reload();
  await expect(page.locator('section[aria-label="media grid"]')).toBeVisible();
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
});

test('keeps the order set with the buttons after a reload', async ({ page }) => {
  await posts(page).nth(2).getByRole('button', movePrevious).click();
  expect(await gridIds(page)).toEqual(['p-one', 'p-three', 'p-two']);

  await page.reload();
  await expect(page.locator('section[aria-label="media grid"]')).toBeVisible();
  expect(await gridIds(page)).toEqual(['p-one', 'p-three', 'p-two']);
});
