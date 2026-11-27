// Captures mobile screenshots of the family tree against a local dev server, using
// browser storage seeded with a sample tree (no Firebase sign-in needed).
// Usage: npm run dev   (in another terminal), then: node scripts/mobile-screenshots.mjs [outDir] [label]
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import { familyTreeWithCousins } from '../tests/family-tree-fixtures.mjs';

const outDir = process.argv[2] || 'screenshots';
const label = process.argv[3] || 'current';
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
fs.mkdirSync(outDir, { recursive: true });

// CHROMIUM_PATH points at a preinstalled browser when Playwright's own download is missing.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const viewports = [['iphone13', devices['iPhone 13']], ['pixel5', devices['Pixel 5']], ['iphone-se-landscape', devices['iPhone SE landscape']], ['iphone-se', devices['iPhone SE']]];
for (const [name, device] of viewports) {
  const context = await browser.newContext({ ...device, storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [
    { name: 'ancestry-lens-recognition-paused', value: 'true' }, { name: 'ancestry-lens-similarity-paused', value: 'true' },
  ] }] } });
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.evaluate(async tree => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.saveFamilyTree(tree);
  }, familyTreeWithCousins());
  await page.reload();
  const shot = async step => page.screenshot({ path: `${outDir}/${label}-${name}-${step}.png` });
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await page.getByTestId('family-tree-canvas').waitFor();
  await page.waitForTimeout(400);
  await shot('1-tree');
  // Tap a card near the bottom: on portrait phones the details sheet opens and the card is panned above it.
  await page.getByRole('button', { name: 'Select Leo Taylor', exact: true }).tap();
  await page.waitForTimeout(500);
  await shot('2-details');
  const details = page.locator('#family-tree-details');
  await details.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(200);
  await shot('3-details-bottom');
  await details.evaluate(element => { element.scrollTop = 0; });
  await details.getByRole('button', { name: 'Edit details', exact: true }).tap();
  await page.waitForTimeout(300);
  await shot('4-edit');
  await page.keyboard.press('Escape');
  await details.getByRole('button', { name: 'Close', exact: true }).tap();
  await page.getByRole('button', { name: 'Fit tree', exact: true }).tap();
  await page.waitForTimeout(300);
  await shot('5-fit');
  await page.getByRole('button', { name: 'Gallery', exact: true }).tap();
  await page.waitForTimeout(300);
  await shot('6-gallery');
  await context.close();
}
await browser.close();
console.log(`Saved screenshots to ${outDir}`);
