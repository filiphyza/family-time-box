import { test, expect } from '@playwright/test';

async function seed(page, { automatic = true } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(({ automatic }) => {
    if (!automatic) window.IntersectionObserver = undefined;
    localStorage.setItem('ancestry-lens-settings', JSON.stringify({ language: 'en', storageType: 'local' }));
    const originalUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#695c43"/></svg>');
    localStorage.setItem('ancestry-lens-photos', JSON.stringify(Array.from({ length: 75 }, (_, index) => ({
      id: `progressive-${index}`, originalUrl, fileName: `photo-${index}.svg`, uploadDate: 75 - index,
      description: `Memory ${String(index + 1).padStart(3, '0')}`, people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false,
    }))));
  }, { automatic });
  await page.goto('/');
  await expect(page.locator('main img')).toHaveCount(24);
}

test('gallery appends batches near the bottom and stops at the end', async ({ page }) => {
  await seed(page);
  const images = page.locator('main img');
  await expect(images.first()).toHaveAttribute('loading', 'lazy');
  await expect(images.first()).toHaveAttribute('decoding', 'async');
  for (const count of [48, 72, 75]) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(images).toHaveCount(count);
  }
  await expect(page.getByRole('button', { name: 'Load more photos', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Photos shown', { exact: true })).toHaveText('Photos shown: 75 / 75');
});

test('manual loading works without IntersectionObserver and filtering resets the batch', async ({ page }) => {
  await seed(page, { automatic: false });
  await page.getByRole('button', { name: 'Load more photos', exact: true }).click();
  await expect(page.locator('main img')).toHaveCount(48);
  const search = page.getByPlaceholder('Search memories, people, tags...');
  await search.fill('Memory 075');
  await expect(page.locator('main img')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'Memory 075', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more photos', exact: true })).toHaveCount(0);
  await search.fill('no matching memory');
  await expect(page.locator('main img')).toHaveCount(0);
  await expect(page.getByText('No photos found.', { exact: true })).toBeVisible();
  await search.clear();
  await expect(page.locator('main img')).toHaveCount(24);
  await expect(page.getByLabel('Photos shown', { exact: true })).toHaveText('Photos shown: 24 / 75');
});

test('photo navigation includes photos beyond the rendered batch', async ({ page }) => {
  await seed(page, { automatic: false });
  await page.getByRole('img', { name: 'Memory 024', exact: true }).click();
  await expect(page.getByLabel('Photo position', { exact: true })).toHaveText('24 / 75');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Photo position', { exact: true })).toHaveText('25 / 75');
  await expect(page.getByRole('dialog', { name: 'Photo viewer', exact: true }).getByRole('img', { name: 'Memory 025', exact: true })).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(24);
});
