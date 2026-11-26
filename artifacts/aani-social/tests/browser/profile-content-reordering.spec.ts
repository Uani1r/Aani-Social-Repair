import { expect, test, type Locator, type Page } from '@playwright/test';

// Real pointer drag & drop: press, hold past the 450ms long press, move onto the
// target, release. The drag starts on the item itself — its image, video or
// circle — never on a handle, because the reorder UI has no controls at all.
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

// Long press without moving, then release on the same item: the browser sends a
// click afterwards, which the preview must consume instead of opening the item.
async function longPressInPlace(page: Page, item: Locator) {
  const box = await item.boundingBox();
  if (!box) throw new Error('press target must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await page.mouse.up();
}

// The aria-live announcement and the post the preview opened through a click.
const announcement = (page: Page) => page.locator('[data-testid="reorder-announcement"]');
const openedPost = (page: Page) => page.locator('[data-testid="opened-post"]');
const log = (page: Page) => page.evaluate(() => window.__profileReorderLog ?? []);

const highlightTitles = (page: Page) => page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"] > span:last-of-type');
const gridIds = (page: Page) => page.locator('section[aria-label="media grid"] [data-profile-reorder-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id')));
const storyIds = (page: Page) => page.locator('section[aria-label="collection stories"] [data-profile-reorder-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-reorder-id')));
const posts = (page: Page) => page.locator('section[aria-label="media grid"] [data-profile-reorder-kind="posts"]');
const circles = (page: Page) => page.locator('section[aria-label="highlights"] [data-profile-reorder-kind="highlights"]');
const stories = (page: Page) => page.locator('section[aria-label="collection stories"] [data-profile-reorder-kind="stories"]');
const repost = (page: Page) => page.locator('section[aria-label="media grid"] > div > button').last();
const openCollection = (page: Page) => page.locator('[data-profile-reorder-id="c-one"]').click();

// Dispatches a cancelable event of type touchmove and reports whether the page
// cancelled it. The listener only needs the event type and its cancelability,
// which is what stops Safari from scrolling during an active drag.
const touchMovePrevented = (page: Page) => page.evaluate(() => {
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event.defaultPrevented;
});

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

  const excluded = page.locator('[data-testid="excluded"]');
  expect(await excluded.getAttribute('data-text')).toBe('p-text');
  await expect(page.locator('[data-profile-reorder-id="p-text"]')).toHaveCount(0);

  const grid = page.locator('section[aria-label="media grid"] > div').first();
  await expect(grid).toHaveClass(/grid-cols-3/);
  await expect(page.locator('[data-profile-reorder-id="p-one"]')).toBeVisible();
});

