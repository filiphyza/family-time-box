import { test, expect } from '@playwright/test';
import UTIF from 'utif2';

function scan() {
  const pixels = new Uint8Array(48 * 32 * 4).fill(255);
  return Buffer.from(UTIF.encodeImage(pixels, 48, 32));
}

test('upload shows file progress, rejects extra interactions, and reports completion', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.uploadReleases = {};
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name === 'first.tif' || this.name === 'second.tif') {
        return new Promise(resolve => { window.uploadReleases[this.name] = () => read.call(this).then(resolve); });
      }
      return read.call(this);
    };
  });
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'first.tif', mimeType: 'image/tiff', buffer: scan() },
    { name: 'second.tif', mimeType: 'image/tiff', buffer: scan() },
  ]);
  await page.waitForFunction(() => Boolean(window.uploadReleases['first.tif']));
  const dropZone = page.getByRole('group', { name: 'Upload Scanned Photos', exact: true });
  await expect(dropZone).toHaveAttribute('aria-disabled', 'true');
  await expect(dropZone).toHaveClass(/cursor-wait/);
  await expect(dropZone).not.toHaveClass(/cursor-pointer/);
  await expect(dropZone).toContainText('Processing file 1 / 2');
  await expect(dropZone).toContainText('Reading: first.tif');
  await expect(dropZone).toContainText('Please wait');
  await expect(page.getByRole('progressbar', { name: 'Photo import progress', exact: true })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('input[type=file]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeDisabled();
  let pickers = 0;
  page.on('filechooser', () => pickers++);
  await dropZone.click({ force: true });
  await dropZone.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['extra'], 'ignored.tif', { type: 'image/tiff' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  expect(pickers).toBe(0);

  // The user can inspect the gallery without losing the in-flight batch indicator.
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Photo import progress', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('first.tif');
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.evaluate(() => window.uploadReleases['first.tif']());
  await page.waitForFunction(() => Boolean(window.uploadReleases['second.tif']));
  await expect(page.getByRole('progressbar', { name: 'Photo import progress', exact: true })).toHaveAttribute('aria-valuenow', '1');
  await expect(dropZone).toContainText('Processing file 2 / 2');
  await expect(dropZone).toContainText('Saved: 1');
  await expect(dropZone).toContainText('second.tif');
  await page.evaluate(() => window.uploadReleases['second.tif']());
  await expect(page.getByRole('status')).toContainText('Import finished · Saved: 2 / 2');
  await expect(page.getByRole('progressbar', { name: 'Photo import progress', exact: true })).toHaveCount(0);
  const saved = await page.evaluate(async () => (await import('/services/storageService.ts')).storageService.loadPhotos());
  expect(saved.map(photo => photo.fileName).sort()).toEqual(['first.jpg', 'second.jpg']);
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Upload Scanned Photos', exact: true })).toHaveClass(/cursor-pointer/);
});

test('failed files are included in the final summary and upload becomes available again', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'broken.tif', mimeType: 'image/tiff', buffer: Buffer.from('invalid TIFF') },
    { name: 'good.tif', mimeType: 'image/tiff', buffer: scan() },
  ]);
  await expect(page.getByRole('status')).toContainText('Import finished · Saved: 1 / 2 · Failed: 1');
  await expect(page.getByRole('alert')).toContainText('broken.tif');
  await expect(page.getByRole('progressbar', { name: 'Photo import progress', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
});
