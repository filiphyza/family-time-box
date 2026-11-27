import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { familyTreeWithCousins } from './family-tree-fixtures.mjs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const squash = text => text.replace(/\s+/g, '');

test('phone layout media queries in TypeScript and CSS stay in sync', () => {
  const source = read('components/FamilyTree.tsx');
  const query = name => source.match(new RegExp(`const ${name} = '([^']+)'`))[1];
  const treeCss = squash(read('components/FamilyTree.css'));
  const shellCss = squash(read('app-shell.css'));
  for (const css of [treeCss, shellCss]) expect(css).toContain(`@media${squash(query('COMPACT_QUERY'))}{`);
  expect(treeCss).toContain(`@media${squash(query('SHEET_QUERY'))}{`);
  expect(treeCss).toContain(`@media${squash(query('LANDSCAPE_QUERY'))}{`);
  expect(shellCss).toContain(`@media${squash(query('LANDSCAPE_QUERY'))}{`);
});

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function openTree(page) {
    await page.goto('/');
    await page.evaluate(async tree => {
      const { storageService } = await import('/services/storageService.ts');
      await storageService.saveFamilyTree(tree);
    }, familyTreeWithCousins());
    await page.reload();
    await page.getByRole('button', { name: 'Family tree', exact: true }).click();
    await expect(page.getByTestId('family-tree-canvas')).toBeVisible();
  }
  const touch = (client, type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  test('a drag that starts on a card pans the tree and a tap opens the sheet above it', async ({ page }) => {
    await openTree(page);
    const card = page.getByRole('button', { name: 'Select Alex Taylor', exact: true });
    const before = await card.boundingBox();
    const client = await page.context().newCDPSession(page);
    const start = { x: before.x + 20, y: before.y + 20 };
    await touch(client, 'touchStart', [start]);
    for (let step = 1; step <= 8; step++) await touch(client, 'touchMove', [{ x: start.x + step * 10, y: start.y + step * 6 }]);
    await touch(client, 'touchEnd', []);
    const after = await card.boundingBox();
    expect(after.x - before.x).toBeCloseTo(80, 0);
    expect(after.y - before.y).toBeCloseTo(48, 0);
    await expect(page.locator('#family-tree-details')).not.toHaveClass(/ft-details-open/);

    // Chromium treats a tap arriving within milliseconds of a drag as stopping the fling, so pause like a person.
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Select Leo Taylor', exact: true }).tap();
    const sheet = page.locator('#family-tree-details');
    await expect(sheet).toHaveClass(/ft-details-open/);
    await expect(sheet.getByRole('heading', { name: 'Leo Taylor', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const leo = await page.getByRole('button', { name: 'Select Leo Taylor', exact: true }).boundingBox();
      const top = (await sheet.boundingBox()).y;
      return leo.y + leo.height <= top;
    }).toBe(true);
    await sheet.getByRole('button', { name: 'Show more details', exact: true }).click();
    await expect(page.locator('.ft-sheet-expanded')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
