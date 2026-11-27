import { test, expect } from '@playwright/test';
import UTIF from 'utif2';

const metadata = {
  id: 'replace-photo', fileName: 'family-scan.png', uploadDate: 123456,
  description: 'Family in the garden', location: 'Bratislava', dateOfPhoto: '1976-08',
  people: ['Anna', 'Peter'], tags: ['family', 'garden'],
  faceTags: [{ id: 'anna-face', name: 'Anna', x: 32, y: 45 }], isRestoring: false,
};

const details = photo => {
  const { originalUrl, originalRevision, restoredUrl, thumbnailUrl, thumbnailSource, similarityIndex, ...fields } = photo;
  return fields;
};

async function seed(page, folder = false, enhanced = true) {
  await page.goto('/');
  const images = await page.evaluate(async ({ metadata, folder, enhanced }) => {
    const { storageService } = await import('/services/storageService.ts');
    if (folder) {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('replace-original-archive', { create: true });
      window.showDirectoryPicker = async () => archive;
      storageService.saveSettings({ language: 'en', storageType: 'filesystem' });
      if (!await storageService.connectFileSystem()) throw new Error('Test archive unavailable');
    }
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    const context = canvas.getContext('2d');
    const image = color => { context.fillStyle = color; context.fillRect(0, 0, 80, 60); return canvas.toDataURL(); };
    const original = image('#a02020'), restored = image('#208020'), replacement = image('#2040d0');
    await storageService.savePhoto({ ...metadata, originalUrl: original, ...(enhanced ? { restoredUrl: restored } : {}) });
    await storageService.saveFamilyTree({
      rootId: 'anna', people: [{ id: 'anna', name: 'Anna', avatarPhotoId: metadata.id }], families: [],
    });
    return { original, restored, replacement };
  }, { metadata, folder, enhanced });
  await page.reload();
  await page.getByRole('img', { name: metadata.description, exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  return { editor: page.getByRole('dialog', { name: 'Photo Details', exact: true }), ...images };
}

async function stored(page) {
  return page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    if (storageService.getSettings().storageType === 'filesystem') await storageService.restoreFileSystem();
    const photo = (await storageService.loadPhotos())[0];
    const tree = await storageService.loadFamilyTree();
    const toDataUrl = async source => {
      if (source?.startsWith('blob:')) {
        const blob = await (await fetch(source)).blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
        });
      }
      return source;
    };
    return { ...photo, originalUrl: await toDataUrl(photo.originalUrl), restoredUrl: await toDataUrl(photo.restoredUrl),
      thumbnailUrl: await toDataUrl(photo.thumbnailUrl), avatarPhotoId: tree.people[0].avatarPhotoId };
  });
}

const payload = dataUrl => ({ name: 'better-scan.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
async function replace(page, editor, file) {
  page.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles(file);
}

for (const folder of [false, true]) {
  test(`replacement keeps all metadata and family links after reload (${folder ? 'folder' : 'browser'})`, async ({ page }, testInfo) => {
    const { editor, replacement } = await seed(page, folder);
    if (!folder) {
      await editor.getByRole('button', { name: 'Replace original', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('replace-original-desktop.png') });
    }
    // A recent edit must survive even if it was still queued when replacement began.
    const description = 'Latest description before replacement';
    await editor.locator('textarea').fill(description);
    await replace(page, editor, payload(replacement));
    await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
    await expect(editor.getByRole('img', { name: 'Main view' })).toHaveAttribute('src', replacement);
    await expect(editor.getByRole('button', { name: 'Restore & Colorize', exact: true })).toBeEnabled();
    await expect(editor.getByTitle('Toggle Original/Restored')).toHaveCount(0);
    await page.reload();
    const saved = await stored(page);
    const { avatarPhotoId, ...photo } = saved;
    expect(details(photo)).toEqual({ ...metadata, description });
    expect(avatarPhotoId).toBe(metadata.id);
    expect(photo.originalUrl).toBe(replacement);
    expect(photo.restoredUrl).toBeUndefined();
    expect(photo.thumbnailSource).toBe('original');
    expect(photo.thumbnailUrl).toBeTruthy();
  });
}

test('cancelling replacement keeps the original, enhancement, and metadata', async ({ page }) => {
  const { editor } = await seed(page);
  const before = await stored(page);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain(metadata.fileName);
    expect(dialog.message()).toContain('people and face tags');
    await dialog.dismiss();
  });
  // Exercise the visible action as well as the underlying file input.
  const chooserPromise = page.waitForEvent('filechooser');
  await editor.getByRole('button', { name: 'Replace original', exact: true }).click();
  await (await chooserPromise).setFiles(payload(before.originalUrl));
  expect(await stored(page)).toEqual(before);
  await expect(editor.getByRole('button', { name: 'Re-Restore', exact: true })).toBeEnabled();
});