// The reorder UI carries no controls: no handle, no previous/next buttons, and
// the items keep their normal touch-action so the page still scrolls by finger.
test('shows no drag handle and no previous/next buttons on the media', async ({ page }) => {
  await expect(page.locator('.profile-reorder-drag-handle')).toHaveCount(0);
  await expect(page.locator('[data-profile-reorder-handle]')).toHaveCount(0);
  await expect(page.locator('.profile-reorder-move-group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'نقل العنصر إلى الموضع السابق' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'نقل العنصر إلى الموضع التالي' })).toHaveCount(0);

  // No icon-only control inside a tile: each grid tile has exactly the tile's
  // own text nodes, and the circles only their artwork and title.
  await expect(page.locator('section[aria-label="media grid"] button button')).toHaveCount(0);
  await expect(page.locator('section[aria-label="highlights"] button button')).toHaveCount(0);

  for (const id of ['p-one', 'c-one']) {
    const touchAction = await page.locator(`[data-profile-reorder-id="${id}"]`).evaluate(node => getComputedStyle(node).touchAction);
    expect(touchAction).toBe('auto');
  }
});

test('reorders a post by long-pressing its image', async ({ page }) => {
  await longPressDrag(page, posts(page).nth(2), posts(page).nth(0));

  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
  expect((await log(page)).at(-1)).toEqual({
    kind: 'posts',
    nextIds: ['p-three', 'p-one', 'p-two'],
    previousIds: ['p-one', 'p-two', 'p-three'],
  });
});

test('reorders a highlight circle by long-pressing the circle itself', async ({ page }) => {
  await longPressDrag(page, circles(page).nth(0), circles(page).nth(1));

  expect(await highlightTitles(page).allTextContents()).toEqual(['الأولى', 'الثانية']);
  expect((await log(page)).at(-1)).toEqual({ kind: 'highlights', nextIds: ['c-one', 'c-two'], previousIds: ['c-two', 'c-one'] });
});

test('reorders a story circle inside its collection', async ({ page }) => {
  await openCollection(page);
  await expect(stories(page)).toHaveCount(3);

  await longPressDrag(page, stories(page).nth(2), stories(page).nth(0));

  expect(await storyIds(page)).toEqual(['s-one-3', 's-one-1', 's-one-2']);
  expect((await log(page)).at(-1)?.kind).toBe('stories');
  expect((await log(page)).at(-1)?.nextIds).toEqual(['s-one-3', 's-one-1', 's-one-2']);
});

test('opens a post on a short click and never opens it after a drag', async ({ page }) => {
  await posts(page).nth(1).click();
  await expect(openedPost(page)).toHaveText('p-two');

  // A real drag must not open the moved tile.
  await longPressDrag(page, posts(page).nth(2), posts(page).nth(0));
  await expect(openedPost(page)).toHaveText('p-two');
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);

  // Long press without moving, released on the same tile: the click the browser
  // sends afterwards is consumed, so the tile stays closed.
  await longPressInPlace(page, posts(page).nth(1));
  await expect(openedPost(page)).toHaveText('p-two');
});

test('opens a collection and a story on a short click', async ({ page }) => {
  await expect(page.locator('section[aria-label="collection stories"]')).toHaveCount(0);
  await openCollection(page);
  await expect(stories(page)).toHaveCount(3);

  await stories(page).nth(1).click();
  await expect(openedPost(page)).toHaveText('s-one-1');
});

test('does not reorder when the pointer moves before the long press completes', async ({ page }) => {
  const box = await posts(page).nth(0).boundingBox();
  if (!box) throw new Error('press target must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Moving past the 10px threshold before 450ms cancels the gesture.
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 4 });
  await page.waitForTimeout(600);
  await page.mouse.up();

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  expect(await log(page)).toEqual([]);
});

// The page is scrollable by touch until the long press completes, and only an
// active drag cancels the browser's scroll (ProfilePage's non-passive listener).
test('blocks page scrolling only while a drag is active', async ({ page }) => {
  expect(await touchMovePrevented(page)).toBe(false);

  const box = await posts(page).nth(0).boundingBox();
  if (!box) throw new Error('press target must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520);
  expect(await touchMovePrevented(page)).toBe(true);
  await page.mouse.up();

  expect(await touchMovePrevented(page)).toBe(false);
  // Releasing on the same tile neither reorders nor opens it.
  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  await expect(openedPost(page)).toHaveText('');
});

test('leaves the repost untouched', async ({ page }) => {
  await longPressDrag(page, repost(page), posts(page).nth(0));

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  expect(await log(page)).toEqual([]);
  await expect(page.locator('[data-profile-reorder-id="p-repost"]')).toHaveCount(0);
});

test('restores the previous order when the save fails', async ({ page }) => {
  await page.evaluate(() => { window.__profileReorderFailNext = true; });
  await longPressDrag(page, posts(page).nth(0), posts(page).nth(1));

  expect(await gridIds(page)).toEqual(['p-one', 'p-two', 'p-three']);
  expect((await log(page)).at(-1)?.nextIds).toEqual(['p-one', 'p-two', 'p-three']);
  await expect(announcement(page)).toContainText('فشل حفظ الترتيب');
});

test('keeps the saved order after a reload', async ({ page }) => {
  await longPressDrag(page, posts(page).nth(2), posts(page).nth(0));
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);

  await page.reload();
  await expect(page.locator('section[aria-label="media grid"]')).toBeVisible();
  expect(await gridIds(page)).toEqual(['p-three', 'p-one', 'p-two']);
});
