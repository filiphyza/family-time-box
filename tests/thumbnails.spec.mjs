import { test, expect } from '@playwright/test';

async function image(page, color = '#c08040', width = 1600, height = 1000) {
  return page.evaluate(({ color, width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, color); gradient.addColorStop(1, '#ffffff');
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png');
  }, { color, width, height });
}
const record = originalUrl => ({
  id: 'thumbnail-test', originalUrl, fileName: 'scan.png', uploadDate: 1,
  description: 'Thumbnail test', people: ['Anna'], tags: ['family'], faceTags: [], dateOfPhoto: '', isRestoring: false,
});
async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    return (await storageService.loadPhotos())[0];
  });
}
async function dimensions(page, source) {
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, source);
}

test('existing browser photos receive persistent smaller previews while the viewer uses the original', async ({ page }) => {
  await page.goto('/');
  const original = await image(page);
  await page.evaluate(photo => localStorage.setItem('ancestry-lens-photos', JSON.stringify([photo])), record(original));
  await page.reload();
  await expect.poll(async () => (await stored(page))?.thumbnailUrl).toMatch(/^data:image\/webp;base64,/);
  const saved = await stored(page);
  expect(saved.originalUrl).toBe(original);
  expect(saved.thumbnailSource).toBe('original');
  expect(await dimensions(page, saved.thumbnailUrl)).toEqual([640, 400]);
  expect(saved.thumbnailUrl.length).toBeLessThan(original.length / 2);
  await expect(page.locator('main img')).toHaveAttribute('src', saved.thumbnailUrl);
  await page.getByRole('img', { name: 'Thumbnail test', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Photo viewer', exact: true }).locator('img')).toHaveAttribute('src', original);
  await page.reload();
  expect((await stored(page)).thumbnailUrl).toBe(saved.thumbnailUrl);
});

test('new uploads get thumbnails before being shown in the gallery', async ({ page }) => {
  await page.goto('/');
  const original = await image(page);
  await page.getByRole('button', { name: 'Upload Photos', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from(original.split(',')[1], 'base64') });
  await expect(page.getByRole('status')).toContainText('Import finished');
  const saved = await stored(page);
  expect(saved.originalUrl).toBe(original);
  expect(await dimensions(page, saved.thumbnailUrl)).toEqual([640, 400]);
  await expect(page.locator('main img')).toHaveAttribute('src', saved.thumbnailUrl);
});

test('restoration and replacement refresh the preview; metadata edits reuse it', async ({ page }) => {
  await page.goto('/');
  const original = await image(page);
  const restored = await image(page, '#2060e0');
  const replacement = await image(page, '#20d060');
  const result = await page.evaluate(async ({ photo, restored, replacement }) => {
    const { storageService: storage } = await import('/services/storageService.ts');
    const first = await storage.savePhoto(photo);
    const second = await storage.savePhoto({ ...first, restoredUrl: restored });
    const third = await storage.savePhoto({ ...second, restoredUrl: replacement });
    let decodes = 0;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () { decodes++; return decode.call(this); };
    let fourth;
    try { fourth = await storage.savePhoto({ ...third, description: 'New metadata' }); }
    finally { HTMLImageElement.prototype.decode = decode; }
    return { first, second, third, fourth, decodes };
  }, { photo: record(original), restored, replacement });
  expect(result.first.thumbnailUrl).not.toBe(result.second.thumbnailUrl);
  expect(result.second.thumbnailSource).toBe('restored');
  expect(result.second.thumbnailUrl).not.toBe(result.third.thumbnailUrl);
  expect(result.fourth.thumbnailUrl).toBe(result.third.thumbnailUrl);
  expect(result.decodes).toBe(0);
  expect(result.fourth.originalUrl).toBe(original);
});

test('folder migration saves a thumbnail file and preserves originals and metadata', async ({ page }) => {
  await page.goto('/');
  const original = await image(page);
  await page.evaluate(async photo => {
    const root = await navigator.storage.getDirectory();
    const archive = await root.getDirectoryHandle('thumbnail-archive', { create: true });
    window.showDirectoryPicker = async () => archive;
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
    await storageService.connectFileSystem();
    const images = await archive.getDirectoryHandle('images');
    const originalWriter = await (await images.getFileHandle('original.png', { create: true })).createWritable();
    await originalWriter.write(await (await fetch(photo.originalUrl)).blob()); await originalWriter.close();
    const writer = await (await archive.getFileHandle('ancestry_db.json', { create: true })).createWritable();
    await writer.write(JSON.stringify([{ ...photo, originalUrl: 'images/original.png' }])); await writer.close();
  }, record(original));
  await page.reload();
  // Reloading folder photos creates new Blob URLs and replaces the service cache.
  // Observe the UI so polling cannot interrupt the backfill being tested.
  await expect.poll(() => page.locator('main img').evaluate(image => image.naturalWidth)).toBe(640);
  const disk = await page.evaluate(async () => {
    const archive = await (await navigator.storage.getDirectory()).getDirectoryHandle('thumbnail-archive');
    const [photo] = JSON.parse(await (await (await archive.getFileHandle('ancestry_db.json')).getFile()).text());
    const images = await archive.getDirectoryHandle('images');
    const preview = await (await images.getFileHandle(photo.thumbnailUrl.split('/').pop())).getFile();
    const original = await (await images.getFileHandle('original.png')).getFile();
    return { photo, thumbnailSize: preview.size, originalSize: original.size };
  });
  expect(disk.photo.thumbnailUrl).toMatch(/^images\/.+_thumbnail\.webp$/);
  expect(disk.photo.originalUrl).toBe('images/original.png');
  expect(disk.photo.people).toEqual(['Anna']);
  expect(disk.photo.tags).toEqual(['family']);
  expect(disk.thumbnailSize).toBeLessThan(disk.originalSize / 2);
  await page.reload();
  await expect(page.locator('main img')).toHaveAttribute('src', /^blob:/);
  expect(await page.locator('main img').evaluate(async element => { await element.decode(); return element.naturalWidth; })).toBe(640);
});

test('failed thumbnail generation does not lose the photo and broken previews fall back to originals', async ({ page }) => {
  await page.goto('/');
  const original = await image(page);
  const result = await page.evaluate(async ({ photo, original }) => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.savePhoto({ ...photo, id: 'invalid', originalUrl: 'data:image/png;base64,invalid' });
    const { BrowserPhotoStorage } = await import('/services/browserPhotoStorage.ts');
    await new BrowserPhotoStorage().savePhoto({ ...photo, originalUrl: original, thumbnailUrl: 'data:image/webp;base64,invalid', thumbnailSource: 'original' });
    return (await storageService.loadPhotos()).find(item => item.id === 'invalid');
  }, { photo: record(original), original });
  expect(result.id).toBe('invalid');
  expect(result.thumbnailUrl).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('img', { name: 'Thumbnail test', exact: true }).last()).toHaveAttribute('src', original);
});

test('thumbnail generation preserves small image dimensions without upscaling', async ({ page }) => {
  await page.goto('/');
  const original = await image(page, '#c08040', 100, 200);
  const thumbnail = await page.evaluate(async source => (await import('/utils/thumbnails.ts')).createThumbnail(source), original);
  expect(await dimensions(page, thumbnail)).toEqual([100, 200]);
});
