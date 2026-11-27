import { test, expect } from '@playwright/test';

test('gallery orders known photo dates oldest first and keeps undated photos at the end after reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language: 'en', storageType: 'local' });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    canvas.getContext('2d').fillRect(0, 0, 40, 40);
    const originalUrl = canvas.toDataURL();
    const records = [
      { id: 'unknown-new', dateOfPhoto: '', uploadDate: 9999999999999 },
      { id: 'exact', dateOfPhoto: '1968-07-23', uploadDate: 3 },
      { id: 'recent', dateOfPhoto: '2020', uploadDate: -9999999999999 },
      { id: 'unknown-missing', uploadDate: 10 },
      { id: 'year', dateOfPhoto: '1968', uploadDate: 5000 },
      { id: 'unknown-invalid', dateOfPhoto: '1900-02-29', uploadDate: -9999999999999 },
      { id: 'oldest', dateOfPhoto: '1900-01-01', uploadDate: 9000 },
      { id: 'month', dateOfPhoto: '1968-07', uploadDate: 1 },
    ];
    for (const record of records) {
      await storageService.savePhoto({
        ...record, fileName: `${record.id}.png`, originalUrl,
        description: `Order ${record.id}`, people: [], tags: [], faceTags: [], isRestoring: false,
      });
    }
  });
  const expected = ['oldest', 'year', 'month', 'exact', 'recent', 'unknown-new', 'unknown-missing', 'unknown-invalid']
    .map(id => `Order ${id}`);
  const images = page.locator('main img');
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expect(images).toHaveCount(expected.length);
    await expect.poll(() => images.evaluateAll(elements => elements.map(element => element.alt))).toEqual(expected);
  }
  await page.getByRole('img', { name: 'Order oldest', exact: true }).click();
  await expect(page.getByLabel('Photo position', { exact: true })).toHaveText('1 / 8');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Photo viewer', exact: true })
    .getByRole('img', { name: 'Order year', exact: true })).toBeVisible();
  await expect(page.getByLabel('Photo position', { exact: true })).toHaveText('2 / 8');
});