test('invalid images and failed browser saves leave the old photo intact and allow retry', async ({ page }) => {
  const { editor, replacement } = await seed(page);
  const before = await stored(page);
  await replace(page, editor, { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(editor.getByRole('alert')).toContainText('Your photo and metadata are unchanged');
  expect(await stored(page)).toEqual(before);
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
  });
  await replace(page, editor, payload(replacement));
  await expect(editor.getByRole('button', { name: 'Replace original', exact: true })).toBeEnabled();
  expect(await stored(page)).toEqual(before);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  await replace(page, editor, payload(replacement));
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
});

test('failed folder commit preserves original bytes, preview, AI version, and metadata', async ({ page }) => {
  const { editor, replacement } = await seed(page, true);
  const before = await stored(page);
  await page.evaluate(() => {
    window.originalCreateWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (this.name === 'ancestry_db.json') throw new DOMException('Denied', 'NotAllowedError');
      return window.originalCreateWritable.apply(this, args);
    };
  });
  await replace(page, editor, payload(replacement));
  await expect(editor.getByRole('alert')).toContainText('Your photo and metadata are unchanged');
  const after = await stored(page);
  expect(after).toEqual(before);
  await page.evaluate(() => { FileSystemFileHandle.prototype.createWritable = window.originalCreateWritable; });
  await replace(page, editor, payload(replacement));
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
});

test('replacement supports TIFF and a photo with no AI version', async ({ page }) => {
  const { editor } = await seed(page, false, false);
  const width = 20, height = 10;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  const buffer = Buffer.from(UTIF.encodeImage(rgba, width, height));
  await replace(page, editor, { name: 'new-scan.tif', mimeType: 'image/tiff', buffer });
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
  const { avatarPhotoId, ...saved } = await stored(page);
  expect(details(saved)).toEqual(metadata);
  expect(saved.originalUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(saved.restoredUrl).toBeUndefined();
});

test('replacement locks editing and navigation while saving, and refreshes an original-only thumbnail', async ({ page }) => {
  const { editor, replacement } = await seed(page, true, false);
  const before = await stored(page);
  await page.evaluate(() => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (this.name === 'ancestry_db.json') return new Promise(resolve => {
        window.releaseReplacement = () => {
          FileSystemFileHandle.prototype.createWritable = create;
          return create.apply(this, args).then(resolve);
        };
      });
      return create.apply(this, args);
    };
  });
  await replace(page, editor, payload(replacement));
  await page.waitForFunction(() => Boolean(window.releaseReplacement));
  await expect(editor.getByRole('button', { name: 'Replacing original…', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Next photo', exact: true })).toBeDisabled();
  await expect(editor.locator('textarea')).toBeDisabled();
  await page.evaluate(() => window.releaseReplacement());
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
  const saved = await stored(page);
  expect(saved.thumbnailUrl).not.toBe(before.thumbnailUrl);
  expect(saved.thumbnailSource).toBe('original');
});

test('analysis from the old image cannot change metadata after replacement', async ({ page }) => {
  const { editor, replacement } = await seed(page);
  let request;
  await page.route('https://generativelanguage.googleapis.com/**', route => { request = route; });
  await editor.getByRole('button', { name: 'Auto-Analyze', exact: true }).click();
  await expect.poll(() => Boolean(request)).toBe(true);
  await expect(editor.getByRole('button', { name: 'Replace original', exact: true })).toBeDisabled();
  // Returning to the editor remounts it while the previous analysis is pending.
  await editor.getByRole('button', { name: 'View mode', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance / Edit', exact: true }).click();
  await replace(page, editor, payload(replacement));
  await expect(editor.getByRole('status').filter({ hasText: 'Original replaced' })).toBeVisible();
  await request.fulfill({ contentType: 'application/json', body: JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ description: 'Stale analysis', location: 'Old place', tags: ['stale'] }) }] } }],
  }) });
  await page.unrouteAll({ behavior: 'wait' });
  const { avatarPhotoId, ...saved } = await stored(page);
  expect(details(saved)).toEqual(metadata);
  await expect(editor.locator('textarea')).toHaveValue(metadata.description);
});

test('Slovak replacement action works on mobile', async ({ page }, testInfo) => {
  const { replacement } = await seed(page);
  await page.evaluate(async () => {
    const { storageService } = await import('/services/storageService.ts');
    storageService.saveSettings({ ...storageService.getSettings(), language: 'sk' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('img', { name: metadata.description, exact: true }).click();
  await page.getByRole('button', { name: 'Vylepšiť / Upraviť', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Detaily fotky', exact: true });
  await editor.getByRole('button', { name: 'Nahradiť originál', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('replace-original-mobile.png') });
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Všetky údaje');
    await dialog.accept();
  });
  await editor.locator('input[type=file]').setInputFiles(payload(replacement));
  await expect(editor.getByRole('status').filter({ hasText: 'Originál bol nahradený' })).toBeVisible();
  expect((await stored(page)).originalUrl).toBe(replacement);
});
