import { test, expect } from '@playwright/test';

const photo = (id, url = 'data:image/jpeg;base64,example', uploadDate = 1) => ({
  id, originalUrl: url, fileName: `${id}.jpg`, uploadDate, description: '', people: [], tags: [], faceTags: [], dateOfPhoto: '', isRestoring: false,
});

test('existing browser photos migrate intact before legacy data is removed', async ({ page }) => {
  const legacy = [photo('older', undefined, 1), photo('newer', undefined, 2)];
  await page.addInitScript(photos => localStorage.setItem('ancestry-lens-photos', JSON.stringify(photos)), legacy);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    return { photos: await storageService.loadPhotos(), legacy: localStorage.getItem('ancestry-lens-photos') };
  });
  expect(result.photos).toEqual([legacy[1], legacy[0]]);
  expect(result.legacy).toBeNull();
});

test('large photo batches exceed localStorage capacity and survive reload in IndexedDB', async ({ page }) => {
  await page.goto('/');
  const photos = Array.from({ length: 6 }, (_, index) => photo(`large-${index}`, 'data:image/jpeg;base64,' + 'A'.repeat(1900000), index));
  await page.evaluate(async photos => {
    const { storageService } = await import('/services/storageService.ts');
    for (const photo of photos) await storageService.savePhoto(photo);
  }, photos);
  await page.reload();
  const result = await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    return (await storageService.loadPhotos()).map(photo => ({ id: photo.id, size: photo.originalUrl.length }));
  });
  expect(result).toHaveLength(6);
  expect(result[0].id).toBe('large-5');
  expect(result.every(photo => photo.size > 1900000)).toBe(true);
});

test('repeated migration does not overwrite later edits; deletion persists', async ({ page }) => {
  await page.goto('/');
  const original = photo('saved');
  const result = await page.evaluate(async original => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    const first = new BrowserPhotoStorage();
    await first.savePhoto({ ...original, description: 'Latest edit' });
    localStorage.setItem('ancestry-lens-photos', JSON.stringify([original]));
    const second = new BrowserPhotoStorage();
    const loaded = await second.loadPhotos();
    await second.deletePhoto(original.id);
    return { description: loaded[0].description, remaining: (await new BrowserPhotoStorage().loadPhotos()).length };
  }, original);
  expect(result).toEqual({ description: 'Latest edit', remaining: 0 });
});

test('invalid legacy records are preserved when migration fails', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    localStorage.setItem('ancestry-lens-photos', '[{"broken":true}]');
    try { await new BrowserPhotoStorage().loadPhotos(); return { failed: false }; }
    catch { return { failed: true, legacy: localStorage.getItem('ancestry-lens-photos') }; }
  });
  expect(result.failed).toBe(true);
  expect(result.legacy).toBe('[{"broken":true}]');
});

test('upload storage failures identify quota rather than TIFF conversion', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota failure', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xQAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('alert')).toContainText('Archive storage is full');
  await expect(page.locator('input[type=file]')).toBeEnabled();
});
